import JSZip from "jszip";
import mammoth from "mammoth";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { linkSuffix, normalizeText } from "./text";

/**
 * Reads the DOCX XML directly rather than through mammoth's raw text, which
 * drops what CVs rely on most: headers/footers (where many Word templates put
 * name, email and phone), hyperlink targets (a "LinkedIn" link is otherwise
 * just the word), and table layout (two-column CV templates are tables).
 */

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function isWordNs(el: Element): boolean {
  const ns = el.namespaceURI ?? "";
  return ns.endsWith("/wordprocessingml/2006/main") || ns.endsWith("/wordprocessingml/main");
}

function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

/** Word writes text boxes twice (modern shape + legacy VML fallback) — read only the first. */
function alternateContentChoice(el: Element): Element | undefined {
  return childElements(el).find((c) => c.localName === "Choice") ?? childElements(el).find((c) => c.localName === "Fallback");
}

interface Part {
  rels: Map<string, string>;
}

function relId(el: Element): string | null {
  return el.getAttributeNS(REL_NS, "id") || el.getAttribute("r:id");
}

function fieldHyperlink(instr: string): string | null {
  return instr.match(/HYPERLINK\s+"([^"]+)"/i)?.[1] ?? null;
}

/** One paragraph's text; text boxes found inside it are returned as extra blocks. */
function paragraph(p: Element, part: Part, textBoxes: Element[]): string {
  let text = "";
  const fieldLinks: string[] = [];

  const walk = (el: Element): void => {
    for (const child of childElements(el)) {
      const name = child.localName;
      if (name === "AlternateContent") {
        const choice = alternateContentChoice(child);
        if (choice) walk(choice);
        continue;
      }
      if (name === "txbxContent") {
        textBoxes.push(child);
        continue;
      }
      if (!isWordNs(child)) {
        walk(child);
        continue;
      }
      switch (name) {
        case "t":
          text += child.textContent ?? "";
          break;
        case "tab":
          text += "\t";
          break;
        case "br":
        case "cr":
          text += "\n";
          break;
        case "noBreakHyphen":
          text += "-";
          break;
        case "instrText": {
          const url = fieldHyperlink(child.textContent ?? "");
          if (url) fieldLinks.push(url);
          break;
        }
        case "fldSimple": {
          const url = fieldHyperlink(child.getAttributeNS(child.namespaceURI, "instr") || child.getAttribute("w:instr") || "");
          if (url) fieldLinks.push(url);
          walk(child);
          break;
        }
        case "hyperlink": {
          const before = text.length;
          walk(child);
          const id = relId(child);
          const url = id ? part.rels.get(id) : undefined;
          if (url) text += linkSuffix(text.slice(before), url);
          break;
        }
        // Deleted tracked changes, and formatting that carries no text.
        case "del":
        case "moveFrom":
        case "pPr":
        case "rPr":
          break;
        default:
          walk(child);
      }
    }
  };
  walk(p);

  for (const url of fieldLinks) text += linkSuffix(text, url);

  const pPr = childElements(p).find((c) => c.localName === "pPr");
  const isListItem = pPr ? childElements(pPr).some((c) => c.localName === "numPr") : false;
  // Tabs separate things like a job title and its dates.
  text = text.replace(/\t+/g, "   ");
  return isListItem && text.trim() ? `• ${text.trim()}` : text;
}

function table(tbl: Element, part: Part): string[] {
  const rows = childElements(tbl)
    .filter((c) => c.localName === "tr")
    .map((tr) =>
      childElements(tr)
        .filter((c) => c.localName === "tc")
        .map((tc) => blocks(tc, part).filter((line) => line.trim()))
    );

  // A table whose cells hold several paragraphs is page layout (a sidebar
  // template) — read it cell by cell. One line per cell is a real table
  // (skills and levels, say) — read it row by row.
  const isLayout = rows.some((cells) => cells.some((lines) => lines.length > 1));
  const out: string[] = [];
  for (const cells of rows) {
    if (isLayout) {
      for (const lines of cells) {
        if (!lines.length) continue;
        out.push(...lines, "");
      }
    } else {
      const line = cells
        .map((lines) => lines.join(" "))
        .filter(Boolean)
        .join(" | ");
      if (line) out.push(line);
    }
  }
  return out;
}

function blocks(container: Element, part: Part): string[] {
  const out: string[] = [];
  for (const child of childElements(container)) {
    const name = child.localName;
    if (name === "AlternateContent") {
      const choice = alternateContentChoice(child);
      if (choice) out.push(...blocks(choice, part));
    } else if (name === "p" && isWordNs(child)) {
      const textBoxes: Element[] = [];
      out.push(paragraph(child, part, textBoxes));
      for (const box of textBoxes) out.push("", ...blocks(box, part), "");
    } else if (name === "tbl" && isWordNs(child)) {
      out.push("", ...table(child, part), "");
    } else if (name === "sectPr") {
      continue;
    } else {
      out.push(...blocks(child, part));
    }
  }
  return out;
}

const parser = new DOMParser({ onError: () => undefined });

function parseXml(xml: string): Element | null {
  return parser.parseFromString(xml, "text/xml").documentElement ?? null;
}

async function readRels(zip: JSZip, partPath: string): Promise<{ links: Map<string, string>; headers: string[]; footers: string[] }> {
  const dir = partPath.slice(0, partPath.lastIndexOf("/") + 1);
  const relsPath = `${dir}_rels/${partPath.slice(dir.length)}.rels`;
  const links = new Map<string, string>();
  const headers: string[] = [];
  const footers: string[] = [];
  const xml = await zip.file(relsPath)?.async("string");
  const root = xml ? parseXml(xml) : null;
  if (!root) return { links, headers, footers };

  for (const rel of childElements(root)) {
    const id = rel.getAttribute("Id");
    const type = rel.getAttribute("Type") ?? "";
    const target = rel.getAttribute("Target") ?? "";
    if (!id || !target) continue;
    if (type.endsWith("/hyperlink")) links.set(id, target);
    else if (type.endsWith("/header")) headers.push(dir + target.replace(/^\//, ""));
    else if (type.endsWith("/footer")) footers.push(dir + target.replace(/^\//, ""));
  }
  return { links, headers, footers };
}

async function readPart(zip: JSZip, partPath: string): Promise<string[]> {
  const xml = await zip.file(partPath)?.async("string");
  const root = xml ? parseXml(xml) : null;
  if (!root) return [];
  const { links } = await readRels(zip, partPath);
  const body = childElements(root).find((c) => c.localName === "body") ?? root;
  return blocks(body, { rels: links });
}

async function extractDocxXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const mainPath = "word/document.xml";
  if (!zip.file(mainPath)) throw new Error("Not a Word document");

  const { headers, footers } = await readRels(zip, mainPath);
  const body = (await readPart(zip, mainPath)).join("\n");

  // First-page, even and default headers usually repeat the same details.
  const seen = new Set<string>();
  const extras = async (paths: string[]) => {
    const texts: string[] = [];
    for (const p of paths) {
      const text = normalizeText((await readPart(zip, p)).join("\n"));
      if (text && !seen.has(text)) {
        seen.add(text);
        texts.push(text);
      }
    }
    return texts;
  };
  const headerTexts = await extras(headers);
  const footerTexts = await extras(footers);

  return normalizeText([...headerTexts, body, ...footerTexts].join("\n\n"));
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const text = await extractDocxXml(buffer);
    if (text.trim()) return text;
  } catch {
    // Fall through to mammoth, which copes with some unusual files.
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeText(result.value);
  } catch {
    throw new Error("This Word file could not be opened. Save it as .docx (or PDF) and upload it again.");
  }
}
