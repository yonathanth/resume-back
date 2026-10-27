import { isPlainObject } from "./merge-content";

type Bullet = { label?: string; text: string };

/** A bullet as stored — legacy content has plain strings, current content has `{ label?, text }`. */
export function toBullet(value: unknown): Bullet | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text } : null;
  }
  if (isPlainObject(value) && typeof value.text === "string" && value.text.trim()) {
    const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined;
    return label ? { label, text: value.text.trim() } : { text: value.text.trim() };
  }
  return null;
}

/** Plain-text form of a bullet ("Label: text"), for prompts and text exports. */
export function bulletText(value: unknown): string {
  const bullet = toBullet(value);
  if (!bullet) return "";
  return bullet.label ? `${bullet.label}: ${bullet.text}` : bullet.text;
}

function normalizeBullets(value: unknown): Bullet[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(toBullet).filter((b): b is Bullet => b !== null);
}

/**
 * Brings stored/incoming CV content to the current canonical shape:
 * - bullets in every entry section become `{ label?, text }` (legacy strings converted)
 * - the flat `skills` list contains every skill from `skillGroups` too, so
 *   keyword matching and the finalize check never miss a grouped skill.
 * Safe to run repeatedly; leaves anything it doesn't recognize untouched.
 */
export function normalizeCvContent<T>(content: T): T {
  if (!isPlainObject(content)) return content;
  const result: Record<string, unknown> = { ...content };

  for (const section of ["experience", "projects", "volunteering", "education", "research", "teaching", "activities"] as const) {
    if (Array.isArray(result[section])) {
      result[section] = (result[section] as unknown[]).map((entry) => {
        if (!isPlainObject(entry) || entry.bullets === undefined) return entry;
        return { ...entry, bullets: normalizeBullets(entry.bullets) };
      });
    }
  }

  // When groups exist they are the source of truth: `skills` is exactly their
  // items (so removing a skill from a group really removes it), and any flat
  // skill that isn't in a group is kept by moving it into an "Other" group.
  if (Array.isArray(result.skillGroups) && result.skillGroups.length > 0) {
    const seen = new Set<string>();
    const skills: string[] = [];
    const groups: { category: string; items: string[] }[] = [];
    const take = (skill: unknown): string | null => {
      if (typeof skill !== "string") return null;
      const trimmed = skill.trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) return null;
      seen.add(trimmed.toLowerCase());
      skills.push(trimmed);
      return trimmed;
    };
    for (const group of result.skillGroups as unknown[]) {
      if (!isPlainObject(group) || !Array.isArray(group.items)) continue;
      const items = group.items.map(take).filter((s): s is string => s !== null);
      if (items.length) groups.push({ category: typeof group.category === "string" ? group.category : "", items });
    }
    const ungrouped = Array.isArray(result.skills)
      ? (result.skills as unknown[]).map(take).filter((s): s is string => s !== null)
      : [];
    if (ungrouped.length) groups.push({ category: "Other", items: ungrouped });
    result.skillGroups = groups;
    result.skills = skills;
  }

  return result as T;
}
