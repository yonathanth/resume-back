// The admin's Insights page: how new accounts get to a finished CV, and what
// people tell us. Pure aggregation here (unit-tested); the queries live in
// routes/admin/insights.routes.ts.

export interface CohortRow {
  id: string;
  createdAt: Date;
  verified: boolean;
  onboarded: boolean;
  signupIntent: string | null;
  careerStage: string | null;
  acquisitionSource: string | null;
  signupSurface: string | null;
  signupAttribution: unknown;
  hasCv: boolean;
  downloaded: boolean;
  returned: boolean;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** Users who could have reached this step (the "returned" step only counts accounts old enough). */
  of: number;
}

export interface SegmentRow {
  value: string;
  users: number;
  onboarded: number;
  firstCv: number;
  downloaded: number;
  pro: number;
}

export interface CountRow {
  value: string;
  count: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Came back within 7 days" needs a full week (plus the signup day) to have passed. */
export const RETENTION_ELIGIBLE_AFTER_MS = 8 * DAY_MS;

export function buildFunnel(rows: CohortRow[], proIds: Set<string>, now: Date): FunnelStep[] {
  const total = rows.length;
  const oldEnough = rows.filter((r) => now.getTime() - r.createdAt.getTime() >= RETENTION_ELIGIBLE_AFTER_MS);
  return [
    { key: "signed_up", label: "Signed up", count: total, of: total },
    { key: "verified", label: "Confirmed their email", count: rows.filter((r) => r.verified).length, of: total },
    { key: "onboarded", label: "Finished onboarding", count: rows.filter((r) => r.onboarded).length, of: total },
    { key: "first_cv", label: "Made a first CV", count: rows.filter((r) => r.hasCv).length, of: total },
    { key: "downloaded", label: "Downloaded a PDF", count: rows.filter((r) => r.downloaded).length, of: total },
    { key: "returned", label: "Came back within 7 days", count: oldEnough.filter((r) => r.returned).length, of: oldEnough.length },
    { key: "pro", label: "On Pro now", count: rows.filter((r) => proIds.has(r.id)).length, of: total },
  ];
}

/** Activation split by one onboarding answer. Unanswered rows are grouped as "unknown". */
export function buildSegments(
  rows: CohortRow[],
  proIds: Set<string>,
  pick: (row: CohortRow) => string | null
): SegmentRow[] {
  const groups = new Map<string, SegmentRow>();
  for (const row of rows) {
    const value = pick(row) ?? "unknown";
    const group = groups.get(value) ?? { value, users: 0, onboarded: 0, firstCv: 0, downloaded: 0, pro: 0 };
    group.users++;
    if (row.onboarded) group.onboarded++;
    if (row.hasCv) group.firstCv++;
    if (row.downloaded) group.downloaded++;
    if (proIds.has(row.id)) group.pro++;
    groups.set(value, group);
  }
  // Biggest first; "unknown" last so the real answers lead.
  return [...groups.values()].sort((a, b) => (a.value === "unknown" ? 1 : b.value === "unknown" ? -1 : b.users - a.users));
}

function attributionField(attribution: unknown, field: string): string | null {
  if (!attribution || typeof attribution !== "object") return null;
  const value = (attribution as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

/** The most common values of one first-touch attribution field, among accounts that have it. */
export function topAttribution(rows: CohortRow[], field: string, limit = 8): CountRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = attributionField(row.signupAttribution, field);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

export function ratingSummary(ratings: { rating: number | null }[]) {
  const distribution = [0, 0, 0, 0, 0];
  let sum = 0;
  let count = 0;
  for (const { rating } of ratings) {
    if (rating === null || rating < 1 || rating > 5) continue;
    distribution[rating - 1]++;
    sum += rating;
    count++;
  }
  return { count, average: count ? Math.round((sum / count) * 100) / 100 : null, distribution };
}
