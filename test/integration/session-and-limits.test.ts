import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, bearer, closeApp, createUser, getApp, prisma, refreshCookieFrom, resetDb } from "./helpers";
import { createRateLimiter } from "../../src/utils/rate-limit";
import { resumeStalledDeliveries } from "../../src/services/notification.service";
import { applySubscriptionSnapshot } from "../../src/services/polar/subscription-sync.service";

beforeEach(resetDb);
afterAll(closeApp);

describe("shared rate limiter", () => {
  it("allows up to the cap, then reports a wait — across limiter instances", async () => {
    // Two instances with one name stand in for two servers.
    const serverA = createRateLimiter("test-shared", [{ ms: 60_000, max: 2 }]);
    const serverB = createRateLimiter("test-shared", [{ ms: 60_000, max: 2 }]);
    expect((await serverA.take(["k"])).ok).toBe(true);
    expect((await serverB.take(["k"])).ok).toBe(true);
    const third = await serverA.take(["k"]);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retryAfterSeconds).toBeGreaterThan(0);
    expect((await serverA.take(["other"])).ok).toBe(true);
    await serverB.reset("k");
    expect((await serverA.take(["k"])).ok).toBe(true);
  });

  it("never lets concurrent requests past the cap", async () => {
    const limiter = createRateLimiter("test-race", [{ ms: 60_000, max: 3 }]);
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.take(["k"])));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });
});

async function login(email: string) {
  const app = await getApp();
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return refreshCookieFrom(res)!;
}

async function refresh(cookie: string, headers: Record<string, string> = {}) {
  const app = await getApp();
  return app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { refreshToken: cookie }, headers });
}

// Moves every revocation out of the 30-second race window.
const ageRevocations = () =>
  prisma.refreshToken.updateMany({ where: { revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 60_000) } });

describe("sessions", () => {
  it("keeps the user signed in when a refresh response was lost", async () => {
    const user = await createUser();
    const first = await login(user.email);

    const rotated = await refresh(first);
    expect(rotated.statusCode).toBe(200);
    // The browser never stored the rotated cookie and retries with the old one later.
    await ageRevocations();

    const retry = await refresh(first);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.accessToken).toBeTruthy();
    const next = refreshCookieFrom(retry)!;
    expect(next).toBeTruthy();
    expect((await refresh(next)).statusCode).toBe(200);
  });

  it("ends every session when a rotated token is replayed after its replacement was used", async () => {
    const user = await createUser();
    const stolen = await login(user.email);
    const other = await login(user.email);

    const legit = refreshCookieFrom(await refresh(stolen))!;
    expect((await refresh(legit)).statusCode).toBe(200); // the replacement is used
    await ageRevocations();

    expect((await refresh(stolen)).statusCode).toBe(401);
    expect((await refresh(other)).statusCode).toBe(401);
  });

  it("a logged-out token is refused without signing out other devices", async () => {
    const app = await getApp();
    const user = await createUser();
    const laptop = await login(user.email);
    const phone = await login(user.email);

    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { refreshToken: laptop } });
    await ageRevocations();

    expect((await refresh(laptop)).statusCode).toBe(401);
    expect((await refresh(phone)).statusCode).toBe(200);
  });

  it("refuses refresh from an origin that isn't the frontend", async () => {
    const user = await createUser();
    const cookie = await login(user.email);
    const res = await refresh(cookie, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect((await refresh(cookie, { origin: "http://localhost:3002" })).statusCode).toBe(200);
  });
});

describe("announcement recovery", () => {
  it("resumes a delivery whose server stopped, without emailing anyone twice", async () => {
    const a = await createUser({ email: "a@example.com" });
    const b = await createUser({ email: "b@example.com" });
    const notification = await prisma.notification.create({
      data: {
        title: "Hello",
        body: "Body",
        audience: { type: "all" },
        channels: ["in_app", "email"],
        status: "sending",
        recipientCount: 2,
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    await prisma.userNotification.createMany({ data: [a, b].map((u) => ({ notificationId: notification.id, userId: u.id })) });
    // "a" was emailed before the restart.
    await prisma.emailLog.create({
      data: { userId: a.id, toEmail: a.email, kind: "announcement", subject: "Hello", provider: "console", status: "skipped", notificationId: notification.id },
    });

    await resumeStalledDeliveries();

    let row = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    for (let i = 0; i < 40 && row.status === "sending"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      row = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    }
    expect(row.status).toBe("done");
    expect(row.leaseUntil).toBeNull();
    const logs = await prisma.emailLog.findMany({ where: { notificationId: notification.id } });
    expect(logs.map((l) => l.toEmail).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("leaves a delivery alone while its lease is live", async () => {
    await createUser();
    const notification = await prisma.notification.create({
      data: { title: "x", body: "y", audience: { type: "all" }, channels: ["email"], status: "sending", leaseUntil: new Date(Date.now() + 60_000) },
    });
    await resumeStalledDeliveries();
    expect(await prisma.emailLog.count({ where: { notificationId: notification.id } })).toBe(0);
  });
});

describe("polar subscription sync", () => {
  it("records Polar as the provider, so account deletion is guarded", async () => {
    const app = await getApp();
    const user = await createUser({ email: "payer@example.com" });
    await applySubscriptionSnapshot({
      id: "sub_x",
      customer_id: "cus_x",
      product_id: "prod_x",
      status: "active",
      current_period_end: new Date(Date.now() + 86400e3).toISOString(),
      cancel_at_period_end: false,
      customer: { email: "payer@example.com" },
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionProvider).toBe("POLAR");

    const del = await app.inject({ method: "DELETE", url: "/api/v1/auth/me", headers: bearer(user.id), payload: { password: PASSWORD } });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("ACTIVE_SUBSCRIPTION");
  });
});
