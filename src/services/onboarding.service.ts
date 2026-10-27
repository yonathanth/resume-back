import type { Prisma, User } from "@prisma/client";
import { prisma } from "../db/client";
import { formatPersonName } from "../utils/person-name";
import { findOccupationByTitle } from "./occupation.service";
import { trackEvent } from "./events.service";
import type { SignupIntent } from "../schemas/onboarding.schema";

// Someone who signs up in the middle of a /try flow has just made a CV that
// already says who they are. Instead of asking again, their account details
// are filled in from it — only the ones still empty, never over what they
// typed themselves — and onboarding counts as done once the essentials
// (name and profession) are there. Whatever is still missing, the dashboard's
// onboarding asks for later.

const PHONE_PATTERN = /^[+\d\s().-]*$/;
const NAME_MAX = 80;
const PHONE_MAX = 40;
const TITLE_MAX = 100;

export interface CvAccountDetails {
  firstName?: string;
  lastName?: string;
  phone?: string;
  occupationTitle?: string;
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** The account details a CV's personal section states (CVContent.personal). */
export function detailsFromCvContent(content: unknown): CvAccountDetails {
  const personal = (content as { personal?: Record<string, unknown> } | null)?.personal ?? {};
  const details: CvAccountDetails = {};

  const fullName = clean(personal.full_name, NAME_MAX * 2);
  if (fullName) {
    const parts = formatPersonName(fullName).split(" ");
    // A single word is a first name with no last name: leave the last name for them to give.
    const first = parts[0];
    const last = parts.slice(1).join(" ");
    if (first && first.length <= NAME_MAX) details.firstName = first;
    if (last && last.length <= NAME_MAX) details.lastName = last;
  }

  const phone = clean(personal.phone, PHONE_MAX);
  if (phone && PHONE_PATTERN.test(phone) && /\d/.test(phone)) details.phone = phone;

  const title = clean(personal.title, TITLE_MAX);
  if (title) details.occupationTitle = title;

  return details;
}

type DetailFields = Pick<User, "firstName" | "lastName" | "phone" | "occupationTitle">;

/** Only the details the account doesn't have yet. */
export function missingDetailsFrom(current: DetailFields, fromCv: CvAccountDetails): CvAccountDetails {
  const patch: CvAccountDetails = {};
  if (!current.firstName && fromCv.firstName) patch.firstName = fromCv.firstName;
  if (!current.lastName && fromCv.lastName) patch.lastName = fromCv.lastName;
  if (!current.phone && fromCv.phone) patch.phone = fromCv.phone;
  if (!current.occupationTitle && fromCv.occupationTitle) patch.occupationTitle = fromCv.occupationTitle;
  return patch;
}

/** Name and profession: what onboarding can't finish without. */
export function hasEssentialDetails(user: DetailFields): boolean {
  return Boolean(user.firstName && user.lastName && user.occupationTitle);
}

export class OnboardingCvNotFoundError extends Error {}

/**
 * Fills the account's empty details from one of the user's CVs and records
 * what they came to do. `surface` is where the CV was made: "try" for the
 * public pages, "dashboard" for a CV made after uploading during onboarding.
 */
export async function fillAccountFromCv(
  userId: string,
  input: { cvDocumentId: string; flow: SignupIntent; surface: "try" | "dashboard" }
): Promise<User> {
  const [user, document] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.cVDocument.findFirst({ where: { id: input.cvDocumentId, userId }, select: { content: true } }),
  ]);
  if (!user) throw new OnboardingCvNotFoundError("User no longer exists");
  if (!document) throw new OnboardingCvNotFoundError("CV document not found");

  const patch = missingDetailsFrom(user, detailsFromCvContent(document.content));
  const data: Prisma.UserUpdateInput = {};
  if (patch.firstName) data.firstName = patch.firstName;
  if (patch.lastName) data.lastName = patch.lastName;
  if (patch.phone) data.phone = patch.phone;
  if (patch.firstName || patch.lastName) {
    data.fullName = [patch.firstName ?? user.firstName, patch.lastName ?? user.lastName].filter(Boolean).join(" ") || null;
  }
  if (patch.occupationTitle) {
    const match = await findOccupationByTitle(patch.occupationTitle);
    data.occupationTitle = match?.title ?? patch.occupationTitle;
    data.professions = [data.occupationTitle as string];
    if (match) data.occupation = { connect: { id: match.id } };
  }
  if (!user.signupIntent) data.signupIntent = input.flow;
  if (!user.signupSurface) data.signupSurface = input.surface;

  const merged = { ...user, ...patch };
  const completesNow = !user.onboardingCompletedAt && hasEssentialDetails(merged);
  if (completesNow) data.onboardingCompletedAt = new Date();

  const updated = Object.keys(data).length > 0 ? await prisma.user.update({ where: { id: userId }, data }) : user;

  trackEvent("onboarding_from_cv", userId, {
    flow: input.flow,
    surface: input.surface,
    filled: Object.keys(patch),
    completed: Boolean(updated.onboardingCompletedAt),
  });
  if (completesNow) {
    trackEvent(
      "onboarding_completed",
      userId,
      { skipped: false, intent: updated.signupIntent, surface: updated.signupSurface, fromCv: true },
      `onboarding_completed:${userId}`
    );
  }
  return updated;
}
