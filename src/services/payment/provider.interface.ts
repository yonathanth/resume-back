// Chapa-agnostic contract — a future second provider (e.g. Stripe) implements
// the same interface so payment.service.ts never has to change.

export interface PaymentCustomer {
  email: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
}

export interface InitializePaymentInput {
  amount: number;
  currency: string;
  /** Our own generated reference — sent to the provider so it can be echoed back. */
  merchantReference: string;
  customer: PaymentCustomer;
  meta?: Record<string, unknown>;
}

export interface InitializePaymentResult {
  checkoutUrl: string;
  /** The provider's own reference for this transaction, if known immediately. */
  providerReference: string | null;
}

export type ProviderPaymentStatus = "success" | "failed" | "pending";

export interface VerifyPaymentResult {
  status: ProviderPaymentStatus;
  amount: number;
  currency: string;
  merchantReference: string;
  providerReference: string;
}

export interface PaymentProviderClient {
  initialize(input: InitializePaymentInput): Promise<InitializePaymentResult>;
  verify(providerReference: string): Promise<VerifyPaymentResult>;
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
