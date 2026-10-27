import { ChapaProvider } from "./chapa.provider";
import type { PaymentProviderClient } from "./provider.interface";

// Only one provider today, but payment.service.ts only ever talks to this
// factory's return type — swapping/adding a provider never touches it.
export function getPaymentProvider(): PaymentProviderClient {
  return new ChapaProvider();
}

export type {
  PaymentProviderClient,
  PaymentCustomer,
  InitializePaymentInput,
  InitializePaymentResult,
  VerifyPaymentResult,
  ProviderPaymentStatus,
} from "./provider.interface";
export { PaymentProviderError } from "./provider.interface";
