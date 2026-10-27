import { describe, expect, it } from "vitest";
import { PERMISSIONS, isAdminRole, permissionsFor, roleHasPermission } from "../../src/services/admin/permissions";
import { actionUrlSchema, audienceSchema } from "../../src/services/notification.service";
import { DEFAULT_SETTINGS, SETTING_SCHEMAS } from "../../src/services/settings.service";
import { escapeHtml, announcementEmail } from "../../src/services/email/templates";

describe("permissions", () => {
  it("gives admins every permission and users none", () => {
    for (const p of PERMISSIONS) {
      expect(roleHasPermission("ADMIN", p)).toBe(true);
      expect(roleHasPermission("USER", p)).toBe(false);
    }
  });
  it("denies unknown or missing roles", () => {
    expect(roleHasPermission("admin", "users:read")).toBe(false);
    expect(roleHasPermission("SUPERADMIN", "users:read")).toBe(false);
    expect(roleHasPermission(undefined, "users:read")).toBe(false);
    expect(permissionsFor("nope")).toEqual([]);
    expect(isAdminRole("ADMIN")).toBe(true);
    expect(isAdminRole("USER")).toBe(false);
  });
});

describe("notification validation", () => {
  it("accepts app paths and https links only", () => {
    expect(actionUrlSchema.safeParse("/dashboard/upgrade").success).toBe(true);
    expect(actionUrlSchema.safeParse("https://gomoxie.app/blog").success).toBe(true);
    expect(actionUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(actionUrlSchema.safeParse("//evil.example").success).toBe(false);
    expect(actionUrlSchema.safeParse("http://insecure.example").success).toBe(false);
    expect(actionUrlSchema.safeParse("data:text/html,hi").success).toBe(false);
  });
  it("validates audiences", () => {
    expect(audienceSchema.safeParse({ type: "new", days: 7 }).success).toBe(true);
    expect(audienceSchema.safeParse({ type: "new", days: 0 }).success).toBe(false);
    expect(audienceSchema.safeParse({ type: "users", userIds: [] }).success).toBe(false);
    expect(audienceSchema.safeParse({ type: "everyone" }).success).toBe(false);
  });
});

describe("settings validation", () => {
  it("rejects unsafe limit values", () => {
    const limits = SETTING_SCHEMAS.limits;
    const ok = { aiRequestsPerMinute: 8, aiRequestsPerDay: 150 };
    expect(limits.safeParse(ok).success).toBe(true);
    expect(limits.safeParse({ ...ok, aiRequestsPerMinute: 0 }).success).toBe(false);
  });
  it("rejects unsafe plan values", () => {
    const plans = SETTING_SCHEMAS.plans;
    const ok = DEFAULT_SETTINGS.plans;
    expect(plans.safeParse(ok).success).toBe(true);
    expect(plans.safeParse({ ...ok, free: { generations: -1, unpaidCvCap: 3 } }).success).toBe(false);
    expect(plans.safeParse({ ...ok, free: { generations: 1.5, unpaidCvCap: 3 } }).success).toBe(false);
    expect(plans.safeParse({ ...ok, lifetimeOffer: { ...ok.lifetimeOffer, display: "banner" } }).success).toBe(false);
    expect(plans.safeParse({ ...ok, lifetimeOffer: { ...ok.lifetimeOffer, endsAt: "2026-12-31T00:00:00.000Z" } }).success).toBe(true);
  });
  it("only accepts known feature rules", () => {
    expect(SETTING_SCHEMAS.features.safeParse({ careerProfiles: "pro", polishSummary: "all", cvImport: "beta" }).success).toBe(true);
    expect(SETTING_SCHEMAS.features.safeParse({ careerProfiles: "everyone", polishSummary: "all", cvImport: "all" }).success).toBe(false);
  });
});

describe("email templates", () => {
  it("escapes admin-written text", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
    const email = announcementEmail({ title: "<b>Hi</b>", body: "<img src=x onerror=alert(1)>", unsubscribeUrl: "https://x/u" });
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<b>Hi</b>");
    expect(email.html).toContain("Unsubscribe");
  });
});
