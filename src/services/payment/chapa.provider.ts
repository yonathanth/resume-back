import { env } from "../../config/env";
import {
  PaymentProviderError,
  type InitializePaymentInput,
  type InitializePaymentResult,
  type PaymentProviderClient,
  type ProviderPaymentStatus,
  type VerifyPaymentResult,
} from "./provider.interface";

// Chapa-specific request/response shapes stay isolated in this file; nothing
// outside services/payment/ should know Chapa exists, let alone which of its
// API versions is in use.
//
// v2 (https://docs.chapa.global/docs/v2) is the intended long-term target,
// but this account's key currently gets 401 "Invalid API key or User does
// not exist" from api.chapa.global specifically — confirmed via direct
// testing that the SAME key authenticates fine against v1. Until Chapa
// resolves v2 access for this account, CHAPA_API_VERSION defaults to "v1"
// (see config/env.ts) so payments actually work; flip it back to "v2" later
// with no code change once that's sorted out.

const V1_BASE_URL = "https://api.chapa.co";

interface ChapaV2InitializeResponse {
  status: string;
  message?: unknown;
  data?: { checkout_url?: string };
}

interface ChapaV2VerifyResponse {
  status: string;
  message?: unknown;
  data?: {
    chapa_reference?: string;
    merchant_reference?: string;
    amount?: number | string;
    currency?: string;
    status?: string;
  };
}

interface ChapaV1InitializeResponse {
  status: string;
  message?: unknown;
  data?: { checkout_url?: string };
}

interface ChapaV1VerifyResponse {
  status: string;
  message?: unknown;
  data?: {
    tx_ref?: string;
    reference?: string;
    amount?: string | number;
    currency?: string;
    status?: string;
  };
}

// CHAPA_BASE_URL may or may not already include a trailing "/v2" (both
// "https://api.chapa.global" and "https://api.chapa.global/v2" are
// reasonable values to put in .env) — normalize once so the v2 paths below
// never end up double-appending it.
function v2ApiRoot(): string {
  return env.CHAPA_BASE_URL.replace(/\/+$/, "").replace(/\/v2$/, "");
}

// The v2 verify endpoint is keyed by Chapa's own reference, but the
// initialize response only returns a checkout_url (no reference field) —
// Chapa's own docs note the reference is otherwise only available via
// webhook. The checkout_url's final path segment IS that reference in
// practice (".../payment/<chapa_reference>"), so it's extracted here rather
// than leaving providerReference null until a webhook arrives.
function extractReferenceFromCheckoutUrl(checkoutUrl: string): string | null {
  try {
    const path = new URL(checkoutUrl).pathname;
    const segment = path.split("/").filter(Boolean).pop();
    return segment || null;
  } catch {
    return null;
  }
}

// The frontend's Chapa return page identifies which payment to re-verify
// via a sessionStorage breadcrumb (see payment-session.ts), not the return
// URL's query string, so this is just CHAPA_RETURN_URL as-is.
function buildReturnUrl(): string {
  return env.CHAPA_RETURN_URL;
}

// Chapa's error "message" is a plain string for some errors but an object of
// field -> messages for validation errors (e.g. {"email":["validation.email"]})
// — stringifying it directly gives the useless "[object Object]".
function formatChapaMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    try {
      return JSON.stringify(message);
    } catch {
      return "unknown error";
    }
  }
  return "unknown error";
}

// Chapa's v1 `customization.title` caps at 16 characters and only allows
// letters, numbers, hyphens, underscores, spaces, and dots (no parentheses,
// etc.) — silently sanitizing here means a future product title that
// violates this doesn't turn into a confusing checkout failure again.
function sanitizeChapaTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9\-_ .]/g, "").trim().slice(0, 16);
}

function normalizeProviderStatus(chapaStatus: string | undefined): ProviderPaymentStatus {
  if (chapaStatus === "success") return "success";
  if (chapaStatus === "failed" || chapaStatus === "cancelled" || chapaStatus === "declined") return "failed";
  return "pending";
}

export class ChapaProvider implements PaymentProviderClient {
  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${env.CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
    };
  }

  async initialize(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    return env.CHAPA_API_VERSION === "v1" ? this.initializeV1(input) : this.initializeV2(input);
  }

  async verify(providerReference: string): Promise<VerifyPaymentResult> {
    return env.CHAPA_API_VERSION === "v1" ? this.verifyV1(providerReference) : this.verifyV2(providerReference);
  }

  private async initializeV2(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const res = await fetch(`${v2ApiRoot()}/v2/payments/hosted`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        merchant_reference: input.merchantReference,
        customer: {
          email: input.customer.email,
          first_name: input.customer.firstName,
          last_name: input.customer.lastName,
          phone_number: input.customer.phoneNumber,
        },
        // Chapa's v2 docs don't show these in the hosted-checkout request
        // body (they may be dashboard-configured instead), but including
        // them is harmless if ignored and correct if honored per-transaction.
        return_url: buildReturnUrl(),
        callback_url: env.CHAPA_WEBHOOK_URL,
        meta: input.meta,
      }),
    });

    const body = (await res.json().catch(() => null)) as ChapaV2InitializeResponse | null;
    const checkoutUrl = body?.data?.checkout_url;

    if (!res.ok || body?.status !== "success" || !checkoutUrl) {
      throw new PaymentProviderError(
        `Chapa payment initialization failed (${res.status}): ${formatChapaMessage(body?.message)}`
      );
    }

    return {
      checkoutUrl,
      providerReference: extractReferenceFromCheckoutUrl(checkoutUrl),
    };
  }

  private async verifyV2(providerReference: string): Promise<VerifyPaymentResult> {
    const res = await fetch(`${v2ApiRoot()}/v2/payments/${encodeURIComponent(providerReference)}/verify`, {
      headers: this.authHeaders(),
    });

    const body = (await res.json().catch(() => null)) as ChapaV2VerifyResponse | null;

    if (!res.ok || !body?.data) {
      throw new PaymentProviderError(
        `Chapa payment verification failed (${res.status}): ${formatChapaMessage(body?.message)}`
      );
    }

    const data = body.data;
    return {
      status: normalizeProviderStatus(data.status),
      amount: Number(data.amount ?? 0),
      currency: data.currency ?? "",
      merchantReference: data.merchant_reference ?? "",
      providerReference: data.chapa_reference ?? providerReference,
    };
  }

  private async initializeV1(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    const res = await fetch(`${V1_BASE_URL}/v1/transaction/initialize`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        amount: String(input.amount),
        currency: input.currency,
        email: input.customer.email,
        first_name: input.customer.firstName,
        last_name: input.customer.lastName,
        tx_ref: input.merchantReference,
        callback_url: env.CHAPA_WEBHOOK_URL,
        return_url: buildReturnUrl(),
        customization: input.meta?.title
          ? { title: sanitizeChapaTitle(String(input.meta.title)) }
          : undefined,
      }),
    });

    const body = (await res.json().catch(() => null)) as ChapaV1InitializeResponse | null;
    const checkoutUrl = body?.data?.checkout_url;

    if (!res.ok || body?.status !== "success" || !checkoutUrl) {
      throw new PaymentProviderError(
        `Chapa payment initialization failed (${res.status}): ${formatChapaMessage(body?.message)}`
      );
    }

    // v1's verify endpoint is keyed by tx_ref (our own merchantReference)
    // directly — no separate provider-side reference to capture first.
    return { checkoutUrl, providerReference: input.merchantReference };
  }

  private async verifyV1(providerReference: string): Promise<VerifyPaymentResult> {
    const res = await fetch(`${V1_BASE_URL}/v1/transaction/verify/${encodeURIComponent(providerReference)}`, {
      headers: this.authHeaders(),
    });

    const body = (await res.json().catch(() => null)) as ChapaV1VerifyResponse | null;

    if (!res.ok || !body?.data) {
      throw new PaymentProviderError(
        `Chapa payment verification failed (${res.status}): ${formatChapaMessage(body?.message)}`
      );
    }

    const data = body.data;
    return {
      status: normalizeProviderStatus(data.status),
      amount: Number(data.amount ?? 0),
      currency: data.currency ?? "",
      merchantReference: data.tx_ref ?? providerReference,
      providerReference: data.tx_ref ?? providerReference,
    };
  }
}
