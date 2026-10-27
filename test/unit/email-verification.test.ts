import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for the two tables the code flow touches, so the
// rules (expiry, attempt limit, single use) are tested without a database.
type Row = { id: string; userId: string; tokenHash: string; expiresAt: Date; attempts: number; createdAt: Date };
type UserRow = { id: string; email: string; emailVerifiedAt: Date | null };

const db = vi.hoisted(() => ({ users: [] as UserRow[], tokens: [] as Row[], seq: 0 }));

vi.mock("../../src/db/client", () => {
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, cond]) => {
      const value = row[key as keyof Row];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { gt?: Date; lt?: number };
        if (c.gt !== undefined && !(value > c.gt)) return false;
        if (c.lt !== undefined && !((value as number) < c.lt)) return false;
        return true;
      }
      return value === cond;
    });
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
        db.users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const user = db.users.find((u) => u.id === where.id)!;
        Object.assign(user, data);
        return user;
      },
    },
    emailVerificationToken: {
      // Copies, as Prisma returns: later writes mustn't change a row already read.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = [...db.tokens].reverse().find((t) => matches(t, where));
        return row ? { ...row } : null;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const row = db.tokens.find((t) => t.tokenHash === where.tokenHash);
        return row ? { ...row } : null;
      },
      create: async ({ data }: { data: Omit<Row, "id" | "attempts" | "createdAt"> }) => {
        const row = { ...data, id: `t${++db.seq}`, attempts: 0, createdAt: new Date(Date.now() + db.seq) };
        db.tokens.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = db.tokens.length;
        db.tokens = db.tokens.filter((t) => !matches(t, where));
        return { count: before - db.tokens.length };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { attempts: { increment: number } } }) => {
        const hit = db.tokens.filter((t) => matches(t, where));
        hit.forEach((t) => (t.attempts += data.attempts.increment));
        return { count: hit.length };
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { prisma };
});

vi.mock("../../src/services/email/send", () => ({ sendEmailOrThrow: vi.fn() }));

const { createVerificationCode, verifyEmailCode, MAX_CODE_ATTEMPTS, normalizeCode } = await import(
  "../../src/services/emailVerification.service"
);
const { verificationCodeEmail } = await import("../../src/services/email/templates");

const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

describe("email verification codes", () => {
  beforeEach(() => {
    db.users = [{ id: "u1", email: "jo@example.com", emailVerifiedAt: null }];
    db.tokens = [];
  });

  it("issues a 6-digit code, stored only as a hash", async () => {
    const code = await createVerificationCode("u1");
    expect(code).toMatch(/^\d{6}$/);
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0].tokenHash).not.toContain(code);
  });

  it("confirms the email with the right code, once", async () => {
    const code = await createVerificationCode("u1");
    const result = await verifyEmailCode("jo@example.com", code);
    expect(result.ok).toBe(true);
    expect(db.users[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(db.tokens).toHaveLength(0);
    expect((await verifyEmailCode("jo@example.com", code)).ok).toBe(false);
  });

  it("accepts a code pasted with spaces or dashes", async () => {
    const code = await createVerificationCode("u1");
    expect(normalizeCode(`${code.slice(0, 3)} - ${code.slice(3)}`)).toBe(code);
    expect((await verifyEmailCode("jo@example.com", `${code.slice(0, 3)} ${code.slice(3)}`)).ok).toBe(true);
  });

  it("counts wrong codes down, then refuses even the right one", async () => {
    const code = await createVerificationCode("u1");
    for (let left = MAX_CODE_ATTEMPTS - 1; left > 0; left--) {
      expect(await verifyEmailCode("jo@example.com", wrong(code))).toEqual({ ok: false, reason: "invalid", attemptsLeft: left });
    }
    expect(await verifyEmailCode("jo@example.com", wrong(code))).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(await verifyEmailCode("jo@example.com", code)).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(db.users[0].emailVerifiedAt).toBeNull();
  });

  it("refuses an expired code", async () => {
    const code = await createVerificationCode("u1");
    db.tokens[0].expiresAt = new Date(Date.now() - 1000);
    expect(await verifyEmailCode("jo@example.com", code)).toEqual({ ok: false, reason: "expired" });
  });

  it("makes a new code replace the old one", async () => {
    const first = await createVerificationCode("u1");
    let second = await createVerificationCode("u1");
    while (second === first) second = await createVerificationCode("u1");
    expect(db.tokens).toHaveLength(1);
    expect((await verifyEmailCode("jo@example.com", first)).ok).toBe(false);
    expect((await verifyEmailCode("jo@example.com", second)).ok).toBe(true);
  });

  it("answers an unknown email like a wrong code", async () => {
    expect(await verifyEmailCode("nobody@example.com", "123456")).toEqual({
      ok: false,
      reason: "invalid",
      attemptsLeft: MAX_CODE_ATTEMPTS,
    });
  });
});

describe("verification email", () => {
  it("puts the code in the subject, the preview and the body, with no link", () => {
    const email = verificationCodeEmail("482913", 15);
    expect(email.subject).toBe("Your GoMoxie verification code: 482913");
    expect(email.text).toContain("Your GoMoxie verification code is 482913.");
    expect(email.html).toContain("Your verification code is 482913");
    expect(email.html).toContain("user-select:all");
    expect(email.html).not.toContain("href=");
    expect(email.text).toContain("15 minutes");
  });
});
