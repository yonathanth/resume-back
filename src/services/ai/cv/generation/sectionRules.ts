import { CV_SECTION_CATALOG, type CVSectionKey } from "../../../../config/cv-sections";
import { getAIOptionalSections } from "../../../../config/cv-templates";
import { isPlainObject } from "../../../../utils/merge-content";

const CORE_CONTENT_KEYS = Object.values(CV_SECTION_CATALOG)
  .filter((section) => section.core)
  .flatMap((section) => section.contentKeys);

export function resolveOptionalSections(templateId: string): CVSectionKey[] {
  return getAIOptionalSections(templateId);
}

/**
 * Drops any top-level key the AI returned that isn't a core CVContent field
 * or belongs to a section this template shows — the prompt already asks for
 * only those, this is the backend's own enforcement of that boundary. Also
 * removes anything the AI must never write (the photo is user-uploaded only).
 */
export function stripUnsupportedSections(
  data: Record<string, unknown>,
  templateId: string
): Record<string, unknown> {
  const allowedKeys = new Set<string>([
    "personal",
    ...CORE_CONTENT_KEYS,
    ...resolveOptionalSections(templateId).flatMap((key) => CV_SECTION_CATALOG[key].contentKeys),
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (allowedKeys.has(key)) result[key] = value;
  }
  if (isPlainObject(result.personal) && "photo" in result.personal) {
    const { photo: _photo, ...personal } = result.personal;
    result.personal = personal;
  }
  return result;
}
