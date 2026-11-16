import { beforeEach, describe, expect, it, vi } from "vitest";

// The refund only touches the user's counters; nothing else reaches the database.
const updateMany = vi.fn().mockResolvedValue({ count: 1 });
// A pay-later refund gives its slot of the unpaid cap back (a RateLimitHit row).
const findFirst = vi.fn().mockResolvedValue({ id: 7n });
const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
vi.mock("../../src/db/client", () => ({ prisma: { user: { updateMany }, rateLimitHit: { findFirst, deleteMany } } }));

const { createChargeToken, keepChargeToken, refundChargeToken } = await import("../../src/services/entitlement.service");

const freeCharge = () =>
  createChargeToken("user-1", { kind: "free", flowType: "create", charged: true, periodKey: null, lock: null });

describe("a charge from /cv/analyze that the save can't use", () => {
  beforeEach(() => {
    updateMany.mockClear();
    findFirst.mockClear();
    deleteMany.mockClear();
  });

  it("is given back once", async () => {
    const token = freeCharge();
    expect(await refundChargeToken(token, "user-1")).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "user-1" }, data: { freeCreateUses: { decrement: 1 } } });
    expect(await refundChargeToken(token, "user-1")).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("is kept once a save has used it", async () => {
    const token = freeCharge();
    keepChargeToken(token, "user-1");
    expect(await refundChargeToken(token, "user-1")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("can't be refunded by someone else", async () => {
    expect(await refundChargeToken(freeCharge(), "user-2")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refunds nothing when nothing was spent (pay later)", async () => {
    const token = createChargeToken("user-1", {
      kind: "pay_later",
      flowType: "create",
      charged: false,
      periodKey: null,
      lock: { product: "cv_new", tier: "free" },
    });
    expect(await refundChargeToken(token, "user-1")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    // …but its pay-later start no longer holds a slot of the unpaid cap.
    expect(findFirst.mock.calls[0][0]).toMatchObject({ where: { key: { equals: "paylater:user-1:free" } } });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 7n } });
  });
});
