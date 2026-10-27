import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PASSWORD, bearer, closeApp, createUser, getApp, prisma, resetDb } from "./helpers";
import { createPasswordResetToken } from "../../src/services/passwordReset.service";
import { comparePassword } from "../../src/services/auth.service";

beforeEach(resetDb);
afterAll(closeApp);

describe("notifications", () => {
  it("delivers an in-app message to one user, who can read and dismiss it", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const bystander = await createUser();

    const send = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notifications",
      headers: bearer(admin.id),
      payload: {
        title: "Your Pro trial",
        body: "Enjoy a week of Pro on us.",
        actionUrl: "/dashboard",
        audience: { type: "users", userIds: [user.id] },
        channels: ["in_app"],
      },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().data.recipientCount).toBe(1);

    const list = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: bearer(user.id) });
    expect(list.json().data.unreadCount).toBe(1);
    const item = list.json().data.items[0];
    expect(item).toMatchObject({ title: "Your Pro trial", actionUrl: "/dashboard", readAt: null });

    const other = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: bearer(bystander.id) });
    expect(other.json().data.items).toHaveLength(0);
    // A user can't touch someone else's notification.
    const steal = await app.inject({ method: "POST", url: `/api/v1/notifications/${item.id}/dismiss`, headers: bearer(bystander.id) });
    expect(steal.json().data.updated).toBe(0);

    await app.inject({ method: "POST", url: `/api/v1/notifications/${item.id}/read`, headers: bearer(user.id) });
    expect((await app.inject({ method: "GET", url: "/api/v1/notifications", headers: bearer(user.id) })).json().data.unreadCount).toBe(0);
    await app.inject({ method: "POST", url: `/api/v1/notifications/${item.id}/dismiss`, headers: bearer(user.id) });
    expect((await app.inject({ method: "GET", url: "/api/v1/notifications", headers: bearer(user.id) })).json().data.items).toHaveLength(0);

    expect(await prisma.adminAuditLog.count({ where: { action: "notification.create" } })).toBe(1);
  });

  it("emails only verified users who haven't opted out, and records each outcome", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    await createUser({ email: "a@example.com" });
    await createUser({ email: "b@example.com", verified: false });
    const optedOut = await createUser({ email: "c@example.com" });
    await prisma.user.update({ where: { id: optedOut.id }, data: { emailAnnouncementsOptOut: true } });

    const count = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notifications/audience",
      headers: bearer(admin.id),
      payload: { audience: { type: "free" } },
    });
    expect(count.json().data).toEqual({ total: 4, emailableProduct: 2, emailableService: 3 });

    const send = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notifications",
      headers: bearer(admin.id),
      payload: { title: "New templates", body: "Three new templates are live.", audience: { type: "free" }, channels: ["in_app", "email"] },
    });
    expect(send.statusCode).toBe(201);
    const id = send.json().data.id;

    // Delivery runs in the background — wait for it to finish.
    let row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && row.status === "sending"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    }
    expect(row.status).toBe("done");
    // Console provider in tests: "skipped" (logged, not delivered) — never reported as sent.
    const logs = await prisma.emailLog.findMany({ where: { notificationId: id } });
    expect(logs.map((l) => l.toEmail).sort()).toEqual([admin.email, "a@example.com"].sort());
    expect(logs.every((l) => l.status === "skipped")).toBe(true);
    expect(row.emailSent).toBe(0);
  });

  it("rejects unsafe action links", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/notifications",
      headers: bearer(admin.id),
      payload: { title: "x", body: "y", actionUrl: "javascript:alert(1)", audience: { type: "all" }, channels: ["in_app"] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("settings", () => {
  it("validates values, records before/after, and closing registration blocks sign-up", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });

    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings/limits",
      headers: bearer(admin.id),
      payload: { value: { aiRequestsPerMinute: 0, aiRequestsPerDay: 150 } },
    });
    expect(bad.statusCode).toBe(400);

    const unknown = await app.inject({ method: "PUT", url: "/api/v1/admin/settings/shell", headers: bearer(admin.id), payload: { value: "rm -rf /" } });
    expect(unknown.statusCode).toBe(404);

    const close = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings/platform",
      headers: bearer(admin.id),
      payload: { value: { registrationEnabled: false, aiGenerationPaused: false, banner: { enabled: false, message: "", tone: "info" } }, reason: "Spam wave" },
    });
    expect(close.statusCode).toBe(200);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "settings.update.platform" } });
    expect(audit.metadata).toMatchObject({ before: { registrationEnabled: true }, after: { registrationEnabled: false } });

    const signup = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "new@example.com", password: "long-enough-1" } });
    expect(signup.statusCode).toBe(403);
    expect(signup.json().error.code).toBe("REGISTRATION_CLOSED");
  });

  it("health reports configuration without exposing secrets", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/health", headers: bearer(admin.id) });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    for (const secret of ["test-access-secret-not-for-production", "test-polar-token", "test-groq-key", "test-chapa"]) {
      expect(body).not.toContain(secret);
    }
    expect(res.json().data.database.ok).toBe(true);
  });
});

describe("password reset", () => {
  it("an admin can send a reset link but never sees the password; the link works once", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser({ email: "forgetful@example.com" });

    const send = await app.inject({ method: "POST", url: `/api/v1/admin/users/${user.id}/password-reset`, headers: bearer(admin.id), payload: {} });
    expect(send.statusCode).toBe(200);
    expect(JSON.stringify(send.json())).not.toMatch(/token/i);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id, requestedById: admin.id } })).toBe(1);
    expect(await prisma.emailLog.count({ where: { userId: user.id, kind: "password_reset" } })).toBe(1);

    const token = await createPasswordResetToken(user.id);
    const reset = await app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token, password: "brand-new-password-9" } });
    expect(reset.statusCode).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await comparePassword("brand-new-password-9", row.passwordHash!)).toBe(true);
    expect(await comparePassword(PASSWORD, row.passwordHash!)).toBe(false);

    const reuse = await app.inject({ method: "POST", url: "/api/v1/auth/reset-password", payload: { token, password: "another-password-9" } });
    expect(reuse.statusCode).toBe(400);
  });

  it("forgot-password answers the same for unknown emails", async () => {
    const app = await getApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "ghost@example.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ sent: true });
  });
});

describe("admin bootstrap script", () => {
  const script = path.resolve(__dirname, "../../src/scripts/create-admin.ts");
  const tsx = path.resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [tsx, script, ...args], { env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });

  it("creates the first admin, and rerunning neither duplicates it nor changes its password", async () => {
    const first = run([], { ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "Sup3r-secret-pass!" });
    expect(first.status, first.stderr).toBe(0);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "owner@example.com" } });
    expect(admin.role).toBe("ADMIN");
    expect(admin.emailVerifiedAt).not.toBeNull();
    expect(admin.passwordHash).not.toContain("Sup3r");

    const again = run([], { ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "Different-pass-123!" });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already an admin");
    expect(await prisma.user.count({ where: { email: "owner@example.com" } })).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(after.passwordHash).toBe(admin.passwordHash);
  });

  it("won't silently promote an existing user, and rejects weak passwords", async () => {
    await createUser({ email: "regular@example.com" });
    const refused = run([], { ADMIN_EMAIL: "regular@example.com", ADMIN_PASSWORD: "Sup3r-secret-pass!" });
    expect(refused.status).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "regular@example.com" } })).role).toBe("USER");

    const weak = run([], { ADMIN_EMAIL: "weak@example.com", ADMIN_PASSWORD: "short" });
    expect(weak.status).toBe(1);
    expect(await prisma.user.count({ where: { email: "weak@example.com" } })).toBe(0);

    const promoted = run(["--promote"], { ADMIN_EMAIL: "regular@example.com" });
    expect(promoted.status, promoted.stderr).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "regular@example.com" } })).role).toBe("ADMIN");
  });
});
