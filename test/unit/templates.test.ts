import { describe, expect, it } from "vitest";
import { CV_TEMPLATE_REGISTRY, DEFAULT_CV_TEMPLATE_ID, TEMPLATE_DISPLAY_ORDER, templatesInDisplayOrder } from "../../src/config/cv-templates";
import { SAMPLE_TEMPLATE_IDS, sampleCvFor } from "../../src/config/sample-cv";

const ids = Object.keys(CV_TEMPLATE_REGISTRY);

describe("template gallery order", () => {
  it("lists every template exactly once", () => {
    expect([...TEMPLATE_DISPLAY_ORDER].sort()).toEqual([...ids].sort());
  });

  it("puts the default template first", () => {
    expect(templatesInDisplayOrder()[0].id).toBe(DEFAULT_CV_TEMPLATE_ID);
  });
});

describe("template samples", () => {
  it("gives every template its own sample", () => {
    expect([...SAMPLE_TEMPLATE_IDS].sort()).toEqual([...ids].sort());
  });

  it("never shows the same character on two templates", () => {
    const names = ids.map((id) => sampleCvFor(id).personal.full_name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("fills in the character's own initials for {me} placeholders", () => {
    const sample = sampleCvFor("scholar") as { publications: { authors: string }[] };
    expect(sample.publications[0].authors).toContain("V. Frankenstein");
    expect(JSON.stringify(sample)).not.toContain("{me}");
  });
});
