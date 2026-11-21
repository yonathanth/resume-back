import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  entitlement: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  cVDocument: { updateMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("../../src/db/client", () => ({ prisma: db }));
vi.mock("../../src/services/entitlement.service", () => ({ releasePayLaterStart: vi.fn() }));
vi.mock("../../src/services/email/send", () => ({ sendEmail: vi.fn() }));

const api = vi.hoisted(() => ({
  payments: { retrieve: vi.fn() },
  subscriptions: { update: vi.fn(), changePlan: vi.fn(), retrieve: vi.fn() },
  customers: { update: vi.fn() },
}));
vi.mock("../../src/services/dodo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/dodo/client")>()),
  dodo: () => api,
  isDodoConfigured: () => true,
}));

const { fulfillOneTimePayment, reverseRefundedPayment } = await import("../../src/services/dodo/payment-fulfillment.service");
const { cancelSubscriptionAtPeriodEnd, resumeSubscription, changeSubscriptionProduct } = await import("../../src/services/dodo/subscription.service");
const { syncDodoCustomerEmail } = await import("../../src/services/dodo/customer-sync.service");

const customer = { customer_id: "cus_1", email: "jo@example.com" };
const lifetimePayment = { payment_id: "pay_1", subscription_id: null, product_cart: [{ product_id: "test-plus-lifetime" }], customer, metadata: { userId: "user-1" } };
const cvPayment = { payment_id: "pay_2", subscription_id: null, product_cart: [{ product_id: "test-cv-new" }], customer, metadata: { userId: "user-1", cvDocumentId: "cv-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockImplementation(async ({ where }) => (where.id === "user-1" ? { id: "user-1", email: "jo@example.com" } : null));
  db.user.updateMany.mockResolvedValue({ count: 1 });
  db.entitlement.findFirst.mockResolvedValue(null);
  db.cVDocument.updateMany.mockResolvedValue({ count: 1 });
  db.cVDocument.findFirst.mockResolvedValue({ id: "cv-1", lockedTier: null });
});

describe("one-time purchases", () => {
  it("grants Plus Lifetime once per payment", async () => {
    expect(await fulfillOneTimePayment(lifetimePayment)).toBe("user-1");
    expect(db.entitlement.create.mock.calls[0][0].data).toMatchObject({ userId: "user-1", kind: "LIFETIME_PLUS", note: "pay_1" });
    // Remembers the Dodo customer for the next checkout.
    expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: "user-1", dodoCustomerId: null }, data: { dodoCustomerId: "cus_1" } });

    db.entitlement.findFirst.mockResolvedValue({ id: "e1" });
    expect(await fulfillOneTimePayment(lifetimePayment)).toBe("user-1");
    expect(db.entitlement.create).toHaveBeenCalledTimes(1);
  });

  it("unlocks the CV named in the checkout", async () => {
    expect(await fulfillOneTimePayment(cvPayment)).toBe("user-1");
    expect(db.cVDocument.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "cv-1", userId: "user-1", unlockedAt: null } });
  });

  it("ignores subscription payments and products that aren't ours", async () => {
    expect(await fulfillOneTimePayment({ ...lifetimePayment, subscription_id: "sub_1" })).toBeNull();
    expect(await fulfillOneTimePayment({ ...lifetimePayment, product_cart: [{ product_id: "something-else" }] })).toBeNull();
    expect(db.entitlement.create).not.toHaveBeenCalled();
  });
});

describe("refunds", () => {
  it("leave access alone when partial", async () => {
    expect(await reverseRefundedPayment({ refund_id: "r1", payment_id: "pay_1", is_partial: true })).toMatchObject({ status: "ignored" });
    expect(api.payments.retrieve).not.toHaveBeenCalled();
  });

  it("revoke a refunded Plus Lifetime", async () => {
    api.payments.retrieve.mockResolvedValue(lifetimePayment);
    expect(await reverseRefundedPayment({ refund_id: "r1", payment_id: "pay_1", is_partial: false })).toMatchObject({ status: "processed" });
    expect(db.entitlement.updateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: "user-1", kind: "LIFETIME_PLUS", note: "pay_1", revokedAt: null },
      data: { revokeReason: "Refunded (Dodo refund r1)" },
    });
  });

  it("lock a refunded CV again", async () => {
    api.payments.retrieve.mockResolvedValue(cvPayment);
    await reverseRefundedPayment({ refund_id: "r2", payment_id: "pay_2", is_partial: false });
    expect(db.cVDocument.updateMany).toHaveBeenCalledWith({ where: { id: "cv-1", userId: "user-1" }, data: { unlockedAt: null } });
  });

  it("end a refunded subscription right away", async () => {
    api.payments.retrieve.mockResolvedValue({ ...lifetimePayment, subscription_id: "sub_1" });
    api.subscriptions.update.mockResolvedValue({
      subscription_id: "sub_1",
      product_id: "test-plus-monthly",
      status: "cancelled",
      next_billing_date: "2026-12-21T00:00:00Z",
      cancel_at_next_billing_date: false,
      customer,
      metadata: { userId: "user-1" },
    });
    expect(await reverseRefundedPayment({ refund_id: "r3", payment_id: "pay_1", is_partial: false })).toMatchObject({ status: "processed" });
    expect(api.subscriptions.update).toHaveBeenCalledWith("sub_1", { status: "cancelled", cancel_reason: "cancelled_by_merchant" });
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ subscriptionStatus: "cancelled" });
  });
});

describe("managing a subscription", () => {
  it("cancels at the end of the paid period, and resumes", async () => {
    api.subscriptions.update.mockResolvedValue({});
    await cancelSubscriptionAtPeriodEnd("sub_1");
    expect(api.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_next_billing_date: true, cancel_reason: "cancelled_by_customer" });
    await resumeSubscription("sub_1");
    expect(api.subscriptions.update).toHaveBeenLastCalledWith("sub_1", { cancel_at_next_billing_date: false });
  });

  it("changes plan in place with proration, lifting a scheduled cancellation first", async () => {
    api.subscriptions.retrieve.mockResolvedValue({ subscription_id: "sub_1" });
    await changeSubscriptionProduct("sub_1", "test-pro-monthly", true);
    expect(api.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_next_billing_date: false });
    expect(api.subscriptions.changePlan).toHaveBeenCalledWith("sub_1", {
      product_id: "test-pro-monthly",
      quantity: 1,
      proration_billing_mode: "prorated_immediately",
    });
  });

  it("wraps Dodo failures so the routes can answer 502", async () => {
    api.subscriptions.update.mockRejectedValue(new Error("boom"));
    await expect(cancelSubscriptionAtPeriodEnd("sub_1")).rejects.toMatchObject({ name: "DodoSubscriptionError" });
  });
});

describe("syncing the email to Dodo", () => {
  it("updates the Dodo customer when there is one", async () => {
    api.customers.update.mockResolvedValue({});
    expect(await syncDodoCustomerEmail({ dodoCustomerId: "cus_1" }, "jo@new.com")).toEqual({ result: "updated" });
    expect(api.customers.update).toHaveBeenCalledWith("cus_1", { email: "jo@new.com" });
  });

  it("does nothing for a user who never paid", async () => {
    expect(await syncDodoCustomerEmail({ dodoCustomerId: null }, "jo@new.com")).toEqual({ result: "no_customer" });
    expect(api.customers.update).not.toHaveBeenCalled();
  });

  it("reports a failure without throwing", async () => {
    api.customers.update.mockRejectedValue(new Error("Email already in use"));
    expect(await syncDodoCustomerEmail({ dodoCustomerId: "cus_1" }, "jo@new.com")).toEqual({ result: "failed", error: "Email already in use" });
  });
});
