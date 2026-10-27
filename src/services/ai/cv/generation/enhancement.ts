export const DEFAULT_ENHANCEMENT_LEVEL = 0.5;

/**
 * Defensive clamp for callers that don't go through generateCVSchema's Zod
 * validation (which already enforces min 0 / max 1 / default 0.5 at the API
 * boundary). Never expand this to alter factual rules — see enhancement.rules.ts.
 */
export function normalizeEnhancementLevel(level?: number): number {
  if (typeof level !== "number" || Number.isNaN(level)) return DEFAULT_ENHANCEMENT_LEVEL;
  return Math.min(1, Math.max(0, level));
}
