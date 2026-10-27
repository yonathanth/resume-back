import { z } from "zod";
import { BILLING_PERIODS, PAID_TIERS } from "../services/polar/plans";

// `provider` and the old `plan` (= billing period) are still accepted so an
// older client keeps working: a bare `plan` means Plus. Chapa is no longer
// offered in the app, but its backend path is kept for existing links.
export const checkoutSchema = z
  .object({
    provider: z.enum(["polar", "chapa"]).default("polar"),
    tier: z.enum(PAID_TIERS).default("plus"),
    period: z.enum(BILLING_PERIODS).optional(),
    plan: z.enum(BILLING_PERIODS).optional(),
  })
  .transform(({ plan, period, ...rest }) => ({ ...rest, period: period ?? plan ?? "monthly" }));

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const changePlanSchema = z
  .object({
    tier: z.enum(PAID_TIERS).default("plus"),
    period: z.enum(BILLING_PERIODS).optional(),
    plan: z.enum(BILLING_PERIODS).optional(),
  })
  .transform(({ plan, period, ...rest }) => ({ ...rest, period: period ?? plan ?? "monthly" }));

export const purchaseCheckoutSchema = z.discriminatedUnion("product", [
  z.object({ product: z.literal("plus_lifetime") }),
  // Unlocks one CV's download — the price comes from the CV itself.
  z.object({ product: z.literal("cv_unlock"), cvDocumentId: z.string().min(1) }),
]);

export type PurchaseCheckoutInput = z.infer<typeof purchaseCheckoutSchema>;
