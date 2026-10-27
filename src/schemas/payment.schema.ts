import { z } from "zod";
import { PRODUCT_TYPES } from "../services/payment/products";

export const initializePaymentSchema = z.object({
  productType: z.enum(PRODUCT_TYPES),
  resourceId: z.string().min(1, "resourceId is required"),
});

export type InitializePaymentInput = z.infer<typeof initializePaymentSchema>;
