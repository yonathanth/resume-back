import { prisma } from "../db/client";
import { formatPersonName } from "../utils/person-name";

/**
 * Contact details from the user's account (collected at onboarding, editable
 * in Account settings). The AI treats them as defaults: they fill a CV's
 * personal fields only when the user's own material doesn't state them, and
 * the matching clarification questions are then never asked. Keys mirror
 * CVContent.personal.
 */
export interface ProfileDefaults {
  full_name?: string;
  email?: string;
  phone?: string;
  /** The user's main profession — a sensible default headline for their CV. */
  title?: string;
  /** All their professions, main first (when they gave more than one), so the AI can pick the headline that fits the job. */
  professions?: string[];
}

/** The defaults that fill a CV's personal fields one-to-one. */
export type PersonalDefaultKey = "full_name" | "email" | "phone" | "title";

export async function getProfileDefaults(userId: string): Promise<ProfileDefaults | undefined> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fullName: true, firstName: true, lastName: true, email: true, phone: true, occupationTitle: true, professions: true },
  });
  if (!user) return undefined;

  const rawName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.fullName;
  const fullName = rawName ? formatPersonName(rawName) : undefined;
  const defaults: ProfileDefaults = {
    full_name: fullName,
    email: user.email || undefined,
    phone: user.phone || undefined,
    title: user.occupationTitle || undefined,
    professions: user.professions.length > 1 ? user.professions : undefined,
  };
  return Object.values(defaults).some(Boolean) ? defaults : undefined;
}
