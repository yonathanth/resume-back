import { beforeEach, describe, expect, it, vi } from "vitest";

// The unpaid cap counts pay-later starts, not the locked CVs that happen to
// exist: deleting a locked CV used to free its slot, so a free user could
// generate, copy, delete and repeat without ever paying.

// In-memory stand-ins for the two tables the cap reads.
let hits: { id: bigint; key: string; createdAt: Date }[] = [];
let nextId = 1n;
let unpaidDocs: { lockedTier: string }[] = [];

const inWindow = (createdAt: Date, gt?: Date) => !gt || createdAt > gt;
const keyMatches = (key: string, where: { in?: string[]; equals?: string; startsWith?: string }) =>
  (where.in ? where.in.includes(key) : true) &&
  (where.equals ? key === where.equals : true) &&
  (where.startsWith ? key.startsWith(where.startsWith) : true);

vi.mock("../../src/db/client", () => ({
  prisma: {
    rateLimitHit: {
      create: vi.fn(async ({ data }: { data: { key: string; createdAt: Date } }) => {
        hits.push({ id: nextId++, ...data });
      }),
      count: vi.fn(async ({ where }: { where: { key: { in: string[] }; createdAt: { gt: Date } } }) =>
        hits.filter((h) => keyMatches(h.key, where.key) && inWindow(h.createdAt, where.createdAt.gt)).length
      ),
      findFirst: vi.fn(async ({ where }: { where: { key: { equals?: string; startsWith?: string }; createdAt: { gt: Date } } }) => {
        const found = hits.filter((h) => keyMatches(h.key, where.key) && inWindow(h.createdAt, where.createdAt.gt));
        return found.length ? { id: found[found.length - 1].id } : null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id?: bigint } }) => {
        const before = hits.length;
        if (where.id !== undefined) hits = hits.filter((h) => h.id !== where.id);
        return { count: before - hits.length };
      }),
    },
    cVDocument: { findMany: vi.fn(async () => unpaidDocs) },
  },
}));

vi.mock("../../src/services/settings.service", () => ({
  getSettings: vi.fn(async () => ({ plans: { free: { generations: 1, unpaidCvCap: 3 } } })),
}));

// A free user whose free CV is used up.
vi.mock("../../src/services/access.service", () => ({
  FREE_USES_FIELD: { create: "freeCreateUses", tailor: "freeTailorUses", improve: "freeImproveUses" },
  PERIOD_USES_FIELD: { create: "periodCreateUses", tailor: "periodTailorUses", improve: "periodImproveUses" },
  hasBillingPro: vi.fn(() => false),
  resolveAccess: vi.fn(async () => ({
    tier: "free",
    plan: { periodKey: null },
    exemptions: { generationQuota: false },
    free: { limit: 1, remaining: 0 },
    limits: {},
  })),
  ProFeatureRequiredError: class extends Error {},
  FeatureUnavailableError: class extends Error {},
  assertFeatureAccess: vi.fn(),
}));

const { consumeGenerationOrThrow, refundGeneration, releasePayLaterStart, countPayLaterInUse, ProRequiredError } = await import(
  "../../src/services/entitlement.service"
);

const startPayLater = () => consumeGenerationOrThrow("user-1", "create", { payLater: true });

describe("the unpaid (pay later) cap", () => {
  beforeEach(() => {
    hits = [];
    unpaidDocs = [];
  });

  it("isn't reset by deleting the locked CVs", async () => {
    for (let i = 0; i < 3; i++) expect((await startPayLater()).kind).toBe("pay_later");
    // All three CVs deleted: none exist any more…
    unpaidDocs = [];
    // …and the fourth is still refused.
    await expect(startPayLater()).rejects.toBeInstanceOf(ProRequiredError);
    await expect(startPayLater()).rejects.toMatchObject({ reason: "unpaid_cap" });
  });

  it("gives a slot back when the AI call fails (refund)", async () => {
    const charges = [await startPayLater(), await startPayLater(), await startPayLater()];
    await refundGeneration("user-1", charges[2]);
    expect(await countPayLaterInUse("user-1", "free")).toBe(2);
    expect((await startPayLater()).kind).toBe("pay_later");
  });

  it("gives a slot back when a locked CV is paid for", async () => {
    for (let i = 0; i < 3; i++) await startPayLater();
    await releasePayLaterStart("user-1", "free");
    expect((await startPayLater()).kind).toBe("pay_later");
  });

  it("still counts old unpaid CVs that exist (from before the window)", async () => {
    unpaidDocs = [{ lockedTier: "free" }, { lockedTier: "free" }, { lockedTier: "free" }];
    await expect(startPayLater()).rejects.toMatchObject({ reason: "unpaid_cap" });
  });

  it("frees slots after 30 days", async () => {
    for (let i = 0; i < 3; i++) await startPayLater();
    hits = hits.map((h) => ({ ...h, createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }));
    expect((await startPayLater()).kind).toBe("pay_later");
  });
});
