import type { User } from "@prisma/client";
import { polarClient } from "./client";
import { env } from "../../config/env";
import { applySubscriptionSnapshot, type PolarSubscriptionSnapshot } from "./subscription-sync.service";

// Read-only views of Polar data and safe reconciliation for the admin
// dashboard. Polar is the source of truth for Polar payments and
// subscriptions: nothing here writes a payment, and "sync" only ever
// re-fetches the subscription from Polar's API and applies it with the same
// write the webhook uses.

export class PolarAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarAdminError";
  }
}

function wrap(err: unknown): PolarAdminError {
  return new PolarAdminError(err instanceof Error ? err.message.slice(0, 300) : "Polar request failed");
}

const DASHBOARD_BASE = env.POLAR_SERVER === "sandbox" ? "https://sandbox.polar.sh" : "https://polar.sh";

let orgCache: { at: number; value: { id: string; slug: string; name: string } | null } | null = null;
const ORG_CACHE_MS = 10 * 60 * 1000;

/** The organization the access token belongs to (for dashboard links). Null when Polar can't be reached. */
export async function getPolarOrganization() {
  if (orgCache && Date.now() - orgCache.at < ORG_CACHE_MS) return orgCache.value;
  try {
    const page = await polarClient.organizations.list({ limit: 1 });
    const org = page.items[0];
    orgCache = { at: Date.now(), value: org ? { id: org.id, slug: org.slug, name: org.name } : null };
  } catch {
    orgCache = { at: Date.now(), value: null };
  }
  return orgCache.value;
}

/** Deep links into the Polar dashboard. Falls back to the dashboard home when the org slug is unknown. */
export async function polarLinks() {
  const org = await getPolarOrganization();
  const base = org ? `${DASHBOARD_BASE}/dashboard/${org.slug}` : `${DASHBOARD_BASE}/dashboard`;
  return {
    environment: env.POLAR_SERVER,
    organization: org,
    dashboard: base,
    orderBase: org ? `${base}/sales` : null,
    subscriptionBase: org ? `${base}/sales/subscriptions` : null,
    customerBase: org ? `${base}/customers` : null,
  };
}

export interface OrderQuery {
  page: number;
  limit: number;
  status?: "pending" | "paid" | "refunded" | "partially_refunded" | "void" | "draft";
  userId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export async function listPolarOrders(query: OrderQuery) {
  try {
    const result = await polarClient.orders.list({
      page: query.page,
      limit: query.limit,
      status: query.status ?? null,
      external_customer_id: query.userId ?? null,
      created_after: query.createdAfter ?? null,
      created_before: query.createdBefore ?? null,
      sorting: ["-created_at"],
    });
    return {
      total: result.pagination.total_count,
      maxPage: result.pagination.max_page,
      items: result.items.map((o) => ({
        id: o.id,
        createdAt: o.created_at,
        status: o.status,
        paid: o.paid,
        billingReason: o.billing_reason,
        totalAmount: o.total_amount,
        netAmount: o.net_amount,
        refundedAmount: o.refunded_amount,
        currency: o.currency,
        customerId: o.customer_id,
        customerEmail: o.customer?.email ?? null,
        externalCustomerId: o.customer?.external_id ?? null,
        subscriptionId: o.subscription_id,
        productName: o.product?.name ?? null,
        invoiceNumber: o.invoice_number,
      })),
    };
  } catch (err) {
    throw wrap(err);
  }
}

export async function listPolarRefunds(query: { page: number; limit: number; userId?: string }) {
  try {
    const result = await polarClient.refunds.list({
      page: query.page,
      limit: query.limit,
      external_customer_id: query.userId ?? null,
      sorting: ["-created_at"],
    });
    return {
      total: result.pagination.total_count,
      items: result.items.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        status: r.status,
        reason: r.reason,
        amount: r.amount,
        currency: r.currency,
        orderId: r.order_id,
        subscriptionId: r.subscription_id,
        customerId: r.customer_id,
      })),
    };
  } catch (err) {
    throw wrap(err);
  }
}

export async function listPolarDisputes(query: { page: number; limit: number }) {
  try {
    const result = await polarClient.disputes.list({ page: query.page, limit: query.limit, sorting: ["-created_at"] });
    return {
      total: result.pagination.total_count,
      items: result.items.map((d) => ({
        id: d.id,
        createdAt: d.created_at,
        status: d.status,
        resolved: d.resolved,
        amount: d.amount,
        currency: d.currency,
        reason: d.reason,
        evidenceDueBy: d.evidence_due_by,
        orderId: d.order_id,
        customerEmail: d.customer?.email ?? null,
      })),
    };
  } catch (err) {
    throw wrap(err);
  }
}

/** Paid Polar revenue in a period, per currency (minor units), from Polar's API. */
export async function polarRevenue(from: Date, to: Date) {
  const totals = new Map<string, { gross: number; net: number; refunded: number; orders: number }>();
  let page = 1;
  let truncated = false;
  try {
    for (;;) {
      const result = await polarClient.orders.list({
        page,
        limit: 100,
        created_after: from.toISOString(),
        created_before: to.toISOString(),
        status: ["paid", "refunded", "partially_refunded"],
      });
      for (const o of result.items) {
        const t = totals.get(o.currency) ?? { gross: 0, net: 0, refunded: 0, orders: 0 };
        t.gross += o.total_amount;
        t.net += o.net_amount;
        t.refunded += o.refunded_amount;
        t.orders += 1;
        totals.set(o.currency, t);
      }
      if (page >= result.pagination.max_page) break;
      if (page >= 20) {
        truncated = true;
        break;
      }
      page++;
    }
  } catch (err) {
    throw wrap(err);
  }
  return { byCurrency: Object.fromEntries(totals), truncated };
}

function toSnapshot(sub: {
  id: string;
  customer_id: string;
  product_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  customer: { external_id?: string | null; email?: string | null };
}): PolarSubscriptionSnapshot {
  return sub;
}

/** Re-fetches one subscription from Polar and applies it. Returns the matched user id (or null). */
export async function resyncSubscriptionById(subscriptionId: string) {
  let sub;
  try {
    sub = await polarClient.subscriptions.get(subscriptionId);
  } catch (err) {
    throw wrap(err);
  }
  const userId = await applySubscriptionSnapshot(toSnapshot(sub));
  return { userId, status: sub.status, currentPeriodEnd: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end };
}

/**
 * Reconciles one user's Polar subscription from Polar's API: the stored
 * subscription id first, else the newest subscription Polar holds for this
 * user's external customer id. Never invents a subscription when Polar has none.
 */
export async function resyncUserSubscription(user: Pick<User, "id" | "polarSubscriptionId">) {
  if (user.polarSubscriptionId) {
    return { found: true as const, ...(await resyncSubscriptionById(user.polarSubscriptionId)) };
  }
  let list;
  try {
    list = await polarClient.subscriptions.list({ external_customer_id: user.id, limit: 10, sorting: ["-started_at"] });
  } catch (err) {
    throw wrap(err);
  }
  const chosen = list.items.find((s) => s.status === "active") ?? list.items[0];
  if (!chosen) return { found: false as const };
  const userId = await applySubscriptionSnapshot(toSnapshot(chosen));
  return { found: true as const, userId, status: chosen.status, currentPeriodEnd: chosen.current_period_end, cancelAtPeriodEnd: chosen.cancel_at_period_end };
}
