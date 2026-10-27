import { describe, expect, it } from "vitest";
import {
  addMonths,
  computeAccess,
  isGrantActive,
  monthlyWindow,
  type AccessGrant,
  type AccessUser,
} from "../../src/services/access.service";
import { DEFAULT_SETTINGS } from "../../src/services/settings.service";
import {
  createChargeToken,
  isCvLocked,
  mergeLocks,
  readChargeToken,
} from "../../src/services/entitlement.service";
import { findSubscriptionByProductId, unlockProductFor } from "../../src/services/polar/plans";

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);

const freeUser: AccessUser = {
  subscriptionStatus: null,
  subscriptionCurrentPeriodEnd: null,
  subscriptionProvider: null,
  polarProductId: null,
  freeCreateUses: 0,
  freeTailorUses: 0,
  freeImproveUses: 0,
  usagePeriodKey: null,
  periodCreateUses: 0,
  periodTailorUses: 0,
  periodImproveUses: 0,
};

const subscribed = (productId: string | null, periodEnd = at(10)): AccessUser => ({
  ...freeUser,
  subscriptionProvider: "POLAR",
  subscriptionStatus: "active",
  subscriptionCurrentPeriodEnd: periodEnd,
  polarProductId: productId,
});

let n = 0;
function grant(partial: Partial<AccessGrant> & Pick<AccessGrant, "kind">): AccessGrant {
  return {
    id: `g${++n}`,
    feature: null,
    flow: null,
    amount: null,
    startsAt: at(-1),
    expiresAt: null,
    revokedAt: null,
    ...partial,
  };
}

const settings = structuredClone(DEFAULT_SETTINGS);

describe("isGrantActive", () => {
  it("is active between start and end", () => {
    expect(isGrantActive({ startsAt: at(-1), expiresAt: at(1), revokedAt: null }, NOW)).toBe(true);
  });
  it("is not active once expired, revoked, or before it starts", () => {
    expect(isGrantActive({ startsAt: at(-2), expiresAt: at(-1), revokedAt: null }, NOW)).toBe(false);
    expect(isGrantActive({ startsAt: at(-2), expiresAt: NOW, revokedAt: null }, NOW)).toBe(false);
    expect(isGrantActive({ startsAt: at(-2), expiresAt: null, revokedAt: at(-1) }, NOW)).toBe(false);
    expect(isGrantActive({ startsAt: at(1), expiresAt: null, revokedAt: null }, NOW)).toBe(false);
  });
});

describe("plans catalog", () => {
  it("recognizes Plus, Pro and the retired products (now Plus)", () => {
    expect(findSubscriptionByProductId("test-pro-monthly")).toEqual({ tier: "pro", period: "monthly", legacy: false });
    expect(findSubscriptionByProductId("test-plus-monthly")).toEqual({ tier: "plus", period: "monthly", legacy: false });
    expect(findSubscriptionByProductId("test-legacy-monthly")).toEqual({ tier: "plus", period: "monthly", legacy: true });
    expect(findSubscriptionByProductId("nope")).toBeNull();
  });
  it("prices a pay-later CV as new unless it reworks an existing one", () => {
    expect(unlockProductFor("create", true)).toBe("cv_new");
    expect(unlockProductFor("tailor", false)).toBe("cv_new");
    expect(unlockProductFor("tailor", true)).toBe("cv_edit");
    expect(unlockProductFor("improve", true)).toBe("cv_edit");
  });
});

describe("computeAccess — tiers", () => {
  it("a user without a plan is Free with one free CV, shared by every flow", () => {
    const access = computeAccess(freeUser, [], settings, NOW);
    expect(access).toMatchObject({ tier: "free", isPaid: false, isPro: false, proSource: null });
    expect(access.features.careerProfiles).toBe(false);
    expect(access.free).toEqual({ limit: 1, used: 0, remaining: 1 });
    expect(access.limits.tailor).toEqual({ limit: 1, used: 0, remaining: 1 });
  });

  it("spending the free CV on one flow uses it up for all of them", () => {
    const access = computeAccess({ ...freeUser, freeTailorUses: 1 }, [], settings, NOW);
    expect(access.free.remaining).toBe(0);
    expect(access.limits.create.remaining).toBe(0);
    expect(access.limits.improve.remaining).toBe(0);
  });

  it("a Pro subscription is Pro, with its fair-use cap hidden", () => {
    const access = computeAccess(subscribed("test-pro-monthly"), [], settings, NOW);
    expect(access).toMatchObject({ tier: "pro", isPro: true, isPaid: true, proSource: "subscription", billingPro: true });
    expect(access.plan).toMatchObject({ period: "monthly", source: "subscription" });
    expect(access.limits.create).toMatchObject({ limit: 100, hidden: true });
    expect(access.features.careerProfiles).toBe(true);
  });

  it("a Plus subscription is Plus, with that period's limits and career profiles", () => {
    const access = computeAccess(subscribed("test-plus-monthly"), [], settings, NOW);
    expect(access).toMatchObject({ tier: "plus", isPro: false, isPaid: true });
    expect(access.limits.tailor).toEqual({ limit: 30, used: 0, remaining: 30 });
    expect(access.features.careerProfiles).toBe(true);
  });

  it("subscribers on the retired products, and unknown paid products, are on Plus", () => {
    expect(computeAccess(subscribed("test-legacy-monthly"), [], settings, NOW)).toMatchObject({ tier: "plus", plan: { legacy: true } });
    expect(computeAccess(subscribed("unknown"), [], settings, NOW).tier).toBe("plus");
    expect(computeAccess({ ...subscribed(null), subscriptionProvider: "CHAPA" }, [], settings, NOW).tier).toBe("plus");
  });

  it("a subscription past its period end, or canceled, gives nothing", () => {
    expect(computeAccess(subscribed("test-pro-monthly", at(-1)), [], settings, NOW).tier).toBe("free");
    expect(computeAccess({ ...subscribed("test-pro-monthly"), subscriptionStatus: "canceled" }, [], settings, NOW).tier).toBe("free");
  });

  it("an active PRO_ACCESS grant gives Pro without touching billing", () => {
    const access = computeAccess(freeUser, [grant({ kind: "PRO_ACCESS", expiresAt: at(7) })], settings, NOW);
    expect(access).toMatchObject({ tier: "pro", proSource: "grant", billingPro: false });
    expect(access.proGrantExpiresAt).toEqual(at(7));
  });

  it("a Pro grant outranks a Plus subscription; a Pro subscription is reported as the source", () => {
    const pro = grant({ kind: "PRO_ACCESS", expiresAt: at(7) });
    expect(computeAccess(subscribed("test-plus-monthly"), [pro], settings, NOW)).toMatchObject({ tier: "pro", proSource: "grant" });
    expect(computeAccess(subscribed("test-pro-monthly"), [pro], settings, NOW)).toMatchObject({ tier: "pro", proSource: "subscription" });
  });

  it("Plus Lifetime is Plus with monthly limits that reset each month from the purchase", () => {
    const lifetime = grant({ kind: "LIFETIME_PLUS", startsAt: new Date("2026-08-20T10:00:00Z") });
    const access = computeAccess(freeUser, [lifetime], settings, NOW);
    expect(access).toMatchObject({ tier: "plus", hasLifetime: true, plan: { period: "lifetime", source: "lifetime" } });
    expect(access.limits.tailor.limit).toBe(20);
    expect(access.plan.periodEndsAt).toEqual(new Date("2026-10-20T10:00:00Z"));
  });

  it("usage from an earlier period doesn't count", () => {
    const user = { ...subscribed("test-plus-monthly"), usagePeriodKey: "sub:old", periodTailorUses: 30 };
    expect(computeAccess(user, [], settings, NOW).limits.tailor.remaining).toBe(30);
    const current = { ...user, usagePeriodKey: `sub:${at(10).toISOString()}` };
    expect(computeAccess(current, [], settings, NOW).limits.tailor.remaining).toBe(0);
  });

  it("an expired grant falls back to exactly what billing says", () => {
    const expired = grant({ kind: "PRO_ACCESS", startsAt: at(-8), expiresAt: at(-1) });
    expect(computeAccess(freeUser, [expired], settings, NOW).tier).toBe("free");
    expect(computeAccess(subscribed("test-plus-monthly"), [expired], settings, NOW).tier).toBe("plus");
  });

  it("the latest end date wins among several paid grants, and an open-ended one means no end", () => {
    const a = grant({ kind: "PRO_ACCESS", expiresAt: at(3) });
    const b = grant({ kind: "PLUS_ACCESS", expiresAt: at(9) });
    expect(computeAccess(freeUser, [a, b], settings, NOW).proGrantExpiresAt).toEqual(at(9));
    const open = grant({ kind: "PRO_ACCESS", expiresAt: null });
    expect(computeAccess(freeUser, [a, open], settings, NOW).proGrantExpiresAt).toBeNull();
  });
});

describe("computeAccess — features", () => {
  it("a FEATURE grant opens one paid feature without a plan", () => {
    const access = computeAccess(freeUser, [grant({ kind: "FEATURE", feature: "careerProfiles", expiresAt: at(30) })], settings, NOW);
    expect(access.tier).toBe("free");
    expect(access.features.careerProfiles).toBe(true);
  });

  it("a feature switched off is off even for paid users and grants", () => {
    const off = { ...settings, features: { ...settings.features, careerProfiles: "off" as const } };
    expect(computeAccess(subscribed("test-pro-monthly"), [grant({ kind: "FEATURE", feature: "careerProfiles" })], off, NOW).features.careerProfiles).toBe(false);
  });

  it("a beta feature needs the beta grant (or a grant for that feature), not a plan", () => {
    const beta = { ...settings, features: { ...settings.features, polishSummary: "beta" as const } };
    expect(computeAccess(subscribed("test-pro-monthly"), [], beta, NOW).features.polishSummary).toBe(false);
    expect(computeAccess(freeUser, [grant({ kind: "FEATURE", feature: "beta" })], beta, NOW).features.polishSummary).toBe(true);
  });
});

describe("computeAccess — free CVs", () => {
  it("adds active limit adjustments (any flow) to the free pool", () => {
    const access = computeAccess(
      { ...freeUser, freeCreateUses: 2 },
      [
        grant({ kind: "LIMIT_ADJUSTMENT", flow: "create", amount: 3 }),
        grant({ kind: "LIMIT_ADJUSTMENT", flow: "tailor", amount: 1 }),
        grant({ kind: "LIMIT_ADJUSTMENT", flow: "create", amount: 2, expiresAt: at(-1), startsAt: at(-5) }),
      ],
      settings,
      NOW
    );
    expect(access.free).toEqual({ limit: 5, used: 2, remaining: 3 });
  });

  it("negative adjustments lower the pool but never below zero", () => {
    const access = computeAccess(freeUser, [grant({ kind: "LIMIT_ADJUSTMENT", flow: "improve", amount: -5 })], settings, NOW);
    expect(access.free).toEqual({ limit: 0, used: 0, remaining: 0 });
  });

  it("the generationQuota exemption makes flows unmetered without a plan", () => {
    const access = computeAccess(freeUser, [grant({ kind: "EXEMPTION", feature: "generationQuota" })], settings, NOW);
    expect(access.tier).toBe("free");
    expect(access.limits.create.limit).toBeNull();
  });
});

describe("monthly windows", () => {
  it("clamps to the month's last day", () => {
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1)).toEqual(new Date("2026-02-28T00:00:00Z"));
  });
  it("finds the window a date falls in", () => {
    const start = new Date("2026-01-15T00:00:00Z");
    expect(monthlyWindow(start, new Date("2026-01-20T00:00:00Z")).index).toBe(0);
    expect(monthlyWindow(start, new Date("2026-02-14T23:59:00Z")).index).toBe(0);
    expect(monthlyWindow(start, new Date("2026-02-15T00:00:00Z")).index).toBe(1);
  });
});

describe("pay-per-CV locks", () => {
  const locked = { unlockProduct: "cv_new", lockedTier: "free", unlockedAt: null };
  it("a CV made on Free is locked on Free and unlocked by any paid plan", () => {
    expect(isCvLocked(locked, "free")).toBe(true);
    expect(isCvLocked(locked, "plus")).toBe(false);
  });
  it("a CV made past a Plus limit stays locked on Plus, not on Pro", () => {
    const plus = { ...locked, lockedTier: "plus" };
    expect(isCvLocked(plus, "plus")).toBe(true);
    expect(isCvLocked(plus, "pro")).toBe(false);
  });
  it("a paid-for CV, or one without a lock, is never locked", () => {
    expect(isCvLocked({ ...locked, unlockedAt: NOW }, "free")).toBe(false);
    expect(isCvLocked({ unlockProduct: null, lockedTier: null, unlockedAt: null }, "free")).toBe(false);
  });
  it("merging keeps the stricter lock", () => {
    expect(mergeLocks({ product: "cv_edit", tier: "free" }, { product: "cv_new", tier: "plus" })).toEqual({ product: "cv_new", tier: "plus" });
    expect(mergeLocks(null, { product: "cv_edit", tier: "free" })).toEqual({ product: "cv_edit", tier: "free" });
    expect(mergeLocks(null, null)).toBeNull();
  });
  it("a charge token only works for its own user and can't be altered", () => {
    const token = createChargeToken("user-1", {
      kind: "pay_later",
      flowType: "create",
      charged: false,
      periodKey: null,
      lock: { product: "cv_new", tier: "free" },
    });
    expect(readChargeToken(token, "user-1")).toEqual({ flowType: "create", lock: { product: "cv_new", tier: "free" } });
    expect(readChargeToken(token, "user-2")).toBeNull();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), p: null })).toString("base64url");
    expect(readChargeToken(`${forged}.${sig}`, "user-1")).toBeNull();
  });
});
