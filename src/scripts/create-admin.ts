/**
 * Creates (or manages) GoMoxie administrator accounts. Server-side only — there
 * is deliberately no HTTP endpoint that creates admins or changes roles.
 *
 *   npm run admin:create                         create the first admin (prompts)
 *   npm run admin:create -- --email=a@b.com      skip the email prompt
 *   npm run admin:create -- --promote            make an EXISTING user an admin (password unchanged)
 *   npm run admin:create -- --reset-password     set a new password for an existing admin
 *   npm run admin:create -- --list               list admins
 *   npm run admin:create -- --demote --email=..  turn an admin back into a normal user
 *
 * The email can also come from ADMIN_EMAIL and the password from
 * ADMIN_PASSWORD (useful for a one-off CI/hosting shell — unset it after).
 * The password is never accepted as a command-line argument, so it can't
 * land in shell history. Safe to rerun: an existing admin is left untouched
 * unless --reset-password is given.
 */
import readline from "node:readline";
import { prisma } from "../db/client";
import { hashPassword } from "../services/auth.service";
import { revokeAllSessions } from "../services/session.service";
import { recordAudit } from "../services/audit.service";

const MIN_PASSWORD_LENGTH = 12;
const CLI_ACTOR = { id: null, email: "cli:create-admin" };

function arg(name: string): string | true | undefined {
  const prefix = `--${name}`;
  for (const a of process.argv.slice(2)) {
    if (a === prefix) return true;
    if (a.startsWith(`${prefix}=`)) return a.slice(prefix.length + 1);
  }
  return undefined;
}

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo "*" instead of the typed characters.
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        out.output.write(s);
        prompted = true;
      } else if (s.includes("\n") || s.includes("\r")) {
        out.output.write("\n");
      } else {
        out.output.write("*".repeat(Math.max(0, s.length > 1 ? 0 : 1)));
      }
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function validatePassword(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.toLowerCase().includes(email.split("@")[0].toLowerCase())) return "Don't include your email name in the password.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9\W_]/.test(password)) return "Mix letters with numbers or symbols.";
  return null;
}

async function readPassword(email: string): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) {
    const problem = validatePassword(fromEnv, email);
    if (problem) throw new Error(`ADMIN_PASSWORD is too weak: ${problem}`);
    return fromEnv;
  }
  if (!process.stdin.isTTY) throw new Error("No TTY for a password prompt — set ADMIN_PASSWORD for this one run instead.");
  for (;;) {
    const first = await ask(`Password (min ${MIN_PASSWORD_LENGTH} chars): `, true);
    const problem = validatePassword(first, email);
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    const second = await ask("Repeat password: ", true);
    if (first !== second) {
      console.log("  Passwords don't match, try again.");
      continue;
    }
    return first;
  }
}

async function readEmail(): Promise<string> {
  const value = arg("email");
  const email = (typeof value === "string" ? value : process.env.ADMIN_EMAIL ?? (await ask("Admin email: "))).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`"${email}" isn't a valid email address.`);
  return email;
}

async function list() {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { email: true, status: true, createdAt: true, lastLoginAt: true } });
  if (admins.length === 0) console.log("No admin accounts yet.");
  for (const a of admins) {
    console.log(`- ${a.email}  status=${a.status}  created=${a.createdAt.toISOString()}  lastLogin=${a.lastLoginAt?.toISOString() ?? "never"}`);
  }
}

async function main() {
  if (arg("list")) return list();

  const email = await readEmail();
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });

  if (arg("demote")) {
    if (!existing || existing.role !== "ADMIN") throw new Error(`${email} is not an admin.`);
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    if (admins <= 1) throw new Error("Refusing to demote the last admin.");
    await prisma.user.update({ where: { id: existing.id }, data: { role: "USER" } });
    await revokeAllSessions(existing.id);
    await recordAudit({ actor: CLI_ACTOR, action: "admin.demote", targetType: "user", targetId: existing.id, summary: email });
    console.log(`${email} is no longer an admin. Their sessions were signed out.`);
    return;
  }

  if (!existing) {
    const password = await readPassword(email);
    const now = new Date();
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        emailVerifiedAt: now,
        onboardingCompletedAt: now,
      },
    });
    await recordAudit({ actor: CLI_ACTOR, action: "admin.bootstrap", targetType: "user", targetId: user.id, summary: `Created admin ${email}` });
    console.log(`Admin account created for ${email}. Sign in at <FRONTEND_URL>/admin/login.`);
    return;
  }

  if (existing.role !== "ADMIN") {
    if (!arg("promote")) {
      throw new Error(
        `${email} already has a normal GoMoxie account. Rerun with --promote to make it an admin (its password stays the same), or use a different email.`
      );
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: "ADMIN", emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
    });
    await recordAudit({ actor: CLI_ACTOR, action: "admin.promote", targetType: "user", targetId: existing.id, summary: email });
    console.log(`${email} is now an admin.`);
    if (!existing.passwordHash) {
      console.log("This account has no password (Google sign-in only). Run again with --reset-password to set one for the admin login.");
    }
  } else if (!arg("reset-password")) {
    console.log(`${email} is already an admin. Nothing changed (pass --reset-password to set a new password).`);
    return;
  }

  if (arg("reset-password")) {
    const password = await readPassword(email);
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await hashPassword(password) } });
    await revokeAllSessions(existing.id);
    await recordAudit({ actor: CLI_ACTOR, action: "admin.password_reset_cli", targetType: "user", targetId: existing.id, summary: email });
    console.log(`Password updated for ${email}. Every existing session was signed out.`);
  }
}

main()
  .catch((err) => {
    console.error(`\nError: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
