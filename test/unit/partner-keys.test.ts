import { describe, expect, it } from "vitest";
import { parsePartnerKeys, partnerFor } from "../../src/routes/partner.routes";

describe("partner keys", () => {
  const keys = parsePartnerKeys("ethiojobs:0123456789abcdef0123, short:abc, bad, :nokey0123456789abcdef");
  it("parses name:secret pairs and ignores short or malformed ones", () => {
    expect([...keys.keys()]).toEqual(["ethiojobs"]);
  });
  it("matches only the exact secret", () => {
    expect(partnerFor("0123456789abcdef0123", keys)).toBe("ethiojobs");
    expect(partnerFor("0123456789abcdef012X", keys)).toBeNull();
    expect(partnerFor(undefined, keys)).toBeNull();
    expect(partnerFor("", keys)).toBeNull();
  });
});
