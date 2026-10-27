import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { normalizeText, readableRatio, type ExtractedText } from "./text";
import { layoutText, type Box } from "./layout";
import { ocrCanvasOrImage, type OcrResult } from "./ocr";

// pdf.js 6 calls Promise.withResolvers, which Node only has from v22. Polyfill
// it so PDF import also works on Node 20 (pdf.js is loaded lazily below, after this runs).
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}

// The minimal slice of pdf.js used here. pdf.js is ESM-only, so it's loaded
// with a dynamic import and typed locally instead of through its own d.ts.
interface PdfTextItem {
  str?: string;
  transform: number[];
  width: number;
  height: number;
}
interface PdfAnnotation {
  subtype: string;
  url?: string;
  unsafeUrl?: string;
  rect: number[];
}
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfPage {
  view: number[];
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  getAnnotations(): Promise<PdfAnnotation[]>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: unknown; viewport: PdfViewport; canvas: unknown }): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJs>;
  return pdfjsPromise;
}

// pdf.js wants these as directory "URLs" with forward slashes, even on Windows.
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json")).split(path.sep).join("/");

// A CV is one to three pages; the caps only stop a 300-page upload from
// tying the server up.
const MAX_TEXT_PAGES = 20;
const MAX_OCR_PAGES = 5;
// A page with less real text than this is an image of text (a scan, or a
// design tool that flattened the CV) and gets OCR'd.
const MIN_PAGE_TEXT_CHARS = 25;
const MIN_READABLE_RATIO = 0.75;
// ~200 DPI — enough for Tesseract on body text without huge canvases.
const OCR_RENDER_SCALE = 200 / 72;

interface Link {
  url: string;
  rect: number[];
  used: boolean;
}

function toBoxes(items: PdfTextItem[], links: Link[]): { boxes: Box[]; rotated: string[] } {
  const boxes: Box[] = [];
  const rotated: string[] = [];
  for (const item of items) {
    const text = item.str ?? "";
    if (!text.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || item.height || 10;
    // Vertical text (rotated sidebars, watermarks) can't be placed in rows.
    if (Math.abs(b) > 0.01 * size || Math.abs(c) > 0.01 * size || a < 0) {
      rotated.push(text.trim());
      continue;
    }
    const box: Box = { text, x0: e, x1: e + item.width, y: f, size };
    const cx = (box.x0 + box.x1) / 2;
    const cy = f + size * 0.3;
    const link = links.find(
      (l) => cx >= l.rect[0] - 1 && cx <= l.rect[2] + 1 && cy >= l.rect[1] - 1 && cy <= l.rect[3] + 1
    );
    if (link) {
      box.link = link.url;
      link.used = true;
    }
    boxes.push(box);
  }
  return { boxes, rotated };
}

async function pageText(page: PdfPage): Promise<string> {
  const annotations = await page.getAnnotations();
  const links: Link[] = annotations
    .filter((a) => a.subtype === "Link" && (a.url || a.unsafeUrl))
    .map((a) => ({ url: (a.url || a.unsafeUrl) as string, rect: a.rect, used: false }));

  const { items } = await page.getTextContent();
  const { boxes, rotated } = toBoxes(items, links);
  const [left, , right] = page.view;
  let text = layoutText(boxes, left, right - left);
  if (rotated.length) text += `\n\n${rotated.join("\n")}`;

  // Links with no text over them — usually LinkedIn/GitHub icons.
  const iconLinks = [...new Set(links.filter((l) => !l.used && !/^(tel:|#)/i.test(l.url)).map((l) => l.url.replace(/^mailto:/i, "")))];
  if (iconLinks.length) text += `\n\n${iconLinks.join("\n")}`;
  return text;
}

async function ocrPage(page: PdfPage): Promise<OcrResult> {
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return ocrCanvasOrImage(canvas);
}

function nonSpaceLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractedText> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Character maps matter for text extraction: without them, PDFs using
    // CID fonts come out as garbage.
    cMapUrl: `${PDFJS_DIR}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`,
    isEvalSupported: false,
    verbosity: 0,
  });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    const name = err instanceof Error ? err.name : "";
    if (name === "PasswordException") {
      throw new Error("This PDF is password-protected. Remove the password and upload it again.");
    }
    throw new Error("This PDF could not be opened. It may be damaged. Try exporting it again.");
  }

  try {
    const pageCount = Math.min(doc.numPages, MAX_TEXT_PAGES);
    const pages: PdfPage[] = [];
    const texts: string[] = [];
    const uncertainWords: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      pages.push(page);
      texts.push(normalizeText(await pageText(page)));
    }

    // Unreadable fonts poison the whole document's text layer, so then
    // every page is OCR'd; otherwise only the pages that are images.
    const ocrAll = readableRatio(texts.join("\n")) < MIN_READABLE_RATIO;
    let ocrBudget = MAX_OCR_PAGES;
    for (let n = 0; n < pages.length && ocrBudget > 0; n++) {
      if (!ocrAll && nonSpaceLength(texts[n]) >= MIN_PAGE_TEXT_CHARS) continue;
      ocrBudget--;
      const ocr = await ocrPage(pages[n]);
      const ocrText = normalizeText(ocr.text);
      // Keep the text layer's links/fragments if OCR found nothing better.
      if (nonSpaceLength(ocrText) > nonSpaceLength(texts[n]) || ocrAll) {
        texts[n] = ocrAll ? ocrText : [ocrText, texts[n]].filter(Boolean).join("\n\n");
        uncertainWords.push(...ocr.uncertainWords);
      }
    }

    for (const page of pages) page.cleanup();
    return { text: texts.filter(Boolean).join("\n\n"), uncertainWords };
  } finally {
    await task.destroy();
  }
}
