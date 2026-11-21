import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() } }));
vi.mock("../../src/db/client", () => ({ prisma: db }));
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/email/send", () => ({ sendEmail }));

const { applySubscriptionSnapshot } = await import("../../src/services/dodo/subscription-sync.service");

const snapshot = (over: Record<string, unknown> = {}) => ({
  subscription_id: "sub_new",
  product_id: "test-pro-monthly",
  status: "active",
  next_billing_date: "2026-12-21T00:00:00Z",
  cancel_at_next_billing_date: false,
  customer: { customer_id: "cus_1", email: "jo@example.com" },
  metadata: { userId: "user-1" },
  ...over,
});

const user = (over: Record<string, unknown> = {}) => ({
  id: "user-1",
  email: "jo@example.com",
  subscriptionProvider: null,
  subscriptionStatus: null,
  dodoSubscriptionId: null,
  ...over,
});

describe("syncing a Dodo subscription onto the user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.user.findFirst.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);
    db.user.update.mockResolvedValue({});
  });

  it("finds a first-time subscriber by the userId our checkout put in the metadata", async () => {
    db.user.findUnique.mockImplementation(async ({ where }) => (where.id === "user-1" ? user() : null));
    expect(await applySubscriptionSnapshot(snapshot())).toBe("user-1");
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        subscriptionProvider: "DODO",
        dodoCustomerId: "cus_1",
        dodoSubscriptionId: "sub_new",
        dodoProductId: "test-pro-monthly",
        subscriptionStatus: "active",
        subscriptionCurrentPeriodEnd: new Date("2026-12-21T00:00:00Z"),
        subscriptionCancelAtPeriodEnd: false,
      },
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("falls back to the customer's email", async () => {
    db.user.findUnique.mockImplementation(async ({ where }) => (where.email === "jo@example.com" ? user() : null));
    expect(await applySubscriptionSnapshot(snapshot({ metadata: {} }))).toBe("user-1");
  });

  it("returns null when no user matches", async () => {
    expect(await applySubscriptionSnapshot(snapshot({ metadata: {}, customer: { customer_id: "cus_x", email: "nobody@example.com" } }))).toBeNull();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("records a scheduled cancellation without emailing", async () => {
    db.user.findFirst.mockResolvedValue(user({ subscriptionProvider: "DODO", subscriptionStatus: "active", dodoSubscriptionId: "sub_new" }));
    await applySubscriptionSnapshot(snapshot({ cancel_at_next_billing_date: true }));
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ subscriptionStatus: "active", subscriptionCancelAtPeriodEnd: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("emails when the plan ends", async () => {
    db.user.findFirst.mockResolvedValue(user({ subscriptionProvider: "DODO", subscriptionStatus: "active", dodoSubscriptionId: "sub_new" }));
    await applySubscriptionSnapshot(snapshot({ status: "cancelled" }));
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ subscriptionStatus: "cancelled" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("never lets an older subscription's late event overwrite a newer active one", async () => {
    db.user.findFirst.mockResolvedValue(user({ subscriptionProvider: "DODO", subscriptionStatus: "active", dodoSubscriptionId: "sub_new" }));
    expect(await applySubscriptionSnapshot(snapshot({ subscription_id: "sub_old", status: "expired" }))).toBe("user-1");
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
