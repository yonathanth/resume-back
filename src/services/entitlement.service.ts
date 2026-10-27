import crypto from "node:crypto";
import { Prisma, type User } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { getSettings } from "./settings.service";
import {
  FREE_USES_FIELD,
  PERIOD_USES_FIELD,
  hasBillingPro,
  resolveAccess,
  type AccessSnapshot,
} from "./access.service";
import {
  ONE_TIME_PRICES,
  TIER_RANK,
  isCvUnlockProduct,
  isPlanTier,
  unlockProductFor,
  type CvUnlockProduct,
  type PlanTier,
} from "./polar/plans";

export { ProFeatureRequiredError, FeatureUnavailableError, assertFeatureAccess } from "./access.service";

// Charging for AI CVs. Each CV is charged once, by the first AI pass of the
// flow that makes it (cv.routes.ts's POST /cv/analyze); later AI passes on the
// same CV are part of that flow and free. What a charge spends:
//   Free — one of the free AI CVs, if any are left. Past that, the user can
//          go on and pay at download ("pay later"): the CV is made but locked
//          (unlockProduct) until paid for — at most plans.free.unpaidCvCap
//          unpaid CVs at a time.
//   Plus — one of this period's uses of that flow; past the limit, pay later
//          too (or upgrade).
//   Pro  — one of the hidden fair-use uses; past it, nothing (fair use).
// A charge whose AI call produced nothing usable is given back (refund).

export type FlowType = "create" | "tailor" | "improve";

/** Why a new flow can't start, and what the user can do about it. */
export type PaywallReason = "free_used" | "plan_limit" | "unpaid_cap" | "fair_use";

export class ProRequiredError extends Error {
  constructor(
    public flowType: FlowType,
    public reason: PaywallReason = "free_used",
    public details: { tier: PlanTier; canPayLater: boolean; product: CvUnlockProduct; price: number } = {
      tier: "free",
      canPayLater: false,
      product: "cv_new",
      price: ONE_TIME_PRICES.cv_new,
    }
  ) {
    super(
      reason === "fair_use"
        ? "You've reached this period's fair-use limit. It resets with your next billing period."
        : reason === "unpaid_cap"
          ? "Download or delete one of your unpaid CVs before making another, or upgrade."
          : reason === "plan_limit"
            ? "You've used this period's limit for this on your plan. Upgrade to Pro, or pay for this CV at download."
            : "Your free CV is used. Upgrade, or pay for this CV when you download it."
    );
    this.name = "ProRequiredError";
  }
}

type BillingUser = Pick<User, "subscriptionStatus" | "subscriptionCurrentPeriodEnd">;

/** Billing-backed paid plan only (Polar/Chapa) — what cancel/resume act on. */
export function hasActiveProAccess(user: BillingUser): boolean {
  return hasBillingPro(user);
}

export interface EntitlementSnapshot {
  isPro: boolean;
  /** True when nothing of that flow is left on the current plan. */
  freeCreateUsed: boolean;
  freeTailorUsed: boolean;
  freeImproveUsed: boolean;
}

export function toEntitlementSnapshot(access: AccessSnapshot): EntitlementSnapshot {
  return {
    isPro: access.isPro,
    freeCreateUsed: access.limits.create.remaining === 0,
    freeTailorUsed: access.limits.tailor.remaining === 0,
    freeImproveUsed: access.limits.improve.remaining === 0,
  };
}

/** The pay-per-CV lock a CV gets: what unlocking it costs, and the plan it was made on. */
export interface CvLock {
  product: CvUnlockProduct;
  tier: PlanTier;
}

export interface GenerationCharge {
  /** What was spent: a free CV, a plan use, nothing (pay at download), or nothing (unmetered). */
  kind: "free" | "plan" | "pay_later" | "unmetered";
  flowType: FlowType;
  /** True when a counter was spent (free or plan) — refunded if the AI call fails. */
  charged: boolean;
  periodKey: string | null;
  lock: CvLock | null;
}

/** CVs this user made with "pay later" that are still locked for them now. */
export async function countUnpaidCvs(userId: string, tier: PlanTier): Promise<number> {
  const docs = await prisma.cVDocument.findMany({
    where: { userId, unlockProduct: { not: null }, unlockedAt: null },
    select: { lockedTier: true },
  });
  return docs.filter((d) => !isPlanTier(d.lockedTier) || TIER_RANK[tier] <= TIER_RANK[d.lockedTier]).length;
}

/** True when the CV still needs paying for before it can be downloaded by this user. */
export function isCvLocked(
  doc: { unlockProduct: string | null; unlockedAt: Date | null; lockedTier: string | null },
  tier: PlanTier
): boolean {
  if (!doc.unlockProduct || doc.unlockedAt) return false;
  const lockedTier: PlanTier = isPlanTier(doc.lockedTier) ? doc.lockedTier : "free";
  return TIER_RANK[tier] <= TIER_RANK[lockedTier];
}

async function spendFree(userId: string, flowType: FlowType, limit: number): Promise<boolean> {
  const column = Prisma.raw(`"${FREE_USES_FIELD[flowType]}"`);
  const flag = Prisma.raw(
    `"${flowType === "create" ? "freeCreateUsed" : flowType === "tailor" ? "freeTailorUsed" : "freeImproveUsed"}"`
  );
  // One conditional UPDATE, so concurrent requests can't spend past the pool.
  const count = await prisma.$executeRaw`
    UPDATE "User" SET ${column} = ${column} + 1, ${flag} = true
    WHERE "id" = ${userId}
      AND "freeCreateUses" + "freeTailorUses" + "freeImproveUses" < ${limit}`;
  return count > 0;
}

async function spendPeriod(userId: string, flowType: FlowType, periodKey: string, limit: number): Promise<boolean> {
  // A new period starts every count from zero.
  await prisma.user.updateMany({
    where: { id: userId, OR: [{ usagePeriodKey: null }, { usagePeriodKey: { not: periodKey } }] },
    data: { usagePeriodKey: periodKey, periodCreateUses: 0, periodTailorUses: 0, periodImproveUses: 0 },
  });
  const field = PERIOD_USES_FIELD[flowType];
  const { count } = await prisma.user.updateMany({
    where: { id: userId, usagePeriodKey: periodKey, [field]: { lt: limit } },
    data: { [field]: { increment: 1 } },
  });
  return count > 0;
}

/**
 * Charges the start of a new AI CV. `fromExisting` says whether it reworks a
 * CV/profile the user already has (prices a pay-later CV as tailored /
 * improved rather than new). With `payLater`, a user past their free CV (or
 * a Plus limit) goes on and the CV comes back locked until paid for.
 * Throws ProRequiredError when the flow can't start.
 */
export async function consumeGenerationOrThrow(
  userId: string,
  flowType: FlowType,
  options: { payLater?: boolean; fromExisting?: boolean } = {}
): Promise<GenerationCharge> {
  const access = await resolveAccess(userId);
  const product = unlockProductFor(flowType, Boolean(options.fromExisting));
  if (!access) throw new ProRequiredError(flowType);

  const base = { flowType, periodKey: access.plan.periodKey };
  if (access.exemptions.generationQuota) return { ...base, kind: "unmetered", charged: false, lock: null };

  if (access.tier === "free") {
    const limit = access.free.limit ?? 0;
    if ((access.free.remaining ?? 0) > 0 && (await spendFree(userId, flowType, limit))) {
      return { ...base, kind: "free", charged: true, lock: null };
    }
  } else if (access.plan.periodKey) {
    const { limit } = access.limits[flowType];
    if (limit === null) return { ...base, kind: "unmetered", charged: false, lock: null };
    if (await spendPeriod(userId, flowType, access.plan.periodKey, limit)) {
      return { ...base, kind: "plan", charged: true, lock: null };
    }
    if (access.tier === "pro") {
      throw new ProRequiredError(flowType, "fair_use", { tier: "pro", canPayLater: false, product, price: ONE_TIME_PRICES[product] });
    }
  }

  // Past the free CV / the Plus limit: pay at download, up to the unpaid cap.
  const settings = await getSettings();
  const canPayLater = (await countUnpaidCvs(userId, access.tier)) < settings.plans.free.unpaidCvCap;
  const reason: PaywallReason = !canPayLater ? "unpaid_cap" : access.tier === "free" ? "free_used" : "plan_limit";
  if (options.payLater && canPayLater) {
    return { ...base, kind: "pay_later", charged: false, lock: { product, tier: access.tier } };
  }
  throw new ProRequiredError(flowType, reason, { tier: access.tier, canPayLater, product, price: ONE_TIME_PRICES[product] });
}

/**
 * Gives back what consumeGenerationOrThrow spent when the AI call it paid for
 * produced nothing usable (provider error, rate limit, invalid output, role
 * mismatch). No-op for pay-later, unmetered and continuation calls.
 */
export async function refundGeneration(userId: string, charge: GenerationCharge | undefined): Promise<void> {
  if (!charge?.charged) return;
  if (charge.kind === "free") {
    const field = FREE_USES_FIELD[charge.flowType];
    await prisma.user.updateMany({ where: { id: userId, [field]: { gt: 0 } }, data: { [field]: { decrement: 1 } } });
    return;
  }
  if (charge.kind === "plan" && charge.periodKey) {
    const field = PERIOD_USES_FIELD[charge.flowType];
    await prisma.user.updateMany({
      where: { id: userId, usagePeriodKey: charge.periodKey, [field]: { gt: 0 } },
      data: { [field]: { decrement: 1 } },
    });
  }
}

/** The stricter of two locks: a new-CV price over a tailor/improve one, the higher plan. */
export function mergeLocks(a: CvLock | null, b: CvLock | null): CvLock | null {
  if (!a) return b;
  if (!b) return a;
  return {
    product: a.product === "cv_new" || b.product === "cv_new" ? "cv_new" : "cv_edit",
    tier: TIER_RANK[a.tier] >= TIER_RANK[b.tier] ? a.tier : b.tier,
  };
}

/** A CV's current lock, if it has one and it isn't paid for. */
export function lockOf(doc: { unlockProduct: string | null; lockedTier: string | null; unlockedAt: Date | null }): CvLock | null {
  if (!isCvUnlockProduct(doc.unlockProduct) || doc.unlockedAt) return null;
  return { product: doc.unlockProduct, tier: isPlanTier(doc.lockedTier) ? doc.lockedTier : "free" };
}

/** The CV fields a charge writes — never removes a lock the CV already has. */
export function chargeStampData(
  charge: Pick<GenerationCharge, "flowType" | "lock">,
  existing: CvLock | null
): Prisma.CVDocumentUpdateInput {
  const lock = mergeLocks(existing, charge.lock);
  return {
    chargedFlow: charge.flowType,
    chargedAt: new Date(),
    ...(lock ? { unlockProduct: lock.product, lockedTier: lock.tier, unlockedAt: null } : {}),
  };
}

// The first AI pass of a brand-new flow runs before its CV exists (the
// frontend analyzes, then creates the CV and saves the result). The charge is
// carried over in a short-lived signed token, which the save must present.
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

interface ChargeTokenPayload {
  u: string;
  f: FlowType;
  p: CvUnlockProduct | null;
  t: PlanTier | null;
  /** What the analysis spent, so a save that can't use it can give it back (absent on older tokens). */
  k?: GenerationCharge["kind"];
  pk?: string | null;
  exp: number;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", `${env.JWT_ACCESS_SECRET}:cv-charge`).update(body).digest("base64url");
}

export function createChargeToken(userId: string, charge: GenerationCharge): string {
  const payload: ChargeTokenPayload = {
    u: userId,
    f: charge.flowType,
    p: charge.lock?.product ?? null,
    t: charge.lock?.tier ?? null,
    k: charge.kind,
    pk: charge.periodKey,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readPayload(token: string, userId: string): ChargeTokenPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = sign(body);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as ChargeTokenPayload;
    if (payload.u !== userId || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** The charge a token carries, or null when it's invalid, expired or someone else's. */
export function readChargeToken(token: string, userId: string): Pick<GenerationCharge, "flowType" | "lock"> | null {
  const payload = readPayload(token, userId);
  if (!payload) return null;
  const lock = isCvUnlockProduct(payload.p) && isPlanTier(payload.t) ? { product: payload.p, tier: payload.t } : null;
  return { flowType: payload.f, lock };
}

// A token's charge is settled once: kept by the first save that lands, or given
// back when the save can't use what the analysis produced. Kept in memory for
// the token's lifetime (one server process); after a restart a token simply
// can't be refunded any more, which errs on the side of keeping the charge.
const settledTokens = new Map<string, number>();

function settle(token: string, payload: ChargeTokenPayload): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of settledTokens) if (expiresAt < now) settledTokens.delete(key);
  const key = token.slice(token.lastIndexOf(".") + 1);
  if (settledTokens.has(key)) return false;
  settledTokens.set(key, payload.exp);
  return true;
}

/** A save used this token's charge: it can no longer be refunded. */
export function keepChargeToken(token: string, userId: string): void {
  const payload = readPayload(token, userId);
  if (payload) settle(token, payload);
}

/**
 * A save couldn't use what the analysis behind this token produced: gives
 * back what that analysis spent — once per token, and never after a save kept it.
 */
export async function refundChargeToken(token: string, userId: string): Promise<boolean> {
  const payload = readPayload(token, userId);
  if (!payload?.k || !settle(token, payload)) return false;
  const charged = payload.k === "free" || payload.k === "plan";
  await refundGeneration(userId, { kind: payload.k, flowType: payload.f, charged, periodKey: payload.pk ?? null, lock: null });
  return charged;
}
