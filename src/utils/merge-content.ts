export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fills in only fields that are currently empty; never overwrites data the user already entered. */
export function mergeEmptyFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    const existing = result[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = mergeEmptyFields(existing, value);
    } else if (isEmptyValue(existing)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Recursively drops null, undefined, and blank-string values, then any object
 * or array left empty by that (e.g. an experience entry whose only fields were
 * ""). Array entries that become empty objects are removed too. The AI often
 * writes "unknown" as null or "" — in this app's schemas "unknown" means the
 * key is absent, so this normalizes AI output before it is validated.
 */
export function stripEmptyValues(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    return value
      .map(stripEmptyValues)
      .filter((item) => item !== undefined && !(isPlainObject(item) && Object.keys(item).length === 0));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const cleaned = stripEmptyValues(child);
      if (cleaned === undefined) continue;
      if (isPlainObject(cleaned) && Object.keys(cleaned).length === 0) continue;
      result[key] = cleaned;
    }
    return result;
  }
  return value ?? undefined;
}
