import { describe, expect, it } from "vitest";
import { detailsFromCvContent, hasEssentialDetails, missingDetailsFrom } from "../../src/services/onboarding.service";
import { ANONYMOUS_CLIENT_EVENTS, parseClientEvent, utcDay } from "../../src/services/events.service";
import { feedbackSchema } from "../../src/services/feedback.service";
import {
  RETENTION_ELIGIBLE_AFTER_MS,
  buildFunnel,
  buildSegments,
  ratingSummary,
  topAttribution,
  type CohortRow,
} from "../../src/services/admin/insights.service";
import { signupAttributionSchema } from "../../src/schemas/onboarding.schema";
import { deleteAccountSchema, onboardingFromCvSchema, updateProfileSchema } from "../../src/schemas/auth.schema";
import { DEFAULT_SETTINGS, SETTING_SCHEMAS } from "../../src/services/settings.service";
import { downloadReminderEmail, firstCvNudgeEmail, welcomeEmail } from "../../src/services/email/templates";

describe("account details from a CV", () => {
  it("splits the name, keeps a valid phone and the headline as profession", () => {
    expect(
      detailsFromCvContent({ personal: { full_name: "  abebe   KEBEDE tesfaye ", phone: "+251 91 234 5678", title: "Data Analyst" } })
    ).toEqual({ firstName: "Abebe", lastName: "Kebede Tesfaye", phone: "+251 91 234 5678", occupationTitle: "Data Analyst" });
  });

  it("leaves out what it can't trust", () => {
    expect(detailsFromCvContent({ personal: { full_name: "Madonna", phone: "call me maybe", title: "" } })).toEqual({ firstName: "Madonna" });
    expect(detailsFromCvContent({ personal: { phone: "---" } })).toEqual({});
    expect(detailsFromCvContent(null)).toEqual({});
    expect(detailsFromCvContent({ personal: { title: "x".repeat(101) } })).toEqual({});
  });

  it("only fills fields the account doesn't have yet", () => {
    const current = { firstName: "Sara", lastName: null, phone: "0911", occupationTitle: null };
    expect(missingDetailsFrom(current, { firstName: "Other", lastName: "Bekele", phone: "+1 555", occupationTitle: "Nurse" })).toEqual({
      lastName: "Bekele",
      occupationTitle: "Nurse",
    });
  });

  it("needs a full name and a profession to finish onboarding", () => {
    expect(hasEssentialDetails({ firstName: "A", lastName: "B", phone: null, occupationTitle: "Nurse" })).toBe(true);
    expect(hasEssentialDetails({ firstName: "A", lastName: null, phone: null, occupationTitle: "Nurse" })).toBe(false);
    expect(hasEssentialDetails({ firstName: "A", lastName: "B", phone: null, occupationTitle: null })).toBe(false);
  });
});

describe("client events", () => {
  it("accepts allow-listed events with their exact props", () => {
    expect(parseClientEvent("onboarding_step_viewed", { step: "intent" })).toEqual({
      ok: true,
      name: "onboarding_step_viewed",
      props: { step: "intent" },
    });
    expect(parseClientEvent("try_started", { flow: "tailor" }).ok).toBe(true);
  });

  it("refuses unknown events and extra or wrong props", () => {
    expect(parseClientEvent("pdf_downloaded", {}).ok).toBe(false); // server-only milestone
    expect(parseClientEvent("try_started", { flow: "hack" }).ok).toBe(false);
    expect(parseClientEvent("onboarding_step_viewed", { step: "intent", email: "a@b.c" }).ok).toBe(false);
    expect(parseClientEvent("__proto__", {}).ok).toBe(false);
  });

  it("lets only /try events through without an account", () => {
    expect([...ANONYMOUS_CLIENT_EVENTS].sort()).toEqual(["try_signup_prompted", "try_started"]);
  });

  it("buckets activity by UTC day", () => {
    expect(utcDay(new Date("2026-10-16T23:30:00-05:00"))).toBe("2026-10-17");
  });
});

describe("feedback validation", () => {
  const cv = "8f14e45f-ceea-4e7a-9a1b-3c2d1e0f9a8b";
  it("takes a 1–5 CV rating", () => {
    expect(feedbackSchema.safeParse({ kind: "cv_rating", rating: 5 }).success).toBe(true);
    expect(feedbackSchema.safeParse({ kind: "cv_rating", rating: 0 }).success).toBe(false);
    expect(feedbackSchema.safeParse({ kind: "cv_rating", rating: 3.5 }).success).toBe(false);
    expect(feedbackSchema.safeParse({ kind: "cv_rating", rating: 4, trigger: "download" }).success).toBe(true);
    expect(feedbackSchema.safeParse({ kind: "cv_rating", rating: 4, trigger: "later" }).success).toBe(false);
  });
  it("takes thumbs on an AI draft, tied to a CV", () => {
    expect(feedbackSchema.safeParse({ kind: "ai_draft", rating: -1, reason: "too_generic", cvDocumentId: cv }).success).toBe(true);
    expect(feedbackSchema.safeParse({ kind: "ai_draft", rating: 1 }).success).toBe(false);
    expect(feedbackSchema.safeParse({ kind: "ai_draft", rating: 2, cvDocumentId: cv }).success).toBe(false);
    expect(feedbackSchema.safeParse({ kind: "ai_draft", rating: 1, reason: "made_up", cvDocumentId: cv }).success).toBe(false);
  });
  it("never takes an account_deletion from the public endpoint", () => {
    expect(feedbackSchema.safeParse({ kind: "account_deletion", rating: 1 }).success).toBe(false);
  });
});

describe("onboarding input", () => {
  it("accepts the onboarding answers and rejects made-up ones", () => {
    expect(updateProfileSchema.safeParse({ signupIntent: "improve", careerStage: "career_change", acquisitionSource: "telegram" }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ careerStage: null, acquisitionSource: null }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ signupIntent: "hire" }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ acquisitionDetail: "x".repeat(121) }).success).toBe(false);
  });

  it("keeps only known, short attribution fields", () => {
    const parsed = signupAttributionSchema.parse({ utmSource: "telegram", referrer: "t.me", password: "nope" });
    expect(parsed).toEqual({ utmSource: "telegram", referrer: "t.me" });
    expect(signupAttributionSchema.safeParse({ utmSource: "x".repeat(201) }).success).toBe(false);
  });

  it("validates the from-CV request and the deletion reason", () => {
    expect(onboardingFromCvSchema.safeParse({ cvDocumentId: "not-a-uuid", flow: "create", surface: "try" }).success).toBe(false);
    expect(deleteAccountSchema.safeParse({ password: "x", reason: "got_the_job" }).success).toBe(true);
    expect(deleteAccountSchema.safeParse({ password: "x", reason: "because" }).success).toBe(false);
  });
});

describe("lifecycle emails", () => {
  it("are off unless an admin turns them on", () => {
    expect(DEFAULT_SETTINGS.lifecycleEmails.enabled).toBe(false);
    expect(SETTING_SCHEMAS.lifecycleEmails.safeParse({ enabled: true }).success).toBe(true);
    expect(SETTING_SCHEMAS.lifecycleEmails.safeParse({}).success).toBe(false);
  });

  it("carry an unsubscribe link and escape what they insert", () => {
    const unsubscribe = "https://app.example/unsubscribe?u=1&t=2";
    const welcome = welcomeEmail({ firstName: "<b>Sam</b>", intent: "tailor", actionUrl: "https://app.example/go/tailor", unsubscribeUrl: unsubscribe });
    expect(welcome.html).toContain("&lt;b&gt;Sam&lt;/b&gt;");
    expect(welcome.html).not.toContain("<b>Sam</b>");
    expect(welcome.html).toContain("Tailor my CV");
    expect(welcome.text).toContain(unsubscribe);

    const nudge = firstCvNudgeEmail({ firstName: null, actionUrl: "https://app.example/go/create", unsubscribeUrl: unsubscribe });
    expect(nudge.text.startsWith("Hi,")).toBe(true);

    const reminder = downloadReminderEmail({ firstName: "Sam", cvTitle: 'Nurse "CV"', actionUrl: "https://app.example/dashboard/editor/1", unsubscribeUrl: unsubscribe });
    expect(reminder.html).toContain("&quot;Nurse &quot;CV&quot;&quot;");
    expect(reminder.html).toContain(unsubscribe.replace("&", "&amp;"));
  });
});

describe("insights aggregation", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const row = (overrides: Partial<CohortRow>): CohortRow => ({
    id: Math.random().toString(36).slice(2),
    createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
    verified: true,
    onboarded: true,
    signupIntent: null,
    careerStage: null,
    acquisitionSource: null,
    signupSurface: null,
    signupAttribution: null,
    hasCv: false,
    downloaded: false,
    returned: false,
    ...overrides,
  });

  it("counts each funnel step over the whole cohort, and retention only over accounts a week old", () => {
    const fresh = row({ id: "fresh", createdAt: new Date(now.getTime() - RETENTION_ELIGIBLE_AFTER_MS + 1000), returned: true });
    const rows = [
      row({ id: "a", hasCv: true, downloaded: true, returned: true }),
      row({ id: "b", hasCv: true }),
      row({ id: "c", verified: false, onboarded: false }),
      fresh,
    ];
    const funnel = Object.fromEntries(buildFunnel(rows, new Set(["a"]), now).map((s) => [s.key, s]));
    expect(funnel.signed_up.count).toBe(4);
    expect(funnel.verified.count).toBe(3);
    expect(funnel.first_cv.count).toBe(2);
    expect(funnel.downloaded.count).toBe(1);
    expect(funnel.returned).toMatchObject({ count: 1, of: 3 });
    expect(funnel.pro.count).toBe(1);
  });

  it("splits activation by an answer, unanswered last", () => {
    const rows = [
      row({ id: "1", signupIntent: "improve", hasCv: true }),
      row({ id: "2", signupIntent: "improve" }),
      row({ id: "3", signupIntent: null }),
      row({ id: "4", signupIntent: null }),
      row({ id: "5", signupIntent: null }),
      row({ id: "6", signupIntent: "create", downloaded: true }),
    ];
    const segments = buildSegments(rows, new Set(["6"]), (r) => r.signupIntent);
    expect(segments.map((s) => s.value)).toEqual(["improve", "create", "unknown"]);
    expect(segments[0]).toMatchObject({ users: 2, firstCv: 1 });
    expect(segments[1]).toMatchObject({ users: 1, downloaded: 1, pro: 1 });
  });

  it("ranks first-touch attribution, case-insensitively", () => {
    const rows = [
      row({ signupAttribution: { utmSource: "Telegram" } }),
      row({ signupAttribution: { utmSource: "telegram" } }),
      row({ signupAttribution: { utmSource: "google" } }),
      row({ signupAttribution: null }),
      row({ signupAttribution: { utmSource: 42 } }),
    ];
    expect(topAttribution(rows, "utmSource")).toEqual([
      { value: "telegram", count: 2 },
      { value: "google", count: 1 },
    ]);
  });

  it("summarizes ratings", () => {
    expect(ratingSummary([{ rating: 5 }, { rating: 4 }, { rating: 4 }, { rating: null }, { rating: 9 }])).toEqual({
      count: 3,
      average: 4.33,
      distribution: [0, 0, 0, 2, 1],
    });
    expect(ratingSummary([]).average).toBeNull();
  });
});

describe("professions", () => {
  it("trims, drops duplicates and blanks, keeps order, caps at five", async () => {
    const { cleanProfessions } = await import("../../src/services/professions.service");
    expect(cleanProfessions(["  Nurse ", "nurse", "", "Data   Analyst", "A", "B", "C", "D"])).toEqual(["Nurse", "Data Analyst", "A", "B", "C"]);
    expect(cleanProfessions(["x".repeat(101), "Teacher"])).toEqual(["Teacher"]);
  });

  it("puts a new main profession first and keeps the rest", async () => {
    const { withMainProfession } = await import("../../src/services/professions.service");
    expect(withMainProfession("Designer", ["Developer", "designer", "Writer"])).toEqual(["Designer", "Developer", "Writer"]);
  });

  it("accepts up to five professions on the profile update", () => {
    expect(updateProfileSchema.safeParse({ professions: ["A", "B"] }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ professions: [] }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ professions: ["A", "B", "C", "D", "E", "F"] }).success).toBe(false);
  });
});
