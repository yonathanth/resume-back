import { linkSuffix } from "./text";

/**
 * Reading order from where text sits on the page, shared by PDF text layers
 * and OCR. Neither source can be trusted to give text in reading order:
 * many PDF generators draw line by line straight across the page, and
 * Tesseract builds lines across a narrow gutter — both interleave a sidebar
 * with the main column. Here each two-column stretch is read left column
 * first, then right.
 */

export interface Box {
  text: string;
  x0: number;
  x1: number;
  /** Baseline; grows upwards (PDF coordinates). */
  y: number;
  /** Font size, roughly — used as the unit for every spacing threshold. */
  size: number;
  link?: string;
}

interface Row {
  boxes: Box[];
  y: number;
  size: number;
}

interface RowGroup {
  column: boolean;
  rows: Box[][];
}

function toRows(boxes: Box[]): Row[] {
  const sorted = [...boxes].sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const rows: Row[] = [];
  for (const box of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - box.y) <= 0.45 * Math.max(row.size, box.size)) {
      row.boxes.push(box);
      row.size = Math.max(row.size, box.size);
    } else {
      rows.push({ boxes: [box], y: box.y, size: box.size });
    }
  }
  for (const row of rows) row.boxes.sort((p, q) => p.x0 - q.x0);
  return rows;
}

function rowText(boxes: Box[]): string {
  let out = "";
  let linkText = "";
  let prev: Box | undefined;
  const closeLink = () => {
    if (prev?.link) out += linkSuffix(linkText, prev.link);
    linkText = "";
  };
  for (const box of boxes) {
    if (prev) {
      if (prev.link !== box.link) closeLink();
      const gap = box.x0 - prev.x1;
      const spaced = /\s$/.test(out) || /^\s/.test(box.text);
      // A wide gap is usually layout ("Backend Engineer     2021 – Present"),
      // kept wider than a word space so the two read as separate things.
      if (gap > prev.size * 2) out = out.trimEnd() + "   ";
      else if (!spaced && gap > prev.size * 0.12) out += " ";
    }
    out += box.text;
    if (box.link) linkText += box.text;
    prev = box;
  }
  closeLink();
  return out.replace(/\s+$/, "");
}

/** Gaps (x-intervals) in a row that lie within [lo, hi]. */
function freeIntervals(row: Row, lo: number, hi: number): [number, number][] {
  const free: [number, number][] = [];
  let cursor = lo;
  for (const box of row.boxes) {
    if (box.x0 > cursor) free.push([cursor, Math.min(box.x0, hi)]);
    cursor = Math.max(cursor, box.x1);
    if (cursor >= hi) break;
  }
  if (cursor < hi) free.push([cursor, hi]);
  return free.filter(([a, b]) => b > a);
}

function intersect(xs: [number, number][], ys: [number, number][], minWidth: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a1, b1] of xs) {
    for (const [a2, b2] of ys) {
      const a = Math.max(a1, a2);
      const b = Math.min(b1, b2);
      if (b - a >= minWidth) out.push([a, b]);
    }
  }
  return out;
}

interface Split {
  left: Box[][];
  right: Box[][];
  sides: ("left" | "right" | "both")[];
  leftOnly: number;
  rightOnly: number;
  both: number;
  rightHasLongLine: boolean;
}

function splitAt(rows: Row[], gutter: number, pageWidth: number): Split {
  const split: Split = { left: [], right: [], sides: [], leftOnly: 0, rightOnly: 0, both: 0, rightHasLongLine: false };
  for (const row of rows) {
    const l = row.boxes.filter((b) => b.x1 <= gutter);
    const r = row.boxes.filter((b) => b.x0 >= gutter);
    if (l.length) split.left.push(l);
    if (r.length) {
      split.right.push(r);
      if (r[r.length - 1].x1 - r[0].x0 > 0.2 * pageWidth) split.rightHasLongLine = true;
    }
    if (l.length && r.length) {
      split.both++;
      split.sides.push("both");
    } else if (l.length) {
      split.leftOnly++;
      split.sides.push("left");
    } else {
      split.rightOnly++;
      split.sides.push("right");
    }
  }
  return split;
}

/**
 * Whether rows that share a clear vertical gap are really two columns (a
 * sidebar CV) rather than one column with something right-aligned in it
 * (dates next to job titles) or a small table. Splitting the latter would
 * separate every date from its job, so the bar is high: each side needs
 * lines the other side doesn't have at that height, or the right side must
 * carry real prose.
 */
function isColumnLayout(split: Split): boolean {
  if (split.left.length < 3 || split.right.length < 3 || split.both < 2) return false;
  if (split.leftOnly >= 2 && split.rightOnly >= 2) return true;
  const rows = split.both + split.leftOnly + split.rightOnly;
  return split.rightHasLongLine && split.leftOnly + split.rightOnly >= 0.3 * rows;
}

function gutterOf(block: Row[], lo: number, hi: number, minGutter: number): [number, number][] {
  let gaps = freeIntervals(block[0], lo, hi).filter(([a, b]) => b - a >= minGutter);
  for (const row of block.slice(1)) gaps = intersect(gaps, freeIntervals(row, lo, hi), minGutter);
  return gaps;
}

function findColumns(block: Row[], lo: number, hi: number, minGutter: number, pageWidth: number): Split | null {
  for (const [a, b] of gutterOf(block, lo, hi, minGutter)) {
    const split = splitAt(block, (a + b) / 2, pageWidth);
    if (isColumnLayout(split)) return split;
  }
  return null;
}

/**
 * Where a column block really ends. The gutter test alone runs a block on
 * past a full-width section's heading ("EDUCATION" right after a sidebar
 * ends), since a short heading doesn't cross the gutter. Rows at the end of
 * the block that sit apart from the column above them but right on top of
 * the full-width row that follows belong to that row instead.
 */
function trimTrailing(block: Row[], split: Split, next: Row | undefined, lineGap: number): number {
  const end = block.length - 1;
  if (!next || block[end].y - next.y > lineGap * 1.8 || split.sides[end] === "both") return end;
  for (let k = end; k > 0 && split.sides[k] === split.sides[end]; k--) {
    if (block[k - 1].y - block[k].y > lineGap * 1.8) return k - 1;
  }
  return end;
}

function layoutRows(rows: Row[], pageLeft: number, pageWidth: number, lineGap: number): RowGroup[] {
  const lo = pageLeft + 0.15 * pageWidth;
  const hi = pageLeft + 0.85 * pageWidth;
  const minGutter = Math.max(8, 0.015 * pageWidth);
  const out: RowGroup[] = [];

  let i = 0;
  while (i < rows.length) {
    // Furthest row a gutter starting at row i survives to.
    let free = freeIntervals(rows[i], lo, hi).filter(([a, b]) => b - a >= minGutter);
    let j = i;
    while (free.length && j + 1 < rows.length) {
      const next = intersect(free, freeIntervals(rows[j + 1], lo, hi), minGutter);
      if (!next.length) break;
      free = next;
      j++;
    }

    let best: Split | null = null;
    let bestEnd = i;
    // Try the full run and progressively shorter ones: a gutter can survive
    // a few rows past where the columns actually end.
    for (let end = j; end >= i + 2 && !best; end--) {
      const block = rows.slice(i, end + 1);
      const split = findColumns(block, lo, hi, minGutter, pageWidth);
      if (!split) continue;
      const trimmedEnd = trimTrailing(block, split, rows[end + 1], lineGap);
      const trimmed = trimmedEnd < block.length - 1 ? findColumns(block.slice(0, trimmedEnd + 1), lo, hi, minGutter, pageWidth) : null;
      best = trimmed ?? split;
      bestEnd = trimmed ? i + trimmedEnd : end;
    }

    if (best) {
      out.push({ column: true, rows: best.left }, { column: true, rows: best.right });
      i = bestEnd + 1;
    } else {
      const last = out[out.length - 1];
      if (last && !last.column) last.rows.push(rows[i].boxes);
      else out.push({ column: false, rows: [rows[i].boxes] });
      i++;
    }
  }
  return out;
}

/** The page's ordinary distance between consecutive lines. */
function typicalLineGap(rows: Row[]): number {
  const gaps = rows
    .slice(1)
    .map((row, k) => rows[k].y - row.y)
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  if (!gaps.length) return rows[0]?.size ?? 10;
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Lays the boxes of one page out as text: rows in reading order, a blank
 * line where the page shows a bigger-than-usual vertical gap (between
 * sections, usually) and around each column.
 */
export function layoutText(boxes: Box[], pageLeft: number, pageWidth: number): string {
  const rows = toRows(boxes);
  if (!rows.length) return "";
  const lineGap = typicalLineGap(rows);
  const groups = layoutRows(rows, pageLeft, pageWidth, lineGap);

  const lines: string[] = [];
  const blank = () => {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  };
  for (const group of groups) {
    if (group.column) blank();
    let prev: Box[] | undefined;
    for (const boxes of group.rows) {
      if (prev && prev[0].y - boxes[0].y > lineGap * 1.5) blank();
      lines.push(rowText(boxes));
      prev = boxes;
    }
    if (group.column) blank();
  }
  return lines.join("\n");
}
