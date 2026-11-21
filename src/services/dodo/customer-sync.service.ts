import type { User } from "@prisma/client";
import { dodo, dodoErrorMessage, dodoErrorStatus, isDodoConfigured } from "./client";

// Dodo keeps its own copy of each customer's email — receipts and renewal
// emails go there. When a user changes their email, the Dodo customer
// follows. (Chapa keeps no customer record: each checkout sends the
// account's current email, so it needs nothing.)

export type DodoEmailSync = "updated" | "no_customer" | "failed";

/**
 * Sets the user's Dodo customer email to `email`. Best effort: a user who
 * never paid has no Dodo customer, and a failure never undoes the email
 * change — it's reported so the caller can log it.
 */
export async function syncDodoCustomerEmail(
  user: Pick<User, "dodoCustomerId">,
  email: string
): Promise<{ result: DodoEmailSync; error?: string }> {
  if (!user.dodoCustomerId || !isDodoConfigured()) return { result: "no_customer" };
  try {
    await dodo().customers.update(user.dodoCustomerId, { email });
    return { result: "updated" };
  } catch (err) {
    if (dodoErrorStatus(err) === 404) return { result: "no_customer" };
    return { result: "failed", error: dodoErrorMessage(err, "Dodo request failed") };
  }
}
