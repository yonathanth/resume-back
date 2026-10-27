import { Prisma, type CareerProfile } from "@prisma/client";
import { prisma } from "../db/client";
import { PartialCVContent } from "../schemas/cv-content.schema";
import {
  MAX_PROFILE_CONTENT_CHARS,
  emptyProfileContent,
  type ProfileContent,
  type ProfileContentInput,
} from "../schemas/profile-content.schema";
import {
  applyManualEdit,
  applyWording,
  cloneProfileContent,
  countProfileContent,
  cvContentToProfileContent,
  isEmptySummary,
  mergeProfileContent,
  readProfileContent,
  type ProfileChangeSummary,
} from "./profileContent.service";
import { resolveRole } from "./roleKey.service";

// Career profile persistence. Every content change goes through here so it
// is versioned (optimistic concurrency) and recorded in ProfileChange.

export class ProfileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

const notFound = () => new ProfileError(404, "PROFILE_NOT_FOUND", "Career profile not found");
const versionConflict = () =>
  new ProfileError(409, "PROFILE_VERSION_CONFLICT", "This profile was changed somewhere else. Reload it and try again");

function roleExists(existing: Pick<CareerProfile, "id" | "title">) {
  return new ProfileError(409, "PROFILE_ROLE_EXISTS", `You already have a profile for this role: "${existing.title}"`, {
    existingProfileId: existing.id,
    existingProfileTitle: existing.title,
  });
}

function assertContentSize(content: ProfileContent) {
  if (JSON.stringify(content).length > MAX_PROFILE_CONTENT_CHARS) {
    throw new ProfileError(413, "PROFILE_TOO_LARGE", "This profile is too large to save. Remove some entries and try again");
  }
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

// ---------------------------------------------------------------- reads

const listSelect = {
  id: true,
  title: true,
  roleKey: true,
  seniority: true,
  occupationId: true,
  origin: true,
  version: true,
  content: true,
  createdAt: true,
  updatedAt: true,
  occupation: { select: { title: true, category: true } },
  _count: { select: { documents: true } },
} satisfies Prisma.CareerProfileSelect;

type ListRow = Prisma.CareerProfileGetPayload<{ select: typeof listSelect }>;

function toListDto(row: ListRow) {
  const { content, _count, occupation, ...rest } = row;
  const parsed = readProfileContent(content);
  return {
    ...rest,
    occupationTitle: occupation?.title ?? null,
    occupationCategory: occupation?.category ?? null,
    headline: parsed.headline ?? null,
    counts: countProfileContent(parsed),
    documentCount: _count.documents,
  };
}

export type ProfileListItem = ReturnType<typeof toListDto>;

export async function listProfiles(userId: string): Promise<ProfileListItem[]> {
  const rows = await prisma.careerProfile.findMany({ where: { userId }, select: listSelect, orderBy: { updatedAt: "desc" } });
  return rows.map(toListDto);
}

const RECENT_CHANGES = 30;

export async function getProfileDetail(userId: string, id: string) {
  const row = await prisma.careerProfile.findFirst({ where: { id, userId }, select: listSelect });
  if (!row) throw notFound();

  const [documents, changes] = await Promise.all([
    prisma.cVDocument.findMany({
      where: { profileId: id, userId },
      select: { id: true, title: true, templateId: true, status: true, profileVersion: true, jobDescription: true, updatedAt: true, createdAt: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.profileChange.findMany({
      where: { profileId: id },
      select: { id: true, kind: true, cvDocumentId: true, fromVersion: true, toVersion: true, summary: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_CHANGES,
    }),
  ]);

  return {
    ...toListDto(row),
    content: readProfileContent(row.content),
    documents: documents.map(({ jobDescription, ...doc }) => ({ ...doc, tailored: Boolean(jobDescription) })),
    changes,
  };
}

/** The raw profile, ownership-checked — for callers that need content (e.g. CV generation). */
export async function getOwnedProfile(userId: string, id: string) {
  const profile = await prisma.careerProfile.findFirst({ where: { id, userId } });
  if (!profile) throw notFound();
  return { ...profile, content: readProfileContent(profile.content) };
}

// ---------------------------------------------------------------- writes

type Tx = Prisma.TransactionClient;

async function findRoleConflict(tx: Tx, userId: string, roleKey: string, exceptId?: string) {
  return tx.careerProfile.findFirst({
    where: { userId, roleKey, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true, title: true },
  });
}

/** Re-throws a unique-constraint race on (userId, roleKey) as the friendly 409. */
async function withRoleUniqueness<T>(userId: string, roleKey: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.careerProfile.findFirst({ where: { userId, roleKey }, select: { id: true, title: true } });
      if (existing) throw roleExists(existing);
    }
    throw err;
  }
}

/** Writes new content with a version check and records the change. Returns the new version and the change's id. */
async function commitContent(
  tx: Tx,
  profile: { id: string; version: number; content: ProfileContent },
  next: ProfileContent,
  change: { kind: string; summary: ProfileChangeSummary | Record<string, unknown>; cvDocumentId?: string },
  extra: Prisma.CareerProfileUncheckedUpdateManyInput = {}
): Promise<{ version: number; changeId: string }> {
  assertContentSize(next);
  const toVersion = profile.version + 1;
  const { count } = await tx.careerProfile.updateMany({
    where: { id: profile.id, version: profile.version },
    data: { ...extra, content: json(next), version: toVersion },
  });
  if (count === 0) throw versionConflict();
  const created = await tx.profileChange.create({
    data: {
      profileId: profile.id,
      kind: change.kind,
      cvDocumentId: change.cvDocumentId,
      fromVersion: profile.version,
      toVersion,
      previousContent: json(profile.content),
      summary: json(change.summary),
    },
    select: { id: true },
  });
  return { version: toVersion, changeId: created.id };
}

export async function createProfile(
  userId: string,
  input: { title: string; occupationId?: string | null; content?: ProfileContentInput; copyFromProfileId?: string }
) {
  const role = await resolveRole(input.title, input.occupationId);

  let content = emptyProfileContent();
  if (input.copyFromProfileId) {
    content = cloneProfileContent((await getOwnedProfile(userId, input.copyFromProfileId)).content);
  }
  if (input.content) {
    content = applyManualEdit(content, input.content).content;
  }
  assertContentSize(content);

  const id = await withRoleUniqueness(userId, role.roleKey, () =>
    prisma.$transaction(async (tx) => {
      const conflict = await findRoleConflict(tx, userId, role.roleKey);
      if (conflict) throw roleExists(conflict);
      const profile = await tx.careerProfile.create({
        data: { userId, title: input.title.trim(), ...role, content: json(content), origin: "manual" },
      });
      await tx.profileChange.create({
        data: {
          profileId: profile.id,
          kind: "create",
          fromVersion: 0,
          toVersion: 1,
          previousContent: json(emptyProfileContent()),
          summary: json({ copiedFromProfileId: input.copyFromProfileId ?? null }),
        },
      });
      return profile.id;
    })
  );
  return getProfileDetail(userId, id);
}

export async function updateProfile(
  userId: string,
  id: string,
  input: { version: number; title?: string; occupationId?: string | null; content?: ProfileContentInput }
) {
  const profile = await getOwnedProfile(userId, id);
  if (profile.version !== input.version) throw versionConflict();

  // Renaming can move the profile to a different role — re-resolve and keep
  // the one-profile-per-role rule.
  const roleFields: Prisma.CareerProfileUncheckedUpdateManyInput = {};
  if (input.title !== undefined || input.occupationId !== undefined) {
    const title = input.title ?? profile.title;
    const occupationId = input.occupationId === undefined ? profile.occupationId : input.occupationId;
    const role = await resolveRole(title, occupationId);
    Object.assign(roleFields, { title: title.trim(), ...role });
  }

  await withRoleUniqueness(userId, (roleFields.roleKey as string | undefined) ?? profile.roleKey, () =>
    prisma.$transaction(async (tx) => {
      if (roleFields.roleKey) {
        const conflict = await findRoleConflict(tx, userId, roleFields.roleKey as string, id);
        if (conflict) throw roleExists(conflict);
      }

      if (input.content) {
        const { content, summary } = applyManualEdit(profile.content, input.content);
        if (!isEmptySummary(summary) || JSON.stringify(content) !== JSON.stringify(profile.content)) {
          await commitContent(tx, profile, content, { kind: "manual_edit", summary }, roleFields);
          return;
        }
      }
      if (Object.keys(roleFields).length > 0) {
        const { count } = await tx.careerProfile.updateMany({ where: { id, version: profile.version }, data: roleFields });
        if (count === 0) throw versionConflict();
      }
    })
  );
  return getProfileDetail(userId, id);
}

export async function deleteProfile(userId: string, id: string) {
  await getOwnedProfile(userId, id);
  // CVDocument.profileId is ON DELETE SET NULL: the CVs stay, detached.
  await prisma.careerProfile.delete({ where: { id } });
}

/** Restores the content as it was before `changeId`. The revert is itself a recorded (and revertible) change. */
export async function revertProfileChange(userId: string, id: string, changeId: string, version: number) {
  const profile = await getOwnedProfile(userId, id);
  if (profile.version !== version) throw versionConflict();
  const change = await prisma.profileChange.findFirst({ where: { id: changeId, profileId: id } });
  if (!change) throw new ProfileError(404, "PROFILE_CHANGE_NOT_FOUND", "That change no longer exists");
  if (change.kind === "create") throw new ProfileError(400, "PROFILE_CHANGE_NOT_REVERTIBLE", "A profile's creation can't be undone. Delete the profile instead");

  const restored = readProfileContent(change.previousContent);
  await prisma.$transaction((tx) =>
    commitContent(tx, profile, restored, { kind: "revert", summary: { revertedChangeId: change.id, restoredVersion: change.fromVersion } })
  );
  return getProfileDetail(userId, id);
}

// ---------------------------------------------------------------- CV ↔ profile

async function loadCvForProfile(userId: string, cvDocumentId: string) {
  const document = await prisma.cVDocument.findFirst({ where: { id: cvDocumentId, userId } });
  if (!document) throw new ProfileError(404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
  const parsed = PartialCVContent.safeParse(document.content);
  if (!parsed.success) throw new ProfileError(422, "CV_CONTENT_INVALID", "This CV's content can't be read");
  return { document, cv: parsed.data };
}

/** The role a CV is for: its headline, else its most recent job title. */
export function cvRoleTitle(cv: PartialCVContent): string | null {
  const title = cv.personal?.title?.trim() || cv.experience?.find((e) => e.role?.trim())?.role?.trim();
  return title || null;
}

export function cvToIncoming(document: { id: string; jobDescription: string | null }, cv: PartialCVContent, factsOnly?: boolean) {
  return cvContentToProfileContent(cv, {
    source: "cv",
    sourceCvId: document.id,
    includeProse: !document.jobDescription && !factsOnly,
  });
}

/** What merging this CV into the profile would change, without writing anything. */
export async function previewCvMerge(userId: string, cvDocumentId: string, profileId: string, factsOnly?: boolean) {
  const { document, cv } = await loadCvForProfile(userId, cvDocumentId);
  const profile = await getOwnedProfile(userId, profileId);
  return mergeProfileContent(profile.content, cvToIncoming(document, cv, factsOnly)).summary;
}

/** What a new profile made from this CV would hold. */
export async function previewCvAsNewProfile(userId: string, cvDocumentId: string, factsOnly?: boolean): Promise<ProfileChangeSummary> {
  const { document, cv } = await loadCvForProfile(userId, cvDocumentId);
  return { added: countProfileContent(cvToIncoming(document, cv, factsOnly)), updated: {}, removed: {} };
}

/**
 * Creates a profile from a CV, or merges the CV into an existing one, then
 * links the CV to it. A CV generated against a job description — or one the
 * caller marks `factsOnly` (e.g. it was itself written from a profile) —
 * contributes facts only, not its wording (see CvToProfileOptions).
 */
export async function syncCvIntoProfile(
  userId: string,
  input: { cvDocumentId: string; profileId?: string; title?: string; occupationId?: string; factsOnly?: boolean }
) {
  const { document, cv } = await loadCvForProfile(userId, input.cvDocumentId);
  const incoming = cvToIncoming(document, cv, input.factsOnly);

  if (input.profileId) {
    const profile = await getOwnedProfile(userId, input.profileId);
    const { content, summary, details } = mergeProfileContent(profile.content, incoming);
    const changeId = await prisma.$transaction(async (tx) => {
      const committed = isEmptySummary(summary)
        ? null
        : await commitContent(tx, profile, content, { kind: "merge_cv", summary, cvDocumentId: document.id });
      await tx.cVDocument.update({
        where: { id: document.id },
        data: { profileId: profile.id, profileVersion: committed?.version ?? profile.version },
      });
      return committed?.changeId ?? null;
    });
    return { profile: await getProfileDetail(userId, profile.id), summary, details, created: false, changeId };
  }

  const title = (input.title ?? cvRoleTitle(cv) ?? "").trim();
  if (!title) throw new ProfileError(400, "PROFILE_TITLE_REQUIRED", "Give this profile a role title");
  const role = await resolveRole(title, input.occupationId);
  assertContentSize(incoming);

  const profileId = await withRoleUniqueness(userId, role.roleKey, () =>
    prisma.$transaction(async (tx) => {
      const conflict = await findRoleConflict(tx, userId, role.roleKey);
      if (conflict) throw roleExists(conflict);
      const profile = await tx.careerProfile.create({
        data: { userId, title, ...role, content: json(incoming), origin: "cv" },
      });
      await tx.profileChange.create({
        data: {
          profileId: profile.id,
          kind: "create",
          cvDocumentId: document.id,
          fromVersion: 0,
          toVersion: 1,
          previousContent: json(emptyProfileContent()),
          summary: json({ fromCvDocumentId: document.id }),
        },
      });
      await tx.cVDocument.update({ where: { id: document.id }, data: { profileId: profile.id, profileVersion: 1 } });
      return profile.id;
    })
  );
  const summary: ProfileChangeSummary = { added: countProfileContent(incoming), updated: {}, removed: {} };
  const { details } = mergeProfileContent(emptyProfileContent(), incoming);
  return { profile: await getProfileDetail(userId, profileId), summary, details, created: true, changeId: null };
}

/**
 * Saves the approved improved wording (Enhance) from a CV into the profile
 * and links the CV. Proposals are recomputed here from the stored CV — the
 * client only says which keys it approved, never the text.
 */
export async function applyCvWording(
  userId: string,
  profileId: string,
  input: { cvDocumentId: string; version: number; keys: string[] }
) {
  const { document, cv } = await loadCvForProfile(userId, input.cvDocumentId);
  if (document.jobDescription) {
    throw new ProfileError(400, "WORDING_TAILORED", "Wording written for a specific job isn't saved to profiles");
  }
  const profile = await getOwnedProfile(userId, profileId);
  if (profile.version !== input.version) throw versionConflict();

  const { content, summary, applied } = applyWording(profile.content, cvToIncoming(document, cv), input.keys);
  const changeId = await prisma.$transaction(async (tx) => {
    const committed = applied > 0 ? await commitContent(tx, profile, content, { kind: "wording", summary, cvDocumentId: document.id }) : null;
    await tx.cVDocument.update({
      where: { id: document.id },
      data: { profileId: profile.id, profileVersion: committed?.version ?? profile.version },
    });
    return committed?.changeId ?? null;
  });
  return { profile: await getProfileDetail(userId, profile.id), applied, changeId };
}
