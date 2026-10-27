export interface ExtractedText {
  text: string;
  /** OCR'd words read with low confidence; empty for real text layers. */
  uncertainWords: string[];
}

/**
 * Cleanup shared by every extractor, so the AI step and the heuristics see
 * the same kind of text whatever the file type was.
 */
export function normalizeText(text: string): string {
  return (
    text
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      .replace(/[   ]/g, " ")
      .replace(/[­​‌‍﻿]/g, "")
      // Word/PDF bullets drawn from Symbol/Wingdings fonts come through as
      // private-use characters — keep them readable as bullets.
      .replace(/^[ \t]*[-][ \t]*/gm, "• ")
      .replace(/[-]/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Share of non-space characters that look like real text. A PDF whose fonts
 * have no usable character map produces symbol soup or replacement
 * characters instead of words — that text is worse than useless to the AI.
 */
export function readableRatio(text: string): number {
  const chars = text.replace(/\s/g, "");
  if (chars.length === 0) return 0;
  const readable = chars.match(/[\p{L}\p{N}.,;:!?@'"()\-–—/&%+#•|]/gu)?.length ?? 0;
  return readable / chars.length;
}

/** Strips scheme/www/trailing slash so "LinkedIn" vs its URL can be compared. */
function bareUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^mailto:|^tel:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * What to append after a link's visible text so its target survives as
 * plain text — nothing when the visible text already shows it.
 */
export function linkSuffix(visibleText: string, url: string): string {
  if (/^tel:/i.test(url) || /^#/.test(url)) return "";
  const target = bareUrl(url);
  if (!target || bareUrl(visibleText).includes(target)) return "";
  return ` (${/^mailto:/i.test(url) ? target : url})`;
}
