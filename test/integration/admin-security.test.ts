import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, bearer, closeApp, createUser, getApp, prisma, refreshCookieFrom, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(closeApp);

describe("admin authorization", () => {
  it("rejects anonymous callers and ordinary users on every admin endpoint", async () => {
    const app = await getApp();
    const user = await createUser();
    const endpoints: [string, string][] = [
      ["GET", "/api/v1/admin/me"],
      ["GET", "/api/v1/admin/overview"],
      ["GET", "/api/v1/admin/users"],
      ["GET", `/api/v1/admin/users/${user.id}`],
      ["POST", `/api/v1/admin/users/${user.id}/suspend`],
      ["POST", `/api/v1/admin/users/${user.id}/entitlements`],
      ["GET", "/api/v1/admin/billing/summary"],
      ["PUT", "/api/v1/admin/settings/limits"],
      ["POST", "/api/v1/admin/notifications"],
      ["GET", "/api/v1/admin/audit"],
      ["GET", "/api/v1/admin/ai/usage"],
      ["DELETE", `/api/v1/admin/users/${user.id}`],
    ];
    for (const [method, url] of endpoints) {
      const anon = await app.inject({ method: method as "GET", url, payload: method === "GET" ? undefined : {} });
      expect(anon.statusCode, `${method} ${url} anonymous`).toBe(401);
      const asUser = await app.inject({ method: method as "GET", url, headers: bearer(user.id), payload: method === "GET" ? undefined : {} });
      expect(asUser.statusCode, `${method} ${url} as user`).toBe(403);
    }
  });

  it("lets an admin in", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/me", headers: bearer(admin.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ email: admin.email, role: "ADMIN" });
    expect(res.json().data.permissions).toContain("users:delete");
    const overview = await app.inject({ method: "GET", url: "/api/v1/admin/overview?days=30", headers: bearer(admin.id) });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.users.total).toBe(1);
  });

  it("an admin demoted in the database loses access immediately, even with a valid token", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const headers = bearer(admin.id);
    await prisma.user.update({ where: { id: admin.id }, data: { role: "USER" } });
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers });
    expect(res.statusCode).toBe(403);
  });

  it("an ordinary user can't make themselves an admin through the profile endpoint", async () => {
    const app = await getApp();
    const user = await createUser();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/me",
      headers: bearer(user.id),
      payload: { firstName: "Mallory", role: "ADMIN", status: "ACTIVE" },
    });
    expect(res.statusCode).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.role).toBe("USER");
    expect(after.firstName).toBe("Mallory");
  });
});

describe("admin login", () => {
  it("signs an admin in, issues a session and audits it", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN", email: "boss@example.com" });
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/auth/login", payload: { email: "Boss@Example.com", password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.accessToken).toBeTruthy();
    expect(refreshCookieFrom(res)).toBeTruthy();
    expect(await prisma.adminAuditLog.count({ where: { action: "admin.login", actorId: admin.id } })).toBe(1);
  });

  it("gives a non-admin with the right password the same answer as a wrong password", async () => {
    const app = await getApp();
    await createUser({ email: "normal@example.com" });
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/auth/login", payload: { email: "normal@example.com", password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    const wrong = await app.inject({ method: "POST", url: "/api/v1/admin/auth/login", payload: { email: "nobody@example.com", password: "nope-nope" } });
    expect(wrong.json().error).toEqual(res.json().error);
    expect(await prisma.adminAuditLog.count({ where: { action: "admin.login_failed" } })).toBe(2);
  });

  it("rate limits repeated admin sign-in attempts", async () => {
    const app = await getApp();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/auth/login",
        payload: { email: "brute@example.com", password: `guess-${i}` },
        remoteAddress: "10.9.9.9",
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("suspension", () => {
  it("blocks existing tokens, refresh and sign-in; reactivation restores access; both are audited", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser({ email: "suspendme@example.com" });

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const userHeaders = { authorization: `Bearer ${login.json().data.accessToken}` };
    const refreshCookie = refreshCookieFrom(login)!;

    const suspend = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/suspend`,
      headers: bearer(admin.id),
      payload: { reason: "Chargeback abuse" },
    });
    expect(suspend.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: userHeaders });
    expect(me.statusCode).toBe(403);
    expect(me.json().error.code).toBe("ACCOUNT_SUSPENDED");

    const cvList = await app.inject({ method: "GET", url: "/api/v1/cv", headers: userHeaders });
    expect(cvList.statusCode).toBe(403);

    const refresh = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { refreshToken: refreshCookie } });
    expect(refresh.statusCode).toBe(401);

    const relogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
    expect(relogin.statusCode).toBe(403);
    expect(relogin.json().error.code).toBe("ACCOUNT_SUSPENDED");

    // Data is kept.
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);

    const reactivate = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/reactivate`,
      headers: bearer(admin.id),
      payload: { reason: "Resolved with the customer" },
    });
    expect(reactivate.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
    expect(again.statusCode).toBe(200);

    const actions = (await prisma.adminAuditLog.findMany({ where: { targetId: user.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["user.suspend", "user.reactivate"]);
  });

  it("requires a reason, and refuses to suspend admins or yourself", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const other = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const noReason = await app.inject({ method: "POST", url: `/api/v1/admin/users/${user.id}/suspend`, headers: bearer(admin.id), payload: {} });
    expect(noReason.statusCode).toBe(400);
    const self = await app.inject({ method: "POST", url: `/api/v1/admin/users/${admin.id}/suspend`, headers: bearer(admin.id), payload: { reason: "test it" } });
    expect(self.statusCode).toBe(400);
    const otherAdmin = await app.inject({ method: "POST", url: `/api/v1/admin/users/${other.id}/suspend`, headers: bearer(admin.id), payload: { reason: "test it" } });
    expect(otherAdmin.statusCode).toBe(400);
  });
});

describe("account deletion", () => {
  it("needs the exact email typed back, deletes the account and audits it", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser({ email: "leaving@example.com" });
    await prisma.cVDocument.create({ data: { userId: user.id, content: {} } });

    const mismatch = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${user.id}`,
      headers: bearer(admin.id),
      payload: { confirmEmail: "wrong@example.com", reason: "GDPR request" },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);

    const ok = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${user.id}`,
      headers: bearer(admin.id),
      payload: { confirmEmail: "LEAVING@example.com", reason: "GDPR request" },
    });
    expect(ok.statusCode).toBe(200);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    expect(await prisma.cVDocument.count({ where: { userId: user.id } })).toBe(0);
    const entry = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "user.delete", targetId: user.id } });
    expect(entry.metadata).toMatchObject({ email: "leaving@example.com", deleted: { cvCount: 1 } });
  });

  it("refuses while a Polar subscription will still renew", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { subscriptionProvider: "POLAR", subscriptionStatus: "active", subscriptionCancelAtPeriodEnd: false, polarSubscriptionId: "sub_1" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${user.id}`,
      headers: bearer(admin.id),
      payload: { confirmEmail: user.email, reason: "test" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ACTIVE_SUBSCRIPTION");
  });
});
