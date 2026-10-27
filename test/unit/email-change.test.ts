import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins for the tables the email-change flow touches, so its
// rules are tested without a database.
type UserRow = { id: string; email: string; emailVerifiedAt: Date | null; googleId: string | null };
type RequestRow = {
  id: string;
  userId: string;
  newEmail: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
};

const db = vi.hoisted(() => ({ users: [] as UserRow[], requests: [] as RequestRow[], sent: [] as { to: string; subject: string }[] }));

vi.mock("../../src/db/client", () => {
  const matches = (row: RequestRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, cond]) => {
      const value = row[key as keyof RequestRow];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { gt?: Date; lt?: number };
        if (c.gt !== undefined && !(value > c.gt)) return false;
        if (c.lt !== undefined && !((value as number) < c.lt)) return false;
        return true;
      }
      return value === cond;
    });
  const findUser = (where: { email?: string; id?: string }) =>
    db.users.find((u) => (where.email ? u.email === where.email : u.id === where.id));
  return {
    prisma: {
      user: {
        // Copies, as Prisma returns: later writes mustn't change a row already read.
        findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
          const u = findUser(where);
          return u ? { ...u } : null;
        },
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...findUser(where)! }),
        update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
          const u = findUser(where)!;
          Object.assign(u, data);
          return { ...u };
        },
      },
      emailChangeRequest: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
          const r = db.requests.find((x) => x.userId === where.userId);
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: { userId: string }; create: RequestRow; update: Partial<RequestRow> }) => {
          const existing = db.requests.find((x) => x.userId === where.userId);
          if (existing) Object.assign(existing, update);
          else db.requests.push({ ...create, id: `r${db.requests.length + 1}`, createdAt: new Date() } as RequestRow);
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { attempts: { increment: number } } }) => {
          const hit = db.requests.filter((r) => matches(r, where));
          hit.forEach((r) => (r.attempts += data.attempts.increment));
          return { count: hit.length };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const before = db.requests.length;
          db.requests = db.requests.filter((r) => !matches(r, where));
          return { count: before - db.requests.length };
        },
      },
    },
  };
});

vi.mock("../../src/services/accountDeletion.service", () => ({
  deleteUserAccount: async (id: string) => {
    db.users = db.users.filter((u) => u.id !== id);
  },
}));

const capture = async ({ to, subject }: { to: string; subject: string }) => {
  db.sent.push({ to, subject });
  return { status: "sent", id: null };
};
vi.mock("../../src/services/email/send", () => ({ sendEmail: capture, sendEmailOrThrow: capture }));

const { startEmailChange, confirmEmailChange, pendingEmailChange, cancelEmailChange, MAX_EMAIL_CHANGE_ATTEMPTS, EmailChangeError } =
  await import("../../src/services/emailChange.service");

const me = { id: "u1", email: "jo@old.com" };
/** The code from the last email sent to `to` (its subject ends with it). */
const codeSentTo = (to: string) => db.sent.filter((m) => m.to === to).at(-1)!.subject.slice(-6);

describe("changing the account email", () => {
  beforeEach(() => {
    db.users = [{ id: "u1", email: "jo@old.com", emailVerifiedAt: new Date("2026-01-01"), googleId: null }];
    db.requests = [];
    db.sent = [];
  });

  it("emails a code to the new address and changes nothing until it's entered", async () => {
    await startEmailChange(me, "jo@new.com");
    expect(db.sent).toEqual([{ to: "jo@new.com", subject: expect.stringMatching(/verification code: \d{6}$/) }]);
    expect(db.users[0].email).toBe("jo@old.com");
    expect(await pendingEmailChange("u1")).toBe("jo@new.com");
  });

  it("moves the account to the new address with the right code, and tells the old one", async () => {
    await startEmailChange(me, "jo@new.com");
    const result = await confirmEmailChange("u1", codeSentTo("jo@new.com"));
    expect(result.ok).toBe(true);
    expect(db.users[0].email).toBe("jo@new.com");
    expect(db.requests).toHaveLength(0);
    expect(db.sent.at(-1)).toEqual({ to: "jo@old.com", subject: "Your GoMoxie email was changed" });
  });

  it("counts wrong codes down, then refuses even the right one", async () => {
    await startEmailChange(me, "jo@new.com");
    const code = codeSentTo("jo@new.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let left = MAX_EMAIL_CHANGE_ATTEMPTS - 1; left > 0; left--) {
      expect(await confirmEmailChange("u1", wrong)).toEqual({ ok: false, reason: "invalid", attemptsLeft: left });
    }
    expect(await confirmEmailChange("u1", wrong)).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(await confirmEmailChange("u1", code)).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(db.users[0].email).toBe("jo@old.com");
  });

  it("refuses an expired code", async () => {
    await startEmailChange(me, "jo@new.com");
    db.requests[0].expiresAt = new Date(Date.now() - 1000);
    expect(await confirmEmailChange("u1", codeSentTo("jo@new.com"))).toEqual({ ok: false, reason: "expired" });
  });

  it("only accepts the code for the address it was sent to", async () => {
    await startEmailChange(me, "jo@first.com");
    const firstCode = codeSentTo("jo@first.com");
    await startEmailChange(me, "jo@second.com");
    expect((await confirmEmailChange("u1", firstCode)).ok).toBe(codeSentTo("jo@second.com") === firstCode);
    expect(db.users[0].email).not.toBe("jo@first.com");
  });

  it("refuses the current email and one another account owns", async () => {
    db.users.push({ id: "u2", email: "taken@x.com", emailVerifiedAt: new Date(), googleId: null });
    await expect(startEmailChange(me, "JO@old.com")).rejects.toBeInstanceOf(EmailChangeError);
    await expect(startEmailChange(me, "taken@x.com")).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
    expect(db.sent).toHaveLength(0);
  });

  it("refuses at confirmation if someone else claimed the address meanwhile", async () => {
    await startEmailChange(me, "jo@new.com");
    db.users.push({ id: "u2", email: "jo@new.com", emailVerifiedAt: new Date(), googleId: null });
    expect(await confirmEmailChange("u1", codeSentTo("jo@new.com"))).toEqual({ ok: false, reason: "taken" });
    expect(db.users.find((u) => u.id === "u1")!.email).toBe("jo@old.com");
  });

  it("lets an unconfirmed sign-up holding the address give way", async () => {
    db.users.push({ id: "u3", email: "jo@new.com", emailVerifiedAt: null, googleId: null });
    await startEmailChange(me, "jo@new.com");
    expect((await confirmEmailChange("u1", codeSentTo("jo@new.com"))).ok).toBe(true);
    expect(db.users.map((u) => u.id)).toEqual(["u1"]);
  });

  it("can be cancelled", async () => {
    await startEmailChange(me, "jo@new.com");
    await cancelEmailChange("u1");
    expect(await pendingEmailChange("u1")).toBeNull();
    expect(await confirmEmailChange("u1", codeSentTo("jo@new.com"))).toEqual({ ok: false, reason: "no_request" });
  });
});
