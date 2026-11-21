import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { Webhook } from "standardwebhooks";
import { Prisma } from "@prisma/client";

// Signed deliveries to POST /api/v1/webhooks/dodo. The database and the
// fulfillment services are mocked: this checks signature verification,
// dedupe, routing by event type and the recorded outcome.
const db = vi.hoisted(() => ({
  webhookEvent: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("../../src/db/client", () => ({ prisma: db }));

const services = vi.hoisted(() => ({
  applySubscriptionSnapshot: vi.fn(),
  fulfillOneTimePayment: vi.fn(),
  reverseRefundedPayment: vi.fn(),
}));
vi.mock("../../src/services/dodo/subscription-sync.service", () => ({ applySubscriptionSnapshot: services.applySubscriptionSnapshot }));
vi.mock("../../src/services/dodo/payment-fulfillment.service", () => ({
  fulfillOneTimePayment: services.fulfillOneTimePayment,
  reverseRefundedPayment: services.reverseRefundedPayment,
}));

const { webhookRoutes } = await import("../../src/routes/webhook.routes");

const signer = new Webhook(process.env.DODO_PAYMENTS_WEBHOOK_KEY!);
let deliveries = 0;

function signed(event: object, id = `msg_${++deliveries}`) {
  const body = JSON.stringify(event);
  const timestamp = new Date();
  return {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": signer.sign(id, timestamp, body),
    },
  };
}

async function app() {
  const server = Fastify();
  await server.register(rawBody, { global: false });
  await server.register(webhookRoutes);
  return server;
}

const subscription = {
  subscription_id: "sub_1",
  product_id: "test-pro-monthly",
  status: "active",
  next_billing_date: "2026-12-21T00:00:00Z",
  cancel_at_next_billing_date: false,
  customer: { customer_id: "cus_1", email: "jo@example.com", name: "Jo" },
  metadata: { userId: "user-1" },
};

const post = async (delivery: ReturnType<typeof signed>) =>
  (await app()).inject({ method: "POST", url: "/api/v1/webhooks/dodo", payload: delivery.body, headers: delivery.headers });

describe("the Dodo webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.webhookEvent.create.mockImplementation(async ({ data }) => ({ id: `rec_${data.eventId}`, ...data }));
    db.webhookEvent.update.mockResolvedValue({});
    services.applySubscriptionSnapshot.mockResolvedValue("user-1");
    services.fulfillOneTimePayment.mockResolvedValue("user-1");
  });

  it("rejects a delivery whose signature doesn't match", async () => {
    const delivery = signed({ type: "subscription.active", data: subscription });
    const res = await post({ ...delivery, body: delivery.body.replace("sub_1", "sub_2") });
    expect(res.statusCode).toBe(401);
    expect(services.applySubscriptionSnapshot).not.toHaveBeenCalled();
    expect(db.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("syncs a subscription event and records it as processed", async () => {
    const res = await post(signed({ type: "subscription.active", business_id: "biz", timestamp: "now", data: subscription }));
    expect(res.statusCode).toBe(200);
    expect(services.applySubscriptionSnapshot).toHaveBeenCalledWith(expect.objectContaining({ subscription_id: "sub_1" }));
    expect(db.webhookEvent.create.mock.calls[0][0].data).toMatchObject({ provider: "DODO", eventType: "subscription.active", resourceId: "sub_1" });
    expect(db.webhookEvent.update.mock.calls[0][0].data).toMatchObject({ status: "processed", error: null });
  });

  it("treats every subscription.* event the same way (e.g. a cancellation)", async () => {
    await post(signed({ type: "subscription.cancelled", data: { ...subscription, status: "cancelled" } }));
    expect(services.applySubscriptionSnapshot).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("records an unmatched subscription when no user is found", async () => {
    services.applySubscriptionSnapshot.mockResolvedValue(null);
    const res = await post(signed({ type: "subscription.active", data: subscription }));
    expect(res.statusCode).toBe(200);
    expect(db.webhookEvent.update.mock.calls[0][0].data).toMatchObject({ status: "unmatched" });
  });

  it("does nothing for a repeat of a delivery it already handled", async () => {
    db.webhookEvent.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    db.webhookEvent.findUnique.mockResolvedValue({ id: "rec_1", status: "processed" });
    const res = await post(signed({ type: "subscription.active", data: subscription }, "msg_repeat"));
    expect(res.statusCode).toBe(200);
    expect(services.applySubscriptionSnapshot).not.toHaveBeenCalled();
  });

  it("answers 500 when processing fails, and processes the redelivery", async () => {
    services.applySubscriptionSnapshot.mockRejectedValueOnce(new Error("db hiccup"));
    const first = await post(signed({ type: "subscription.active", data: subscription }, "msg_retry"));
    expect(first.statusCode).toBe(500);
    expect(db.webhookEvent.update.mock.calls[0][0].data).toMatchObject({ status: "failed", error: "db hiccup" });

    db.webhookEvent.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    db.webhookEvent.findUnique.mockResolvedValue({ id: "rec_msg_retry", status: "failed" });
    const second = await post(signed({ type: "subscription.active", data: subscription }, "msg_retry"));
    expect(second.statusCode).toBe(200);
    expect(services.applySubscriptionSnapshot).toHaveBeenCalledTimes(2);
    expect(db.webhookEvent.update.mock.calls[1][0]).toMatchObject({ where: { id: "rec_msg_retry" }, data: { status: "processed" } });
  });

  it("fulfills a one-time payment", async () => {
    const payment = { payment_id: "pay_1", subscription_id: null, product_cart: [{ product_id: "test-plus-lifetime", quantity: 1 }], customer: subscription.customer, metadata: { userId: "user-1" } };
    const res = await post(signed({ type: "payment.succeeded", data: payment }));
    expect(res.statusCode).toBe(200);
    expect(services.fulfillOneTimePayment).toHaveBeenCalledWith(expect.objectContaining({ payment_id: "pay_1" }));
  });

  it("leaves a subscription's own payments to the subscription events", async () => {
    const payment = { payment_id: "pay_2", subscription_id: "sub_1", product_cart: [], customer: subscription.customer, metadata: {} };
    await post(signed({ type: "payment.succeeded", data: payment }));
    expect(services.fulfillOneTimePayment).not.toHaveBeenCalled();
    expect(db.webhookEvent.update.mock.calls[0][0].data).toMatchObject({ status: "ignored" });
  });

  it("reverses a refunded payment", async () => {
    services.reverseRefundedPayment.mockResolvedValue({ status: "processed", userId: "user-1", action: "Revoked Plus Lifetime" });
    await post(signed({ type: "refund.succeeded", data: { refund_id: "ref_1", payment_id: "pay_1", is_partial: false } }));
    expect(services.reverseRefundedPayment).toHaveBeenCalledWith(expect.objectContaining({ refund_id: "ref_1" }));
    expect(db.webhookEvent.update.mock.calls[0][0].data).toMatchObject({ status: "processed" });
  });

  it("acknowledges event types it doesn't act on", async () => {
    const res = await post(signed({ type: "dispute.opened", data: { dispute_id: "d1" } }));
    expect(res.statusCode).toBe(200);
    expect(db.webhookEvent.create.mock.calls[0][0].data).toMatchObject({ status: "ignored", resourceId: null });
    expect(db.webhookEvent.update).not.toHaveBeenCalled();
  });
});
