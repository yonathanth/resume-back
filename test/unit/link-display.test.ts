import { describe, expect, it } from "vitest";
import { CV_TEMPLATE_REGISTRY } from "../../src/config/cv-templates";
import { renderCvHtml } from "../../src/services/render.service";

// "Show on CV as": a link shown as its label carries the link-embedded class
// (blue, underlined) in every template; the address-only form never does.
const contentWith = (display: "url" | "label") => ({
  personal: {
    full_name: "Sam Rivera",
    title: "Backend Engineer",
    email: "sam@example.com",
    links: [{ label: "GitHub", url: "https://github.com/samr", display }],
  },
  experience: [],
  education: [],
  skills: [],
});

const opts = { mode: "preview" as const, fontBaseUrl: "http://localhost/fonts" };

describe("link display", () => {
  for (const templateId of Object.keys(CV_TEMPLATE_REGISTRY)) {
    it(`${templateId}: shows a label link as a styled link, and the address plainly`, async () => {
      const asLabel = await renderCvHtml(contentWith("label"), templateId, opts);
      const asUrl = await renderCvHtml(contentWith("url"), templateId, opts);
      // Not every template prints links; those that do must honor the choice.
      if (!asUrl.includes("github.com/samr")) return;
      // In the preview the label is wrapped in its click-to-edit span.
      expect(asLabel).toMatch(/class="[^"]*link-embedded[^"]*"[^>]*>(<span[^>]*>)?GitHub</);
      expect(asLabel).not.toMatch(/>github\.com\/samr</);
      expect(asUrl).not.toMatch(/<a [^>]*link-embedded/);
    });
  }
});
