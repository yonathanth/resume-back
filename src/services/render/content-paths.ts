/**
 * Editor preview only: every piece of CV text carries its place in the
 * content ("experience.0.role", "personal.email", "skillGroups.1.items.2"),
 * so a click anywhere on the preview can open that exact field in the
 * editor. Like the missing-detail placeholders, values are wrapped in
 * private-use markers that travel through any template untouched, and
 * markPreviewSpans() turns them into <span data-cv="path">. The spans carry
 * no styling, so the preview still looks exactly like the PDF.
 */

export const PATH_OPEN = "";
export const PATH_SEP = "";
export const PATH_CLOSE = "";

type Content = Record<string, unknown>;

// Values that end up in attributes or are reformatted as addresses — never tagged.
const UNTAGGED_KEYS = new Set(["url", "photo"]);

const tag = (path: string, value: string) => `${PATH_OPEN}${path}${PATH_SEP}${value}${PATH_CLOSE}`;

function tagValue(value: unknown, path: string, key: string): unknown {
  if (typeof value === "string") return value.trim() && !UNTAGGED_KEYS.has(key) ? tag(path, value) : value;
  if (Array.isArray(value)) return value.map((item, i) => tagValue(item, `${path}.${i}`, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Content).map(([k, v]) => [k, tagValue(v, `${path}.${k}`, k)]));
  }
  return value;
}

/** `content` with every text value tagged with its path. */
export function tagContentPaths(content: Content): Content {
  return Object.fromEntries(Object.entries(content).map(([key, value]) => [key, tagValue(value, key, key)]));
}

const SINGLE_TAG = new RegExp(`^${PATH_OPEN}([\\w.]+)${PATH_SEP}([\\s\\S]*)${PATH_CLOSE}$`);
const ANY_TAG = new RegExp(`${PATH_OPEN}[\\w.]+${PATH_SEP}|${PATH_CLOSE}`, "g");

/** The text without path tags — for comparisons and pattern checks. */
export function stripPathTags(value: string): string {
  return value.replace(ANY_TAG, "");
}

/**
 * Applies a text transform (date formatting, splitting a name) to a tagged
 * value's inner text and re-tags each result, so helpers keep working on
 * tagged content exactly as on plain content.
 */
export function mapTagged(value: string, fn: (inner: string) => string): string {
  const match = value.trim().match(SINGLE_TAG);
  return match ? tag(match[1], fn(match[2])) : fn(value);
}

export const PATH_MARKED = new RegExp(`${PATH_OPEN}([\\w.]+)${PATH_SEP}([^${PATH_CLOSE}]*)${PATH_CLOSE}`, "g");
