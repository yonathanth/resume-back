import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { runImportExtraction } from "../../src/services/importExtraction.service";
import { extractPdfText } from "../../src/services/import/pdf";
import { extractDocxText } from "../../src/services/import/docx";
import { guessEmail, guessExtractedData, guessName, guessPhone, guessLinks } from "../../src/services/import/heuristics";
import { normalizeText } from "../../src/services/import/text";

// ---------------------------------------------------------------------------
// Fixture builders. Files are built in memory so each test shows exactly the
// layout it exercises. OCR output isn't asserted on: it needs Tesseract's
// language data (a network download on first run) and takes seconds per
// page. (The near-empty-PDF test does run OCR on its blank page.)

type PdfLine = [x: number, y: number, size: number, text: string];
type PdfLink = [rect: [number, number, number, number], uri: string];

/** A one-page PDF that draws each line in the order given — like generators that draw straight across columns. */
function buildPdf(lines: PdfLine[], links: PdfLink[] = []): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = lines.map(([x, y, size, t]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join("\n");
  const annotRefs = links.map((_, i) => `${6 + i} 0 R`).join(" ");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [${annotRefs}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    ...links.map(([rect, uri]) => `<< /Type /Annot /Subtype /Link /Rect [${rect.join(" ")}] /A << /S /URI /URI (${uri}) >> >>`),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml"';
const p = (t: string, pPr = "") => `<w:p>${pPr}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const li = (t: string) => p(t, '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>');
const tc = (inner: string) => `<w:tc>${inner}</w:tc>`;

async function buildDocx(body: string, opts: { header?: string; rels?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const headerRel = opts.header
    ? '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
    : "";
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${headerRel}${opts.rels ?? ""}</Relationships>`
  );
  zip.file("word/document.xml", `<w:document ${W_NS}><w:body>${body}</w:body></w:document>`);
  if (opts.header) zip.file("word/header1.xml", `<w:hdr ${W_NS}>${opts.header}</w:hdr>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const lineIndex = (text: string, needle: string) => text.split("\n").findIndex((line) => line.includes(needle));

// ---------------------------------------------------------------------------

describe("PDF reading order", () => {
  // Sidebar at x=40, main column at x=220, drawn row by row across both.
  const sidebar = ["CONTACT", "marta.k@example.org", "+44 20 7946 0958", "LinkedIn", "", "SKILLS", "Figma", "User research", "Prototyping", "Design systems", "", "LANGUAGES", "English - Fluent", "Amharic - Native"];
  const main = ["PROFILE", "Product designer with 6 years of experience shaping fintech and", "health products from research through to shipped interfaces.", "", "EXPERIENCE", "Senior Product Designer, Monzo Bank", "Led redesign of the savings flow, lifting goal completion.", "Built the shared component library used by 40 designers.", "Product Designer, Babylon Health", "Designed symptom checker screens used by 2 million patients."];
  const lines: PdfLine[] = [
    [40, 790, 22, "MARTA KEBEDE"],
    [40, 770, 12, "Product Designer"],
  ];
  sidebar.forEach((t, i) => {
    if (t) lines.push([40, 730 - i * 16, 10, t]);
    if (main[i]) lines.push([220, 730 - i * 16, 10, main[i]]);
  });
  lines.push([485, 730 - 5 * 16, 10, "2021 - Present"], [500, 730 - 8 * 16, 10, "2018 - 2021"]);
  // Full-width section underneath, with right-aligned dates.
  lines.push(
    [40, 480, 12, "EDUCATION"],
    [40, 462, 10, "MA Interaction Design, Royal College of Art"],
    [500, 462, 10, "2016 - 2018"],
    [40, 446, 10, "BA Graphic Design, Addis Ababa University"],
    [500, 446, 10, "2011 - 2015"],
    [40, 430, 10, "Certificate in UX Research, Nielsen Norman Group"],
    [500, 430, 10, "2019 - 2019"]
  );
  const pdf = buildPdf(lines, [
    [[38, 730 - 3 * 16 - 3, 90, 730 - 3 * 16 + 10], "https://www.linkedin.com/in/martakebede"],
    [[500, 780, 520, 800], "https://dribbble.com/marta"],
  ]);

  it("reads a sidebar column before the main column instead of interleaving them", async () => {
    const { text } = await extractPdfText(pdf);
    const sidebarLines = sidebar.filter(Boolean).map((t) => lineIndex(text, t));
    // Contiguous, in order, and all before the main column starts.
    sidebarLines.forEach((idx, k) => k > 0 && expect(idx).toBeGreaterThan(sidebarLines[k - 1]));
    expect(lineIndex(text, "PROFILE")).toBeGreaterThan(lineIndex(text, "Amharic - Native"));
    expect(text).toContain("Product designer with 6 years of experience shaping fintech and\nhealth products");
  });

  it("keeps right-aligned dates on their job and degree lines", async () => {
    const { text } = await extractPdfText(pdf);
    expect(text).toMatch(/Senior Product Designer, Monzo Bank +2021 - Present/);
    expect(text).toMatch(/Product Designer, Babylon Health +2018 - 2021/);
    expect(text).toMatch(/MA Interaction Design, Royal College of Art +2016 - 2018/);
    expect(text).toMatch(/BA Graphic Design, Addis Ababa University +2011 - 2015/);
  });

  it("puts a full-width heading after the columns, with its own section", async () => {
    const { text } = await extractPdfText(pdf);
    const education = lineIndex(text, "EDUCATION");
    expect(education).toBeGreaterThan(lineIndex(text, "Designed symptom checker"));
    expect(education).toBe(lineIndex(text, "MA Interaction Design") - 1);
  });

  it("keeps link targets: inline after linked text, and icon-only links at the end", async () => {
    const { text } = await extractPdfText(pdf);
    expect(text).toContain("LinkedIn (https://www.linkedin.com/in/martakebede)");
    expect(text.trim().endsWith("https://dribbble.com/marta")).toBe(true);
  });

  it("rejects files that aren't PDFs with a readable error", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf"))).rejects.toThrow(/could not be opened/);
  });
});

describe("DOCX extraction", () => {
  const textBox = (t: string) =>
    `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p(t)}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${p(t)}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;

  it("reads headers (where Word templates put contact details) before the body", async () => {
    const docx = await buildDocx(p("Senior DevOps Engineer"), {
      header: `${p("Samuel Tesfaye")}<w:p><w:r><w:t>samuel@example.com</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>+251 91 234 5678</w:t></w:r></w:p>`,
    });
    const text = await extractDocxText(docx);
    expect(text.split("\n").slice(0, 3)).toEqual(["Samuel Tesfaye", "samuel@example.com   +251 91 234 5678", ""]);
    expect(text).toContain("Senior DevOps Engineer");
  });

  it("keeps hyperlink targets, from relationships and from HYPERLINK fields", async () => {
    const docx = await buildDocx(
      `<w:p><w:hyperlink r:id="rIdL1"><w:r><w:t>LinkedIn</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> | </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://github.com/samtes" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>GitHub</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
        `<w:p><w:hyperlink r:id="rIdL2"><w:r><w:t>me@example.com</w:t></w:r></w:hyperlink></w:p>`,
      {
        rels:
          '<Relationship Id="rIdL1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.linkedin.com/in/samueltesfaye" TargetMode="External"/>' +
          '<Relationship Id="rIdL2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:me@example.com" TargetMode="External"/>',
      }
    );
    const text = await extractDocxText(docx);
    expect(text).toContain("LinkedIn (https://www.linkedin.com/in/samueltesfaye) | GitHub (https://github.com/samtes)");
    // Visible text already shows the target — nothing appended.
    expect(text).toContain("me@example.com");
    expect(text).not.toContain("(me@example.com)");
  });

  it("reads a text box once, not once per Word fallback copy", async () => {
    const text = await extractDocxText(await buildDocx(p("Intro") + textBox("Certified Kubernetes Administrator (CKA), 2023")));
    expect(text.match(/Certified Kubernetes Administrator/g)).toHaveLength(1);
  });

  it("reads layout tables cell by cell and data tables row by row", async () => {
    const layout = `<w:tbl><w:tr>${tc(p("SKILLS") + p("Terraform") + p("AWS"))}${tc(p("EXPERIENCE") + `<w:p><w:r><w:t>DevOps Engineer, Safaricom</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2022 – Present</w:t></w:r></w:p>` + li("Cut deploy time from 40 to 6 minutes."))}</w:tr></w:tbl>`;
    const data = `<w:tbl><w:tr>${tc(p("Amharic"))}${tc(p("Native"))}</w:tr><w:tr>${tc(p("English"))}${tc(p("Fluent"))}</w:tr></w:tbl>`;
    const text = await extractDocxText(await buildDocx(layout + data));
    expect(text).toContain("SKILLS\nTerraform\nAWS\n\nEXPERIENCE\nDevOps Engineer, Safaricom   2022 – Present\n• Cut deploy time");
    expect(text).toContain("Amharic | Native\nEnglish | Fluent");
  });

  it("leaves out tracked deletions", async () => {
    const text = await extractDocxText(
      await buildDocx(p("Kept text") + `<w:p><w:del><w:r><w:delText>DELETED</w:delText></w:r></w:del></w:p>`)
    );
    expect(text).toBe("Kept text");
  });

  it("rejects files that aren't Word documents with a readable error", async () => {
    await expect(extractDocxText(Buffer.from("not a zip"))).rejects.toThrow(/could not be opened/);
  });
});

describe("contact heuristics", () => {
  it("finds international and national phone numbers but not year ranges", () => {
    expect(guessPhone("Phone: +44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(guessPhone("tel +251-91-123-4567")).toBe("+251-91-123-4567");
    expect(guessPhone("(415) 555-2671")).toBe("(415) 555-2671");
    expect(guessPhone("Mobile 0911 234 567")).toBe("0911 234 567");
    expect(guessPhone("Acme 2018 - 2022\nBeta 2016 – 2018")).toBeUndefined();
  });

  it("ignores referees' contact details", () => {
    const text = "Jane Roe\nSummary text here\n\nREFERENCES\nJohn Doe, john@corp.com, +44 20 7946 0000";
    expect(guessEmail(text)).toBeUndefined();
    expect(guessPhone(text)).toBeUndefined();
  });

  it("guesses names in any script and case, but not headings or job titles", () => {
    expect(guessName("José Müller-Ångström\nSenior Engineer")).toBe("José Müller-Ångström");
    expect(guessName("MARTA KEBEDE\nProduct Designer")).toBe("Marta Kebede");
    expect(guessName("Curriculum Vitae\nLudwig van Beethoven")).toBe("Ludwig van Beethoven");
    expect(guessName("Senior Software Engineer\nfoo@bar.com")).toBeUndefined();
  });

  it("collects profile links, and other URLs only from the contact area", () => {
    const text = ["Jane Roe", "linkedin.com/in/janeroe", "https://janeroe.dev", ...Array(30).fill("filler"), "Worked at https://acme.com", "github.com/janeroe."].join("\n");
    expect(guessLinks(text)).toEqual([
      { label: "LinkedIn", url: "https://linkedin.com/in/janeroe" },
      { label: "Website", url: "https://janeroe.dev" },
      { label: "GitHub", url: "https://github.com/janeroe" },
    ]);
  });

  it("leaves out fields OCR read with low confidence", () => {
    const text = "Jose Muller\njose muller@example.cam\n+251 91 123 4567";
    expect(guessExtractedData(text, ["muller@example.cam"])).toEqual({
      personal: { full_name: "Jose Muller", phone: "+251 91 123 4567" },
    });
  });
});

describe("text cleanup", () => {
  it("turns symbol-font bullets into real ones and tidies whitespace", () => {
    expect(normalizeText(" Built things  \r\n\r\n\r\n\r\nNext line")).toBe("• Built things\n\nNext line");
  });
});

describe("runImportExtraction", () => {
  it("fails a file with almost no text instead of passing it on to the AI", async () => {
    await expect(runImportExtraction(buildPdf([[40, 800, 10, "Hi"]]), "pdf")).rejects.toThrow(/readable text/);
  });

  it("returns the text and the contact guesses", async () => {
    const pdf = buildPdf([
      [40, 800, 20, "Jane Roe"],
      [40, 780, 10, "jane.roe@example.com | +44 20 7946 0958"],
      [40, 760, 10, "Backend engineer with eight years of experience building payment systems."],
    ]);
    const { rawText, extractedData } = await runImportExtraction(pdf, "pdf");
    expect(rawText).toContain("Backend engineer with eight years");
    expect(extractedData).toEqual({
      personal: { full_name: "Jane Roe", email: "jane.roe@example.com", phone: "+44 20 7946 0958" },
    });
  });
});
