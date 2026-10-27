import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Handlebars from "handlebars";
import puppeteer, { type Browser } from "puppeteer";
import { env } from "../config/env";
import {
  CV_TEMPLATE_REGISTRY,
  getCVTemplate,
  sectionTitle,
  type CVSectionKey,
  type CVTemplateDefinition,
} from "../config/cv-templates";
import { CV_FONTS } from "../config/cv-fonts";
import { normalizeCvContent } from "../utils/normalize-content";
import { ICONS, iconForLink, iconForSection } from "./render/icons";
import { MISSING_DETAILS_CSS, markMissingDetails, withMissingDetails } from "./render/missing-details";
import { mapTagged, stripPathTags, tagContentPaths } from "./render/content-paths";

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
export const FONTS_DIR = path.join(TEMPLATES_DIR, "fonts");
const SHARED_DIR = path.join(TEMPLATES_DIR, "_shared");

// ---------------------------------------------------------------------------
// Handlebars: a private instance with the helpers and shared partials
// ---------------------------------------------------------------------------

const hbs = Handlebars.create();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2023-01" → "Jan 2023", "present" → "Present"; anything else (e.g. "Expected 2026") as-is. */
function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return mapTagged(value, formatPlainDate);
}

function formatPlainDate(value: string): string {
  const v = value.trim();
  if (v.toLowerCase() === "present") return "Present";
  const match = v.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (match) {
    const month = MONTHS[Number(match[2]) - 1];
    return month ? `${month} ${match[1]}` : match[1];
  }
  return v;
}

function dateRange(start: unknown, end: unknown): string {
  const from = formatDate(start);
  const to = formatDate(end);
  return from && to ? `${from} – ${to}` : from || to;
}

// Only http(s)/mailto/tel links are ever emitted — a CV is user content, so a
// "javascript:" or other scheme is shown as text but never made clickable.
function safeHref(url: unknown): string {
  if (typeof url !== "string") return "#";
  const trimmed = url.trim();
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return "#";
}

function displayUrl(url: unknown): string {
  return typeof url === "string" ? url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "") : "";
}

hbs.registerHelper("formatDate", formatDate);
hbs.registerHelper("dateRange", dateRange);
hbs.registerHelper("join", (items: unknown, separator: unknown) =>
  Array.isArray(items) ? items.filter((i) => typeof i === "string" && i).join(String(separator)) : ""
);
hbs.registerHelper("href", safeHref);
hbs.registerHelper("displayUrl", displayUrl);
hbs.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hbs.registerHelper("percent", (value: unknown) =>
  typeof value === "number" ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : "0%"
);
// True when items[index] has the same non-empty `field` as the item before it —
// for designs that nest consecutive roles at one company under one heading.
hbs.registerHelper("sameAsPrevious", (items: unknown, index: unknown, field: unknown) => {
  if (!Array.isArray(items) || typeof index !== "number" || index < 1 || typeof field !== "string") return false;
  const value = (item: unknown) =>
    typeof item === "object" && item !== null
      ? stripPathTags(String((item as Record<string, unknown>)[field] ?? "")).trim().toLowerCase()
      : "";
  return value(items[index]) !== "" && value(items[index]) === value(items[index - 1]);
});
// Inline SVG icons (Lucide, ISC license) — trusted markup from ./render/icons.
hbs.registerHelper("icon", (name: unknown) => new hbs.SafeString(typeof name === "string" ? (ICONS[name] ?? "") : ""));

// For designs that set the surname apart ("Jane **DOE**").
const nameParts = (value: string): string[] => value.trim().split(/\s+/);
hbs.registerHelper("firstNames", (name: unknown) =>
  typeof name === "string" ? mapTagged(name, (n) => nameParts(n).slice(0, -1).join(" ")) : ""
);
hbs.registerHelper("lastName", (name: unknown) =>
  typeof name === "string" ? mapTagged(name, (n) => nameParts(n).slice(-1)[0] ?? "") : ""
);

// Every file in templates/_shared/ is a partial named after the file
// ("section.hbs" → {{> section}}). A template overrides any of them with an
// inline partial of the same name.
for (const file of readdirSync(SHARED_DIR)) {
  if (file.endsWith(".hbs")) {
    hbs.registerPartial(path.basename(file, ".hbs"), readFileSync(path.join(SHARED_DIR, file), "utf-8"));
  }
}
const SHARED_BASE_CSS = readFileSync(path.join(SHARED_DIR, "base.css"), "utf-8");

// Fail at boot, not in a user's PDF, if a registered font file is missing.
for (const font of Object.values(CV_FONTS)) {
  for (const face of font.faces) {
    if (!existsSync(path.join(FONTS_DIR, font.slug, face.file))) {
      throw new Error(`Font file missing: templates/fonts/${font.slug}/${face.file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Template loading (cached per process)
// ---------------------------------------------------------------------------

interface LoadedTemplate {
  render: HandlebarsTemplateDelegate;
  css: string;
}

const loadedTemplates = new Map<string, Promise<LoadedTemplate>>();

function loadTemplate(templateId: string): Promise<LoadedTemplate> {
  let pending = loadedTemplates.get(templateId);
  if (!pending) {
    pending = (async () => {
      const dir = path.join(TEMPLATES_DIR, templateId);
      const [source, css] = await Promise.all([
        fs.readFile(path.join(dir, "template.hbs"), "utf-8"),
        fs.readFile(path.join(dir, "style.css"), "utf-8"),
      ]);
      // Templates built on the shared section markup start from base.css.
      if (source.includes("{{> section")) {
        return { render: hbs.compile(source, { strict: false }), css: `${SHARED_BASE_CSS}\n${css}` };
      }
      // A template that lays out sections itself (instead of using the shared
      // {{> section}} renderer) must provide a partial per listed section, or
      // that section would silently never render.
      {
        const definition = CV_TEMPLATE_REGISTRY[templateId];
        const missing = (definition?.sections ?? []).filter(
          (key) => key !== "photo" && !source.includes(`{{#*inline "${key}"}}`)
        );
        if (missing.length) {
          throw new Error(`Template "${templateId}" lists sections with no partial: ${missing.join(", ")}`);
        }
      }
      return { render: hbs.compile(source, { strict: false }), css };
    })();
    pending.catch(() => loadedTemplates.delete(templateId));
    loadedTemplates.set(templateId, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function fontFaceRule(family: string, weight: number, style: string, src: string): string {
  return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; font-display: block; src: url("${src}") format("woff2"); }`;
}

const inlineFontCss = new Map<string, Promise<string>>();

/** @font-face rules with the files embedded — a PDF render never touches the network. */
function getInlineFontCss(familyName: string): Promise<string> {
  let pending = inlineFontCss.get(familyName);
  if (!pending) {
    const font = CV_FONTS[familyName];
    pending = Promise.all(
      font.faces.map(async (face) => {
        const data = await fs.readFile(path.join(FONTS_DIR, font.slug, face.file));
        return fontFaceRule(font.family, face.weight, face.style, `data:font/woff2;base64,${data.toString("base64")}`);
      })
    ).then((rules) => rules.join("\n"));
    pending.catch(() => inlineFontCss.delete(familyName));
    inlineFontCss.set(familyName, pending);
  }
  return pending;
}

async function fontCss(template: CVTemplateDefinition, options: RenderHtmlOptions): Promise<string> {
  if (options.mode === "pdf") {
    return (await Promise.all(template.fonts.map(getInlineFontCss))).join("\n");
  }
  return template.fonts
    .flatMap((familyName) => {
      const font = CV_FONTS[familyName];
      return font.faces.map((face) =>
        fontFaceRule(font.family, face.weight, face.style, `${options.fontBaseUrl ?? ""}/${font.slug}/${face.file}`)
      );
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// View model — every section normalized to one of a few shapes, so the shared
// section markup (and each template's CSS) can treat them uniformly
// ---------------------------------------------------------------------------

type Content = Record<string, unknown>;
type Bullet = { label?: string; text: string };

/** The common shape of every dated/titled item: jobs, degrees, projects, awards... */
interface Entry {
  title: string;
  subtitle?: string;
  date?: string;
  location?: string;
  url?: string;
  /** Secondary detail shown near the title (a project's tech stack, a paper's authors, a GPA). */
  meta?: string;
  description?: string;
  bullets: Bullet[];
}

const asArray = (value: unknown): Content[] =>
  Array.isArray(value) ? value.filter((v): v is Content => typeof v === "object" && v !== null) : [];
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const bulletsOf = (value: unknown): Bullet[] => asArray(value) as unknown as Bullet[];

function toEntries(key: CVSectionKey, items: Content[]): Entry[] {
  switch (key) {
    case "experience":
      return items.map((e) => ({
        title: str(e.role) || str(e.company),
        subtitle: str(e.role) ? str(e.company) : "",
        date: dateRange(e.start_date, e.end_date),
        location: str(e.location),
        url: str(e.url),
        bullets: bulletsOf(e.bullets),
      }));
    case "education":
      return items.map((e) => {
        const degree = [str(e.degree), str(e.field)].filter(Boolean).join(" in ");
        return {
          title: str(e.institution) || degree,
          subtitle: str(e.institution) ? degree : "",
          meta: str(e.gpa) ? `GPA: ${str(e.gpa)}` : "",
          date: dateRange(e.start_date, e.end_date),
          location: str(e.location),
          description: str(e.honors),
          bullets: bulletsOf(e.bullets),
        };
      });
    case "projects":
      return items.map((e) => ({
        title: str(e.name),
        subtitle: str(e.subtitle),
        meta: Array.isArray(e.tech) ? (e.tech as unknown[]).map(str).filter(Boolean).join(", ") : "",
        url: str(e.url),
        description: str(e.description),
        bullets: bulletsOf(e.bullets),
      }));
    case "volunteering":
      return items.map((e) => ({
        title: str(e.role) || str(e.organization),
        subtitle: str(e.role) ? str(e.organization) : "",
        date: dateRange(e.start_date, e.end_date),
        location: str(e.location),
        bullets: bulletsOf(e.bullets),
      }));
    case "research":
    case "teaching":
    case "activities":
      return items.map((e) => ({
        title: str(e.title),
        subtitle: str(e.organization),
        date: dateRange(e.start_date, e.end_date),
        location: str(e.location),
        bullets: bulletsOf(e.bullets),
      }));
    case "awards":
      return items.map((e) => ({
        title: str(e.title),
        subtitle: str(e.issuer),
        date: formatDate(e.date),
        description: str(e.description),
        bullets: [],
      }));
    case "publications":
      return items.map((e) => ({
        title: str(e.title),
        subtitle: str(e.venue),
        meta: str(e.authors),
        date: formatDate(e.date),
        url: str(e.url),
        bullets: [],
      }));
    case "certifications":
      return items.map((e) => ({
        title: str(e.name),
        subtitle: str(e.issuer),
        date: [formatDate(e.date), str(e.expires) ? `expires ${formatDate(e.expires)}` : ""].filter(Boolean).join(" · "),
        url: str(e.url),
        bullets: [],
      }));
    case "courses":
      return items.map((e) => ({ title: str(e.name), subtitle: str(e.institution), date: formatDate(e.date), bullets: [] }));
    case "memberships":
      return items.map((e) => ({
        title: str(e.organization),
        subtitle: str(e.role),
        date: dateRange(e.start_date, e.end_date),
        bullets: [],
      }));
    case "presentations":
      return items.map((e) => ({
        title: str(e.title),
        subtitle: str(e.event),
        date: formatDate(e.date),
        url: str(e.url),
        bullets: [],
      }));
    default:
      return [];
  }
}

// Sections whose items are short one-liners (templates can render them tighter).
const COMPACT_SECTIONS = new Set<CVSectionKey>([
  "awards",
  "publications",
  "certifications",
  "courses",
  "memberships",
  "presentations",
]);

/** 0–1 for a language bar: CEFR levels and common words; null when the text doesn't say. */
function languageLevel(proficiency: string): number | null {
  const p = proficiency.toLowerCase();
  if (/native|mother|bilingual|\bc2\b/.test(p)) return 1;
  if (/fluent|\bc1\b|full professional/.test(p)) return 0.85;
  if (/professional|advanced|\bb2\b|proficient/.test(p)) return 0.7;
  if (/intermediate|conversational|\bb1\b/.test(p)) return 0.55;
  if (/elementary|basic|beginner|\ba2\b/.test(p)) return 0.35;
  if (/\ba1\b/.test(p)) return 0.2;
  return null;
}

type SectionKind = "text" | "entries" | "skills" | "languages" | "tags" | "details" | "references";

interface SectionView {
  key: CVSectionKey;
  title: string;
  icon: string;
  kind: SectionKind;
  compact?: boolean;
  /** Raw section items, for templates that lay a section out from its own fields. */
  items?: unknown[];
  [field: string]: unknown;
}

/** Data for one section, or null when the CV has nothing to show there. */
function sectionView(template: CVTemplateDefinition, key: CVSectionKey, content: Content): SectionView | null {
  const base = { key, title: sectionTitle(template, key), icon: iconForSection(key) };
  switch (key) {
    case "photo":
      return null; // rendered in the header, not as a section
    case "summary":
    case "consent": {
      const text = str(content[key]);
      return text ? { ...base, kind: "text", text } : null;
    }
    case "skills": {
      const groups = asArray(content.skillGroups).filter((g) => Array.isArray(g.items) && g.items.length > 0);
      if (groups.length) return { ...base, kind: "skills", groups };
      const skills = Array.isArray(content.skills) ? content.skills.filter((s) => typeof s === "string" && s) : [];
      return skills.length ? { ...base, kind: "skills", groups: [{ category: "", items: skills }] } : null;
    }
    case "languages": {
      const items = asArray(content.languages)
        .filter((l) => str(l.language))
        .map((l) => ({ language: str(l.language), proficiency: str(l.proficiency), level: languageLevel(str(l.proficiency)) }));
      return items.length ? { ...base, kind: "languages", items } : null;
    }
    case "interests": {
      const items = Array.isArray(content.interests) ? content.interests.map(str).filter(Boolean) : [];
      return items.length ? { ...base, kind: "tags", items } : null;
    }
    case "personalDetails": {
      const items = asArray(content.personalDetails).filter((d) => str(d.label) && str(d.value));
      return items.length ? { ...base, kind: "details", items } : null;
    }
    case "references": {
      const items = asArray(content.references).filter((r) => str(r.name));
      return items.length ? { ...base, kind: "references", items } : null;
    }
    default: {
      const items = asArray(content[key]);
      const entries = toEntries(key, items).filter((e) => e.title);
      return entries.length ? { ...base, kind: "entries", compact: COMPACT_SECTIONS.has(key), entries, items } : null;
    }
  }
}

interface ContactItem {
  kind: string;
  icon: string;
  label: string;
  text: string;
  href?: string;
}

function contactItems(personal: Content): ContactItem[] {
  const items: ContactItem[] = [];
  const email = str(personal.email);
  const phone = str(personal.phone);
  const location = str(personal.location);
  if (email) items.push({ kind: "email", icon: "mail", label: "Email", text: email, href: `mailto:${email}` });
  if (phone) items.push({ kind: "phone", icon: "phone", label: "Phone", text: phone, href: `tel:${phone.replace(/[^\d+]/g, "")}` });
  if (location) items.push({ kind: "location", icon: "mapPin", label: "Location", text: location });
  for (const link of asArray(personal.links)) {
    const url = str(link.url);
    if (!url) continue;
    items.push({ kind: "link", icon: iconForLink(str(link.label), url), label: str(link.label), text: displayUrl(url), href: safeHref(url) });
  }
  return items;
}

export interface RenderHtmlOptions {
  /**
   * "pdf" embeds fonts. "preview" links them from `fontBaseUrl` and draws the
   * A4 sheet on a gray desk (the editor). "thumbnail" links them too but
   * renders just the bare sheet (galleries).
   */
  mode: "pdf" | "preview" | "thumbnail";
  /** Required for preview/thumbnail modes — where GET /api/v1/templates/fonts/:family/:file is served. */
  fontBaseUrl?: string;
  /** Preview only: draw highlighted placeholders for what the CV is missing (see render/missing-details.ts). */
  showMissing?: boolean;
}

/** Renders CV content with a template to a complete, self-contained HTML document. */
export async function renderCvHtml(rawContent: unknown, templateId: string, options: RenderHtmlOptions): Promise<string> {
  const template = getCVTemplate(templateId);
  const raw = (rawContent ?? {}) as Content;
  // The editor preview can show what's missing as highlighted placeholders.
  const showMissing = options.mode === "preview" && options.showMissing === true;
  const normalized = normalizeCvContent(showMissing ? withMissingDetails(raw, template.sections) : raw);
  // In the editor preview every text value carries its path, so a click can open that field.
  const isPreview = options.mode === "preview";
  const content = isPreview ? tagContentPaths(normalized) : normalized;
  const { render, css } = await loadTemplate(template.id);

  const sections = template.sections
    .map((key) => sectionView(template, key, content))
    .filter((view): view is SectionView => view !== null);
  const sidebarKeys = new Set<CVSectionKey>(template.sidebar ?? []);
  const personal = (content.personal as Content | undefined) ?? {};

  const html = render({
    personal,
    contacts: contactItems(personal),
    // Only templates that show a photo get one, even if the CV has it.
    photo: template.sections.includes("photo") ? personal.photo : undefined,
    sections,
    mainSections: sections.filter((s) => !sidebarKeys.has(s.key)),
    sidebarSections: sections.filter((s) => sidebarKeys.has(s.key)),
    styles: `${await fontCss(template, options)}\n${css}${showMissing ? MISSING_DETAILS_CSS : ""}`,
    mode: options.mode,
  });
  return isPreview ? markMissingDetails(html) : html;
}

// ---------------------------------------------------------------------------
// PDF (headless Chromium)
// ---------------------------------------------------------------------------

// One Chromium for the whole process — launching one per render costs 1–3s
// and ~100–200MB each. Relaunched lazily if it ever crashes or disconnects.
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching = puppeteer.launch({
      headless: true,
      // In a container running as root (Render), Chromium refuses to start
      // without --no-sandbox; /dev/shm there is also too small for it.
      args: env.CHROME_NO_SANDBOX ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : [],
    });
    browserPromise = launching;
    launching
      .then((browser) => {
        pdfRendererState = "ok";
        pdfRendererError = null;
        browser.on("disconnected", () => {
          if (browserPromise === launching) browserPromise = null;
        });
      })
      .catch(() => {
        if (browserPromise === launching) browserPromise = null;
      });
  }
  return browserPromise;
}

// Whether this server can make PDFs: checked once at start-up (Chrome present
// and starting), and kept up to date by every launch since. /health reports it,
// so a deploy without a working Chrome never goes live (see render.yaml's
// healthCheckPath), instead of failing on someone's first download.
export type PdfRendererState = "checking" | "ok" | "failed";
let pdfRendererState: PdfRendererState = "checking";
let pdfRendererError: string | null = null;

export function pdfRendererStatus(): { state: PdfRendererState; error: string | null } {
  return { state: pdfRendererState, error: pdfRendererError };
}

export async function checkPdfRenderer(): Promise<boolean> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.close();
    pdfRendererState = "ok";
    pdfRendererError = null;
    return true;
  } catch (err) {
    pdfRendererState = "failed";
    pdfRendererError = err instanceof Error ? err.message.split("\n")[0] : "Chrome could not start";
    return false;
  }
}

export async function closeRenderBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) await (await pending.catch(() => null))?.close();
}

// Each page holds a full render in memory; cap how many run at once so a burst
// of downloads queues instead of exhausting the server's RAM.
const MAX_CONCURRENT_RENDERS = env.MAX_CONCURRENT_RENDERS;
let activeRenders = 0;
const waiting: (() => void)[] = [];

async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeRenders++;
  try {
    return await fn();
  } finally {
    activeRenders--;
    waiting.shift()?.();
  }
}

// Drawn over every page of a preview PDF of a CV that still needs paying for
// (a fixed element repeats on each printed page).
const PREVIEW_WATERMARK_HTML = `<style>
  .gm-preview-watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2147483647; }
  .gm-preview-watermark span { transform: rotate(-32deg); font: 700 64px/1 Arial, sans-serif; letter-spacing: 6px; color: rgba(15, 17, 21, 0.13); white-space: nowrap; }
</style><div class="gm-preview-watermark"><span>PREVIEW · GOMOXIE</span></div>`;

export async function renderCVDocumentToPdf(
  content: unknown,
  templateId: string,
  options: { watermark?: boolean } = {}
): Promise<Buffer> {
  const rendered = await renderCvHtml(content, templateId, { mode: "pdf" });
  const html = options.watermark
    ? rendered.includes("</body>")
      ? rendered.replace("</body>", `${PREVIEW_WATERMARK_HTML}</body>`)
      : `${rendered}${PREVIEW_WATERMARK_HTML}`
    : rendered;

  return withRenderSlot(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      // Templates are static HTML + CSS; no script ever needs to run.
      await page.setJavaScriptEnabled(false);
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluateHandle("document.fonts.ready");
      const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/**
 * The first page of a CV as a PNG, A4 at 96 dpi (794 × 1123) — the same sheet
 * the galleries show (thumbnail mode: the page with its own margins, as on
 * screen; print styles would rely on PDF page margins a screenshot doesn't
 * have). `fontBaseUrl` is where this server serves template fonts. For share
 * images and other places that need a picture rather than HTML.
 */
export async function renderCvToPng(content: unknown, templateId: string, fontBaseUrl: string): Promise<Buffer> {
  const html = await renderCvHtml(content, templateId, { mode: "thumbnail", fontBaseUrl });

  return withRenderSlot(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluateHandle("document.fonts.ready");
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 794, height: 1123 } });
      return Buffer.from(png);
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
