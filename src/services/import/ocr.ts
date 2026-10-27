import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { createWorker, type Page, type Worker } from "tesseract.js";
import { layoutText, type Box } from "./layout";

// One OCR worker for the process — creating one loads the English language
// data every time (several seconds). A worker runs one job at a time and
// queues the rest. Recreated if it ever fails.
let ocrWorkerPromise: Promise<Worker> | null = null;

function getOcrWorker(): Promise<Worker> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng").then(async (worker) => {
      // Keeps the wide gap between e.g. a job title and its dates instead
      // of collapsing it to one space.
      await worker.setParameters({ preserve_interword_spaces: "1" });
      return worker;
    });
    ocrWorkerPromise.catch(() => {
      ocrWorkerPromise = null;
    });
  }
  return ocrWorkerPromise;
}

export interface OcrResult {
  text: string;
  /** Tesseract's mean word confidence, 0–100. */
  confidence: number;
  /** Words Tesseract wasn't sure of — never trusted as contact details. */
  uncertainWords: string[];
}

// Below this a word is often one or two characters off ("example.cam").
const UNCERTAIN_WORD_CONFIDENCE = 85;

/**
 * Tesseract's own line building runs straight across a narrow gutter, so its
 * words are laid out again with the same column logic as PDF text.
 */
function pageToText(page: Page, imageWidth: number): { text: string; uncertainWords: string[] } {
  const boxes: Box[] = [];
  const uncertainWords: string[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const { baseline } = line;
        const slope = baseline.x1 !== baseline.x0 ? (baseline.y1 - baseline.y0) / (baseline.x1 - baseline.x0) : 0;
        const size = Math.max(1, line.rowAttributes?.rowHeight || line.bbox.y1 - line.bbox.y0);
        for (const word of line.words) {
          if (!word.text.trim()) continue;
          if (word.confidence < UNCERTAIN_WORD_CONFIDENCE) uncertainWords.push(word.text.trim());
          const baselineY = baseline.y0 + slope * (word.bbox.x0 - baseline.x0);
          // Image y grows downwards; layout expects it to grow upwards.
          boxes.push({ text: word.text, x0: word.bbox.x0, x1: word.bbox.x1, y: -baselineY, size: size * 0.8 });
        }
      }
    }
  }
  return { text: boxes.length ? layoutText(boxes, 0, imageWidth) : page.text, uncertainWords };
}

async function recognize(image: Buffer, imageWidth: number): Promise<OcrResult> {
  const worker = await getOcrWorker();
  try {
    const result = await worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true });
    return { ...pageToText(result.data, imageWidth), confidence: result.data.confidence };
  } catch (err) {
    ocrWorkerPromise = null;
    await worker.terminate().catch(() => undefined);
    throw err;
  }
}

// Tesseract reads body text best at roughly 30px per line — phone photos and
// screenshots of a CV are often far smaller than that, huge scans just slow.
const TARGET_WIDTH = 2400;
const MAX_UPSCALE = 3;

/**
 * Redraws the image onto a white canvas at a size Tesseract reads well,
 * optionally rotated. White matters: a transparent PNG otherwise reaches
 * Tesseract as black text on a black background.
 */
function prepare(source: Canvas | Awaited<ReturnType<typeof loadImage>>, rotation: 0 | 90 | 180 | 270): { image: Buffer; width: number } {
  const scale = Math.min(MAX_UPSCALE, TARGET_WIDTH / Math.max(source.width, source.height));
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const sideways = rotation === 90 || rotation === 270;
  const canvas = createCanvas(sideways ? h : w, sideways ? w : h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return { image: canvas.toBuffer("image/png"), width: canvas.width };
}

async function recognizePrepared(prepared: { image: Buffer; width: number }): Promise<OcrResult> {
  return recognize(prepared.image, prepared.width);
}

// Below this, the page was most likely read sideways or upside down (a phone
// photo without orientation data, a scan fed in the wrong way).
const LOW_CONFIDENCE = 55;
const GOOD_CONFIDENCE = 70;

/** OCRs one image, retrying at other right-angle rotations when it reads badly. */
export async function ocrCanvasOrImage(source: Canvas | Awaited<ReturnType<typeof loadImage>>): Promise<OcrResult> {
  let best = await recognizePrepared(prepare(source, 0));
  if (best.confidence >= LOW_CONFIDENCE) return best;

  for (const rotation of [90, 270, 180] as const) {
    const attempt = await recognizePrepared(prepare(source, rotation));
    if (attempt.confidence > best.confidence) best = attempt;
    if (best.confidence >= GOOD_CONFIDENCE) break;
  }
  return best;
}

export async function ocrImageBuffer(buffer: Buffer): Promise<OcrResult> {
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(buffer);
  } catch {
    throw new Error("This image file could not be opened. Try exporting it again as PNG or JPG.");
  }
  return ocrCanvasOrImage(image);
}
