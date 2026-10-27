import type { User } from "@prisma/client";
import { prisma } from "../db/client";

// The single account-deletion path, used by self-service deletion
// (DELETE /auth/me) and by admins, so both follow the same retention rules:
// the account and everything it owns are removed. Refresh tokens,
// entitlements, notifications, push subscriptions, reset/verification tokens
// and email logs go with the user row (onDelete: Cascade); AI usage events
// stay for cost totals with the user unlinked (onDelete: SetNull). The rest
// have no cascade and are removed explicitly in the same transaction. The
// admin audit log keeps its own record of the deletion.

// A Polar subscription that will still renew — deleting the account would
// orphan it and keep billing the customer.
export function hasRenewingPolarSubscription(user: User): boolean {
  return (
    user.subscriptionProvider === "POLAR" &&
    (user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing" || user.subscriptionStatus === "past_due") &&
    !user.subscriptionCancelAtPeriodEnd
  );
}

export async function deleteUserAccount(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.payment.deleteMany({ where: { userId } }),
    prisma.cVImport.deleteMany({ where: { userId } }),
    prisma.cVDocument.deleteMany({ where: { userId } }),
    prisma.careerProfile.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
}
