import type { Prisma } from "@prisma/client";
import { extractPdfText } from "./import/pdf";
import { extractDocxText } from "./import/docx";
import { ocrImageBuffer } from "./import/ocr";
import { guessExtractedData } from "./import/heuristics";
import { normalizeText, type ExtractedText } from "./import/text";

export type ImportFileType = "pdf" | "docx" | "image";

export interface ExtractionResult {
  rawText: string;
  extractedData: Prisma.JsonObject;
}

async function extractRawText(buffer: Buffer, fileType: ImportFileType): Promise<ExtractedText> {
  switch (fileType) {
    case "pdf":
      return extractPdfText(buffer);
    case "docx":
      return { text: await extractDocxText(buffer), uncertainWords: [] };
    case "image": {
      const { text, uncertainWords } = await ocrImageBuffer(buffer);
      return { text: normalizeText(text), uncertainWords };
    }
  }
}

// Below this, there isn't enough real content to structure a CV from — and
// worse, handing a near-empty string to the AI generation step invites it to
// hallucinate a plausible-looking but entirely fabricated resume instead of
// failing loudly. Fail the import instead so the caller can ask for a
// different file.
const MIN_EXTRACTABLE_TEXT_LENGTH = 40;

/** Works entirely in memory — uploaded files are never written to disk. */
export async function runImportExtraction(buffer: Buffer, fileType: ImportFileType): Promise<ExtractionResult> {
  const { text: rawText, uncertainWords } = await extractRawText(buffer, fileType);

  if (rawText.trim().length < MIN_EXTRACTABLE_TEXT_LENGTH) {
    throw new Error(
      fileType === "image"
        ? "Could not read enough text in this image. Try a sharper, well-lit photo or a PDF of the CV."
        : "Could not find readable text in this file. Try a different file."
    );
  }

  const extractedData = guessExtractedData(rawText, uncertainWords);
  return { rawText, extractedData };
}
