import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeApp, createUser, getApp, prisma, resetDb } from "./helpers";
import { consumeGenerationOrThrow, ProRequiredError, refundGeneration } from "../../src/services/entitlement.service";

beforeEach(resetDb);
afterAll(closeApp);

async function status(userId: string) {
  const app = await getApp();
  const res = await app.inject({ method: "GET", url: "/api/v1/subscriptions/status", headers: bearer(userId) });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

describe("manual Pro grants", () => {
  it("grants temporary Pro without any payment record, and it expires on its own", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    expect((await status(user.id)).isPro).toBe(false);

    const grant = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/entitlements`,
      headers: bearer(admin.id),
      payload: { kind: "PRO_ACCESS", durationDays: 7, reason: "Beta tester thank-you", note: "Promised on Discord" },
    });
    expect(grant.statusCode).toBe(201);
    const grantId = grant.json().data.id;

    const s = await status(user.id);
    expect(s).toMatchObject({ isPro: true, proSource: "grant", subscriptionStatus: null, subscriptionProvider: null });
    expect(s.features.careerProfiles).toBe(true);

    // No fake billing: no Payment rows, subscription fields untouched.
    expect(await prisma.payment.count()).toBe(0);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.subscriptionStatus).toBeNull();

    // Time passes: the grant ends without anyone touching it.
    await prisma.entitlement.update({ where: { id: grantId }, data: { startsAt: new Date(Date.now() - 8 * 86400e3), expiresAt: new Date(Date.now() - 1000) } });
    expect((await status(user.id)).isPro).toBe(false);

    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "entitlement.grant", targetId: user.id } });
    expect(audit.actorId).toBe(admin.id);
  });

  it("extends and revokes a grant, auditing both", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/entitlements`,
      headers: bearer(admin.id),
      payload: { kind: "PRO_ACCESS", durationDays: 7, reason: "Promo" },
    });
    const { id, expiresAt } = created.json().data;

    const extended = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/entitlements/${id}`,
      headers: bearer(admin.id),
      payload: { extendDays: 30, reason: "Extended promo" },
    });
    expect(extended.statusCode).toBe(200);
    expect(new Date(extended.json().data.expiresAt).getTime() - new Date(expiresAt).getTime()).toBe(30 * 86400e3);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/admin/entitlements/${id}/revoke`,
      headers: bearer(admin.id),
      payload: { reason: "Abuse" },
    });
    expect(revoked.statusCode).toBe(200);
    expect((await status(user.id)).isPro).toBe(false);

    const actions = (await prisma.adminAuditLog.findMany({ where: { targetId: user.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["entitlement.grant", "entitlement.update", "entitlement.revoke"]);
  });

  it("rejects grants without a reason or with a past end date", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/entitlements`,
      headers: bearer(admin.id),
      payload: { kind: "PRO_ACCESS", durationDays: 7 },
    });
    expect(noReason.statusCode).toBe(400);
    const past = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/entitlements`,
      headers: bearer(admin.id),
      payload: { kind: "PRO_ACCESS", expiresAt: "2020-01-01T00:00:00Z", reason: "nope" },
    });
    expect(past.statusCode).toBe(400);
  });
});

describe("user search by plan", () => {
  it("separates free, paid and granted users — including never-subscribed users (NULL status)", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN", email: "admin@example.com" });
    const free = await createUser({ email: "free@example.com" });
    const paid = await createUser({ email: "paid@example.com" });
    const granted = await createUser({ email: "granted@example.com" });
    const lapsed = await createUser({ email: "lapsed@example.com" });
    await prisma.user.update({ where: { id: paid.id }, data: { subscriptionStatus: "active", subscriptionProvider: "CHAPA", subscriptionCurrentPeriodEnd: new Date(Date.now() + 86400e3) } });
    await prisma.user.update({ where: { id: lapsed.id }, data: { subscriptionStatus: "active", subscriptionProvider: "CHAPA", subscriptionCurrentPeriodEnd: new Date(Date.now() - 86400e3) } });
    await prisma.entitlement.create({ data: { userId: granted.id, kind: "PRO_ACCESS", reason: "comp", expiresAt: new Date(Date.now() + 86400e3) } });

    const emails = async (plan: string) =>
      ((await app.inject({ method: "GET", url: `/api/v1/admin/users?plan=${plan}&sort=email`, headers: bearer(admin.id) })).json().data.items as { email: string }[]).map(
        (u) => u.email
      );
    expect(await emails("free")).toEqual([admin.email, free.email, lapsed.email]);
    expect(await emails("paid")).toEqual([paid.email]);
    expect(await emails("grant")).toEqual([granted.email]);
    expect(await emails("pro")).toEqual([granted.email, paid.email]);

    const search = await app.inject({ method: "GET", url: `/api/v1/admin/users?q=${granted.id}`, headers: bearer(admin.id) });
    expect(search.json().data.items).toHaveLength(1);
    expect(search.json().data.items[0]).toMatchObject({ email: granted.email, isPro: true, proSource: "grant" });
  });
});

describe("feature gates on the backend", () => {
  it("a free user is refused career profiles until granted that one feature", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const before = await app.inject({ method: "POST", url: "/api/v1/profiles", headers: bearer(user.id), payload: { title: "Backend Engineer" } });
    expect(before.statusCode).toBe(402);
    expect(before.json().error.code).toBe("PRO_REQUIRED");

    await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/entitlements`,
      headers: bearer(admin.id),
      payload: { kind: "FEATURE", feature: "careerProfiles", durationDays: 30, reason: "Pilot" },
    });
    const after = await app.inject({ method: "POST", url: "/api/v1/profiles", headers: bearer(user.id), payload: { title: "Backend Engineer" } });
    expect(after.statusCode).toBe(201);
    const s = await status(user.id);
    expect(s.isPro).toBe(false);
    expect(s.features.careerProfiles).toBe(true);
  });

  it("a feature switched off in settings is refused for everyone", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings/features",
      headers: bearer(admin.id),
      payload: { value: { careerProfiles: "pro", polishSummary: "off", cvImport: "all" }, reason: "Provider incident" },
    });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv/polish-summary",
      headers: bearer(user.id),
      payload: { summary: "I build things." },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FEATURE_UNAVAILABLE");
  });

  it("refuses a free flow on the backend once its free uses are spent", async () => {
    const app = await getApp();
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { freeCreateUses: 1, freeCreateUsed: true } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv/analyze",
      headers: bearer(user.id),
      payload: { sourceText: "Ten years of backend work at Acme building APIs.", templateId: "classic", flowType: "create" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: "PRO_REQUIRED", reason: "free_used", canPayLater: true, product: "cv_new", price: 2.99 });
    // The refusal is logged for the AI usage view (written in the background).
    await expect
      .poll(() => prisma.aiUsageEvent.count({ where: { userId: user.id, status: "limit_reached" } }), { timeout: 5000 })
      .toBe(1);
  });

  it("AI paused in settings answers 503 before anything is charged", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings/platform",
      headers: bearer(admin.id),
      payload: { value: { registrationEnabled: true, aiGenerationPaused: true, banner: { enabled: true, message: "Maintenance", tone: "warning" } } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv/analyze",
      headers: bearer(user.id),
      payload: { sourceText: "Ten years of backend work at Acme building APIs.", templateId: "classic", flowType: "create" },
    });
    expect(res.statusCode).toBe(503);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).freeCreateUses).toBe(0);
    const platform = await app.inject({ method: "GET", url: "/api/v1/platform/status" });
    expect(platform.json().data.banner).toEqual({ message: "Maintenance", tone: "warning" });
  });
});

describe("free-use metering", () => {
  it("one free CV is shared by every flow; limit grants add to it; refunds give it back", async () => {
    const user = await createUser();
    const first = await consumeGenerationOrThrow(user.id, "tailor");
    expect(first).toMatchObject({ kind: "free", charged: true, lock: null });
    await expect(consumeGenerationOrThrow(user.id, "create")).rejects.toBeInstanceOf(ProRequiredError);

    await prisma.entitlement.create({ data: { userId: user.id, kind: "LIMIT_ADJUSTMENT", flow: "tailor", amount: 2, reason: "Support goodwill" } });
    expect((await consumeGenerationOrThrow(user.id, "improve")).charged).toBe(true);
    const third = await consumeGenerationOrThrow(user.id, "create");
    await expect(consumeGenerationOrThrow(user.id, "tailor")).rejects.toBeInstanceOf(ProRequiredError);

    await refundGeneration(user.id, third);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.freeCreateUses + row.freeTailorUses + row.freeImproveUses).toBe(2);
  });

  it("can't be over-spent by concurrent requests", async () => {
    const user = await createUser();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => consumeGenerationOrThrow(user.id, "create")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).freeCreateUses).toBe(1);
  });

  it("past the free CV, pay later locks the CV — up to the unpaid cap", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { freeCreateUses: 1 } });
    const later = await consumeGenerationOrThrow(user.id, "improve", { payLater: true, fromExisting: true });
    expect(later).toMatchObject({ kind: "pay_later", charged: false, lock: { product: "cv_edit", tier: "free" } });

    for (let i = 0; i < 3; i++) {
      await prisma.cVDocument.create({ data: { userId: user.id, content: {}, unlockProduct: "cv_new", lockedTier: "free" } });
    }
    const capped = await consumeGenerationOrThrow(user.id, "create", { payLater: true }).catch((e) => e);
    expect(capped).toBeInstanceOf(ProRequiredError);
    expect(capped).toMatchObject({ reason: "unpaid_cap", details: { canPayLater: false } });
  });

  it("Plus counts each flow per billing period; past it, pay later or upgrade", async () => {
    const user = await createUser();
    const periodEnd = new Date(Date.now() + 10 * 86400e3);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionProvider: "POLAR",
        subscriptionStatus: "active",
        subscriptionCurrentPeriodEnd: periodEnd,
        polarProductId: "test-plus-monthly",
        usagePeriodKey: "sub:an-old-period",
        periodCreateUses: 8,
      },
    });
    // A new period starts from zero.
    expect(await consumeGenerationOrThrow(user.id, "create")).toMatchObject({ kind: "plan", charged: true });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ usagePeriodKey: `sub:${periodEnd.toISOString()}`, periodCreateUses: 1 });

    await prisma.user.update({ where: { id: user.id }, data: { periodCreateUses: 8 } });
    const limited = await consumeGenerationOrThrow(user.id, "create").catch((e) => e);
    expect(limited).toMatchObject({ reason: "plan_limit", details: { tier: "plus", canPayLater: true } });
    expect(await consumeGenerationOrThrow(user.id, "create", { payLater: true })).toMatchObject({
      kind: "pay_later",
      lock: { product: "cv_new", tier: "plus" },
    });
  });

  it("Pro stops at its hidden fair-use cap, with no pay-later", async () => {
    const user = await createUser();
    const periodEnd = new Date(Date.now() + 10 * 86400e3);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionProvider: "POLAR",
        subscriptionStatus: "active",
        subscriptionCurrentPeriodEnd: periodEnd,
        polarProductId: "test-pro-monthly",
        usagePeriodKey: `sub:${periodEnd.toISOString()}`,
        periodTailorUses: 300,
      },
    });
    const capped = await consumeGenerationOrThrow(user.id, "tailor", { payLater: true }).catch((e) => e);
    expect(capped).toMatchObject({ reason: "fair_use", details: { canPayLater: false } });
    expect((await status(user.id)).freeUses.tailor).toMatchObject({ limit: null, remaining: null });
  });
});

describe("pay-per-CV downloads", () => {
  it("a locked CV can't be downloaded until paid for, and a paid plan unlocks one made on Free", async () => {
    const app = await getApp();
    const user = await createUser();
    const doc = await prisma.cVDocument.create({
      data: { userId: user.id, content: {}, status: "final", unlockProduct: "cv_new", lockedTier: "free" },
    });
    const locked = await app.inject({ method: "GET", url: `/api/v1/cv/${doc.id}/download`, headers: bearer(user.id) });
    expect(locked.statusCode).toBe(402);
    expect(locked.json().error).toMatchObject({ code: "CV_PAYMENT_REQUIRED", product: "cv_new", price: 2.99, cvDocumentId: doc.id });

    await prisma.entitlement.create({ data: { userId: user.id, kind: "PLUS_ACCESS", reason: "comp" } });
    const s = await status(user.id);
    expect(s).toMatchObject({ tier: "plus", isPaid: true, isPro: false });
    expect(s.unpaidCvs.count).toBe(0);
  });

  it("AI content can't be saved into an uncharged CV without the charge that paid for it", async () => {
    const app = await getApp();
    const user = await createUser();
    const doc = await prisma.cVDocument.create({ data: { userId: user.id, content: {} } });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/cv/${doc.id}/generate`,
      headers: bearer(user.id),
      payload: { analyzedContent: { personal: { full_name: "Ada" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("CHARGE_TOKEN_REQUIRED");
  });

  it("a copy of a locked CV stays locked", async () => {
    const app = await getApp();
    const user = await createUser();
    const source = await prisma.cVDocument.create({ data: { userId: user.id, content: {}, unlockProduct: "cv_new", lockedTier: "free" } });
    const res = await app.inject({ method: "POST", url: "/api/v1/cv", headers: bearer(user.id), payload: { sourceCvId: source.id } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ unlockProduct: "cv_new", lockedTier: "free" });
  });
});

describe("public pricing", () => {
  it("lists both plans, pay-per-CV and the lifetime deal, without Pro's fair-use caps", async () => {
    const app = await getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/pricing" });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.plans.pro.monthly).toEqual({ price: 14.99, available: true });
    expect(data.plans.plus.weekly).toEqual({ price: 3.99, available: false });
    expect(data.payPerCv.cv_new.price).toBe(2.99);
    expect(data.lifetime).toMatchObject({ price: 79, offer: { available: true, display: "seats" } });
    expect(JSON.stringify(data)).not.toContain("proFairUse");
  });
});

describe("admin usage", () => {
  it("an admin usage reset gives the free uses back, with an audit entry", async () => {
    const app = await getApp();
    const admin = await createUser({ role: "ADMIN" });
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { freeImproveUses: 1, freeImproveUsed: true } });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/usage/reset`,
      headers: bearer(admin.id),
      payload: { flows: ["improve"], reason: "Generation failed on our side" },
    });
    expect(res.statusCode).toBe(200);
    expect((await status(user.id)).freeImproveUsed).toBe(false);
    const entry = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "user.usage_reset" } });
    expect(entry.metadata).toMatchObject({ before: { improve: 1 }, after: { improve: 0 } });
  });
});
