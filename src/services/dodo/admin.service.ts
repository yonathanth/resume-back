import type { User } from "@prisma/client";
import { env } from "../../config/env";
import { dodo, dodoErrorMessage, isDodoConfigured } from "./client";
import { applySubscriptionSnapshot } from "./subscription-sync.service";

// Read-only views of Dodo data and safe reconciliation for the admin
// dashboard. Dodo is the source of truth for card payments and
// subscriptions: nothing here writes a payment, and "sync" only ever
// re-fetches the subscription from Dodo's API and applies it with the same
// write the webhook uses.
//
// The admin pages were built on Polar's shapes ("orders" with totals and
// page counts); Dodo payments are mapped onto them. Dodo's list endpoints
// don't return totals, so `total` / `maxPage` are what's known so far.

export class DodoAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DodoAdminError";
  }
}

const wrap = (err: unknown) => new DodoAdminError(dodoErrorMessage(err, "Dodo request failed"));

/** The admin UI still speaks Polar's environment names. */
const ENVIRONMENT = env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? ("production" as const) : ("sandbox" as const);
const DASHBOARD = "https://app.dodopayments.com";

/** Links into the Dodo dashboard. Dodo has no stable per-record URLs, so only the dashboard home is given. */
export function dodoLinks() {
  return {
    environment: ENVIRONMENT,
    organization: null,
    dashboard: DASHBOARD,
    orderBase: null,
    subscriptionBase: null,
    customerBase: null,
  };
}

/** For the admin health check: is the API key set and does Dodo answer? */
export async function getDodoHealth() {
  const started = Date.now();
  if (!isDodoConfigured()) return { environment: ENVIRONMENT, reachable: false, organization: null, latencyMs: null };
  try {
    await dodo().payments.list({ page_size: 1 });
    return { environment: ENVIRONMENT, reachable: true, organization: null, latencyMs: Date.now() - started };
  } catch {
    return { environment: ENVIRONMENT, reachable: false, organization: null, latencyMs: null };
  }
}

type OrderStatus = "pending" | "paid" | "refunded" | "partially_refunded" | "void";

function orderStatus(status: string | null | undefined, refundStatus: string | null | undefined): OrderStatus {
  if (refundStatus === "full") return "refunded";
  if (refundStatus === "partial") return "partially_refunded";
  if (status === "succeeded") return "paid";
  if (status === "failed" || status === "cancelled") return "void";
  return "pending";
}

/** Our filter values → Dodo's payment statuses. */
const DODO_PAYMENT_STATUS: Partial<Record<OrderStatus, "succeeded" | "failed" | "processing">> = {
  paid: "succeeded",
  void: "failed",
  pending: "processing",
};

const PURCHASE_LABEL: Record<string, string> = {
  plus_lifetime: "Plus Lifetime",
  cv_new: "Download one new CV",
  cv_edit: "Download one tailored or improved CV",
};

export interface OrderQuery {
  page: number;
  limit: number;
  status?: OrderStatus | "draft";
  /** Only this user's payments — needs their stored Dodo customer id. */
  dodoCustomerId?: string | null;
  /** Filter by a user that has no Dodo customer: nothing to list. */
  userFilter?: boolean;
  createdAfter?: string;
  createdBefore?: string;
}

export async function listDodoOrders(query: OrderQuery) {
  if (query.userFilter && !query.dodoCustomerId) return { total: 0, maxPage: 1, items: [] };
  const status = query.status && query.status !== "draft" ? DODO_PAYMENT_STATUS[query.status] : undefined;
  try {
    const result = await dodo().payments.list({
      page_number: query.page - 1,
      page_size: query.limit,
      ...(query.dodoCustomerId ? { customer_id: query.dodoCustomerId } : {}),
      ...(status ? { status } : {}),
      ...(query.createdAfter ? { created_at_gte: query.createdAfter } : {}),
      ...(query.createdBefore ? { created_at_lte: query.createdBefore } : {}),
    });
    let items = result.items.map((p) => {
      const purchaseType = typeof p.metadata?.purchaseType === "string" ? p.metadata.purchaseType : null;
      const mapped = orderStatus(p.status, p.refund_status);
      return {
        id: p.payment_id,
        createdAt: p.created_at,
        status: mapped,
        paid: p.status === "succeeded",
        billingReason: p.subscription_id ? "subscription" : "purchase",
        totalAmount: p.total_amount,
        // Dodo's payment list has no net or refunded amount; see the refunds list.
        netAmount: p.total_amount,
        refundedAmount: p.refund_status === "full" ? p.total_amount : 0,
        currency: p.currency,
        customerId: p.customer.customer_id,
        customerEmail: p.customer.email ?? null,
        externalCustomerId: typeof p.metadata?.userId === "string" ? p.metadata.userId : null,
        subscriptionId: p.subscription_id ?? null,
        productName: p.subscription_id ? "Subscription" : purchaseType ? (PURCHASE_LABEL[purchaseType] ?? purchaseType) : null,
        invoiceNumber: p.invoice_id ?? null,
      };
    });
    // Dodo filters by payment status only; refunded ones are told apart here.
    if (query.status === "refunded" || query.status === "partially_refunded") items = items.filter((o) => o.status === query.status);
    const known = (query.page - 1) * query.limit + items.length;
    return { total: known, maxPage: result.items.length === query.limit ? query.page + 1 : query.page, items };
  } catch (err) {
    throw wrap(err);
  }
}

export async function listDodoRefunds(query: { page: number; limit: number; dodoCustomerId?: string | null; userFilter?: boolean }) {
  if (query.userFilter && !query.dodoCustomerId) return { total: 0, items: [] };
  try {
    const result = await dodo().refunds.list({
      page_number: query.page - 1,
      page_size: query.limit,
      ...(query.dodoCustomerId ? { customer_id: query.dodoCustomerId } : {}),
    });
    return {
      total: (query.page - 1) * query.limit + result.items.length,
      items: result.items.map((r) => ({
        id: r.refund_id,
        createdAt: r.created_at,
        status: r.status,
        reason: r.reason ?? (r.is_partial ? "partial" : "full"),
        amount: r.amount ?? 0,
        currency: r.currency ?? "",
        orderId: r.payment_id,
        subscriptionId: null,
        customerId: "",
      })),
    };
  } catch (err) {
    throw wrap(err);
  }
}

const OPEN_DISPUTE = new Set(["dispute_opened", "dispute_challenged"]);

export async function listDodoDisputes(query: { page: number; limit: number }) {
  try {
    const result = await dodo().disputes.list({ page_number: query.page - 1, page_size: query.limit });
    return {
      total: (query.page - 1) * query.limit + result.items.length,
      items: result.items.map((d) => ({
        id: d.dispute_id,
        createdAt: d.created_at,
        status: d.dispute_status,
        resolved: !OPEN_DISPUTE.has(d.dispute_status),
        // Dodo reports dispute amounts as a decimal string; the UI expects minor units.
        amount: Math.round(Number(d.amount) * 100) || 0,
        currency: d.currency,
        reason: d.dispute_stage,
        evidenceDueBy: null,
        orderId: d.payment_id,
        customerEmail: null,
      })),
    };
  } catch (err) {
    throw wrap(err);
  }
}

const REVENUE_PAGE_SIZE = 100;
const REVENUE_MAX_PAGES = 20;

/** Successful Dodo revenue in a period, per currency (minor units), from Dodo's API. */
export async function dodoRevenue(from: Date, to: Date) {
  const totals = new Map<string, { gross: number; net: number; refunded: number; orders: number }>();
  const bucket = (currency: string) => {
    const t = totals.get(currency) ?? { gross: 0, net: 0, refunded: 0, orders: 0 };
    totals.set(currency, t);
    return t;
  };
  const window = { created_at_gte: from.toISOString(), created_at_lte: to.toISOString(), page_size: REVENUE_PAGE_SIZE };
  let truncated = false;
  try {
    for (let page = 0; ; page++) {
      const result = await dodo().payments.list({ ...window, status: "succeeded", page_number: page });
      for (const p of result.items) {
        const t = bucket(p.currency);
        t.gross += p.total_amount;
        t.net += p.total_amount;
        t.orders += 1;
      }
      if (result.items.length < REVENUE_PAGE_SIZE) break;
      if (page + 1 >= REVENUE_MAX_PAGES) {
        truncated = true;
        break;
      }
    }
    for (let page = 0; ; page++) {
      const result = await dodo().refunds.list({ ...window, status: "succeeded", page_number: page });
      for (const r of result.items) {
        if (!r.currency || !r.amount) continue;
        const t = bucket(r.currency);
        t.refunded += r.amount;
        t.net -= r.amount;
      }
      if (result.items.length < REVENUE_PAGE_SIZE) break;
      if (page + 1 >= REVENUE_MAX_PAGES) {
        truncated = true;
        break;
      }
    }
  } catch (err) {
    throw wrap(err);
  }
  return { byCurrency: Object.fromEntries(totals), truncated };
}

/** Re-fetches one subscription from Dodo and applies it. Returns the matched user id (or null). */
export async function resyncSubscriptionById(subscriptionId: string) {
  let sub;
  try {
    sub = await dodo().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    throw wrap(err);
  }
  const userId = await applySubscriptionSnapshot(sub);
  return { userId, status: sub.status, currentPeriodEnd: sub.next_billing_date, cancelAtPeriodEnd: sub.cancel_at_next_billing_date };
}

/**
 * Reconciles one user's Dodo subscription from Dodo's API: the stored
 * subscription id first, else the newest subscription Dodo holds for their
 * Dodo customer. Never invents a subscription when Dodo has none.
 */
export async function resyncUserSubscription(user: Pick<User, "dodoSubscriptionId" | "dodoCustomerId">) {
  if (user.dodoSubscriptionId) {
    return { found: true as const, ...(await resyncSubscriptionById(user.dodoSubscriptionId)) };
  }
  if (!user.dodoCustomerId) return { found: false as const };
  let list;
  try {
    list = await dodo().subscriptions.list({ customer_id: user.dodoCustomerId, page_size: 10 });
  } catch (err) {
    throw wrap(err);
  }
  const chosen = list.items.find((s) => s.status === "active") ?? list.items[0];
  if (!chosen) return { found: false as const };
  return { found: true as const, ...(await resyncSubscriptionById(chosen.subscription_id)) };
}
