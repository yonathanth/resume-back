import { beforeEach, describe, expect, it, vi } from "vitest";

const polar = vi.hoisted(() => ({ update: vi.fn(), updateExternal: vi.fn() }));
vi.mock("../../src/services/polar/client", () => ({ polarClient: { customers: polar } }));

const { syncPolarCustomerEmail } = await import("../../src/services/polar/customer-sync.service");

describe("syncing the email to Polar", () => {
  beforeEach(() => {
    polar.update.mockReset().mockResolvedValue({});
    polar.updateExternal.mockReset().mockResolvedValue({});
  });

  it("updates the customer by its Polar id when we have it", async () => {
    expect(await syncPolarCustomerEmail({ id: "u1", polarCustomerId: "cus_1" }, "jo@new.com")).toEqual({ result: "updated" });
    expect(polar.update).toHaveBeenCalledWith("cus_1", { email: "jo@new.com" });
    expect(polar.updateExternal).not.toHaveBeenCalled();
  });

  it("otherwise finds the customer by our user id", async () => {
    await syncPolarCustomerEmail({ id: "u1", polarCustomerId: null }, "jo@new.com");
    expect(polar.updateExternal).toHaveBeenCalledWith("u1", { email: "jo@new.com" });
  });

  it("treats a user who never paid as nothing to do", async () => {
    polar.updateExternal.mockRejectedValue(Object.assign(new Error("Not found"), { statusCode: 404 }));
    expect(await syncPolarCustomerEmail({ id: "u1", polarCustomerId: null }, "jo@new.com")).toEqual({ result: "no_customer" });
  });

  it("reports other failures without throwing", async () => {
    polar.update.mockRejectedValue(Object.assign(new Error("Email already in use"), { statusCode: 422 }));
    expect(await syncPolarCustomerEmail({ id: "u1", polarCustomerId: "cus_1" }, "jo@new.com")).toEqual({
      result: "failed",
      error: "Email already in use",
    });
  });
});
