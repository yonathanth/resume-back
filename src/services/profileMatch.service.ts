import { createHash } from "node:crypto";
import { prisma } from "../db/client";
import { PartialCVContent } from "../schemas/cv-content.schema";
import { takeAiCall } from "../middleware/ai-rate-limit.middleware";
import { getAIProvider } from "./ai";
import { withAiUsageContext } from "./ai/usage";
import type { RoleMatch } from "./ai/provider.interface";
import { ProfileError, cvRoleTitle, cvToIncoming, getOwnedProfile } from "./profile.service";
import {
  countProfileContent,
  mergeProfileContent,
  readProfileContent,
  wordingProposals,
  type ProfileChangeDetail,
  type ProfileChangeSummary,
  type WordingProposal,
} from "./profileContent.service";
import { occupationCategory, resolveRole } from "./roleKey.service";
import { emptyProfileContent } from "../schemas/profile-content.schema";

// Works out which career profile a new CV belongs to, cheapest check first:
//   1. same roleKey (wording/seniority variants) — free,
//   2. same Occupation catalog entry — free,
//   3. a tiny AI classification against the user's profile titles — only
//      when 1–2 found nothing and the user has profiles; cached, and any
//      failure falls back to "no match".
// "Related" profiles (same field, different job) are never merged into
// automatically; they're offered as "add to this instead".

export type MatchVia = "role" | "occupation" | "ai";

export interface ProfileSuggestion {
  roleTitle: string | null;
  /** The profile this CV is the same role as, with what merging would change. */
  match: { profileId: string; title: string; via: MatchVia; preview: ProfileChangeSummary; details: ProfileChangeDetail[] } | null;
  related: { profileId: string; title: string }[];
  /** What a new profile from this CV would hold (when there's no match). */
  newProfilePreview: ProfileChangeSummary;
  /** The same, item by item. */
  newProfileDetails: ProfileChangeDetail[];
  /** Set when the CV is already linked to a profile. */
  linkedProfileId: string | null;
  /** What saving into the profile the caller asked about (targetProfileId) would change. */
  target: { profileId: string; title: string; preview: ProfileChangeSummary; details: ProfileChangeDetail[] } | null;
  autoSync: string;
}

const AI_CACHE_TTL_MS = 30 * 60 * 1000;
const aiCache = new Map<string, { at: number; result: RoleMatch[] }>();

async function classifyWithAi(userId: string, role: string, profiles: { id: string; title: string }[]): Promise<RoleMatch[]> {
  const key = createHash("sha256")
    .update(JSON.stringify([userId, role.toLowerCase(), profiles.map((p) => [p.id, p.title])]))
    .digest("hex");
  const cached = aiCache.get(key);
  if (cached && Date.now() - cached.at < AI_CACHE_TTL_MS) return cached.result;

  if (!(await takeAiCall(userId, "role_match")).ok) return [];
  try {
    const result = await withAiUsageContext({ userId }, () => getAIProvider().classifyRoleMatch({ role, profiles }));
    aiCache.set(key, { at: Date.now(), result });
    if (aiCache.size > 5_000) aiCache.delete(aiCache.keys().next().value as string);
    return result;
  } catch {
    // Matching is a convenience — never fail the flow over it.
    return [];
  }
}

export async function suggestProfileForCv(
  userId: string,
  input: { cvDocumentId: string; factsOnly?: boolean; profileId?: string }
): Promise<ProfileSuggestion> {
  const [document, user, profiles] = await Promise.all([
    prisma.cVDocument.findFirst({
      where: { id: input.cvDocumentId, userId },
      select: { id: true, content: true, profileId: true, jobDescription: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { profileAutoSync: true } }),
    prisma.careerProfile.findMany({
      where: { userId },
      select: { id: true, title: true, roleKey: true, occupationId: true, content: true, occupation: { select: { category: true } } },
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  if (!document) throw new ProfileError(404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");

  const parsed = PartialCVContent.safeParse(document.content);
  if (!parsed.success) throw new ProfileError(422, "CV_CONTENT_INVALID", "This CV's content can't be read");
  const roleTitle = cvRoleTitle(parsed.data);
  // Converted once; both previews are computed in memory from it.
  const incoming = cvToIncoming(document, parsed.data, input.factsOnly);
  const newProfilePreview: ProfileChangeSummary = { added: countProfileContent(incoming), updated: {}, removed: {} };
  const newProfileDetails = mergeProfileContent(emptyProfileContent(), incoming).details;
  // The profile the caller named (e.g. the one this CV was written from), whatever the role match says.
  const requested = input.profileId ? profiles.find((p) => p.id === input.profileId) : undefined;
  if (input.profileId && !requested) throw new ProfileError(404, "PROFILE_NOT_FOUND", "Career profile not found");
  const target = requested
    ? (() => {
        const merged = mergeProfileContent(readProfileContent(requested.content), incoming);
        return { profileId: requested.id, title: requested.title, preview: merged.summary, details: merged.details };
      })()
    : null;
  const base = {
    roleTitle,
    related: [],
    newProfilePreview,
    newProfileDetails,
    linkedProfileId: document.profileId,
    autoSync: user?.profileAutoSync ?? "ask",
    target,
  };

  // A CV written from a profile goes back to that profile — no role matching needed.
  if (requested) {
    const merged = mergeProfileContent(readProfileContent(requested.content), incoming);
    return {
      ...base,
      match: {
        profileId: requested.id,
        title: requested.title,
        via: "role",
        preview: merged.summary,
        details: merged.details,
      },
    };
  }

  if (!roleTitle || profiles.length === 0) return { ...base, match: null };

  const role = await resolveRole(roleTitle);
  let matched: { profile: (typeof profiles)[number]; via: MatchVia } | null = null;
  const byRole = profiles.find((p) => p.roleKey === role.roleKey);
  if (byRole) matched = { profile: byRole, via: "role" };
  else if (role.occupationId) {
    const byOccupation = profiles.find((p) => p.occupationId === role.occupationId);
    if (byOccupation) matched = { profile: byOccupation, via: "occupation" };
  }

  const relatedIds = new Set<string>();
  if (!matched) {
    const aiMatches = await classifyWithAi(userId, roleTitle, profiles.map(({ id, title }) => ({ id, title })));
    for (const m of aiMatches) {
      const profile = profiles.find((p) => p.id === m.profileId);
      if (!profile) continue;
      if (m.relation === "same" && !matched) matched = { profile, via: "ai" };
      else relatedIds.add(profile.id);
    }
  }

  // Same catalog category counts as related too (free signal, no AI needed).
  const category = await occupationCategory(role.occupationId);
  if (category) for (const p of profiles) if (p.occupation?.category === category) relatedIds.add(p.id);
  if (matched) relatedIds.delete(matched.profile.id);

  return {
    ...base,
    related: profiles.filter((p) => relatedIds.has(p.id)).map((p) => ({ profileId: p.id, title: p.title })),
    match: matched
      ? (() => {
          const merged = mergeProfileContent(readProfileContent(matched.profile.content), incoming);
          return { profileId: matched.profile.id, title: matched.profile.title, via: matched.via, preview: merged.summary, details: merged.details };
        })()
      : null,
  };
}

export interface WordingPreview {
  profile: { id: string; title: string; version: number } | null;
  /** Why nothing is offered, when nothing is. */
  reason: "tailored" | "no_profile" | "updates_off" | null;
  proposals: Omit<WordingProposal, "afterBullets">[];
}

/**
 * Enhance's "use the improved wording in your profile?" offer. The profile is
 * the one the CV (or the CV it was improved from) is linked to, else the
 * role match. Nothing is offered for job-tailored wording, or when the user
 * switched profile updates off.
 */
export async function previewCvWording(userId: string, input: { cvDocumentId: string; sourceCvId?: string }): Promise<WordingPreview> {
  const [document, user] = await Promise.all([
    prisma.cVDocument.findFirst({ where: { id: input.cvDocumentId, userId }, select: { id: true, content: true, profileId: true, jobDescription: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { profileAutoSync: true } }),
  ]);
  if (!document) throw new ProfileError(404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
  if (document.jobDescription) return { profile: null, reason: "tailored", proposals: [] };

  let profileId = document.profileId;
  if (!profileId && input.sourceCvId) {
    profileId = (await prisma.cVDocument.findFirst({ where: { id: input.sourceCvId, userId }, select: { profileId: true } }))?.profileId ?? null;
  }
  if (!profileId) profileId = (await suggestProfileForCv(userId, { cvDocumentId: document.id })).match?.profileId ?? null;
  if (!profileId) return { profile: null, reason: "no_profile", proposals: [] };

  const profile = await getOwnedProfile(userId, profileId);
  const summary = { id: profile.id, title: profile.title, version: profile.version };
  if (user?.profileAutoSync === "never") return { profile: summary, reason: "updates_off", proposals: [] };

  const parsed = PartialCVContent.safeParse(document.content);
  if (!parsed.success) throw new ProfileError(422, "CV_CONTENT_INVALID", "This CV's content can't be read");
  const proposals = wordingProposals(profile.content, cvToIncoming(document, parsed.data)).map(({ afterBullets: _ignored, ...p }) => p);
  return { profile: summary, reason: null, proposals };
}
