import type { User } from "@prisma/client";
import { polarClient } from "./client";

// Polar keeps its own copy of each customer's email — receipts, renewal and
// billing emails go there. When a user changes their email, the Polar
// customer follows. (Chapa keeps no customer record: each checkout sends
// the account's current email, so it needs nothing.)

export type PolarEmailSync = "updated" | "no_customer" | "failed";

/**
 * Sets the user's Polar customer email to `email`. Found by Polar's customer
 * id when we've stored it, else by our user id (checkouts set it as the
 * customer's external id). Best effort: a user who never paid has no
 * customer, and a failure never undoes the email change — it's reported so
 * the caller can log it.
 */
export async function syncPolarCustomerEmail(
  user: Pick<User, "id" | "polarCustomerId">,
  email: string
): Promise<{ result: PolarEmailSync; error?: string }> {
  try {
    if (user.polarCustomerId) {
      await polarClient.customers.update(user.polarCustomerId, { email });
    } else {
      await polarClient.customers.updateExternal(user.id, { email });
    }
    return { result: "updated" };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return { result: "no_customer" };
    return { result: "failed", error: err instanceof Error ? err.message.slice(0, 300) : "Polar request failed" };
  }
}
