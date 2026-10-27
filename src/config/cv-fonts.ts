/**
 * Font families templates can use. Files live in src/templates/fonts/<slug>/
 * (all open-licensed; each folder keeps its license file). A template lists
 * the families it needs in cv-templates.ts; only those are embedded in its
 * PDF or linked from its preview.
 */

export interface FontFace {
  file: string;
  weight: 400 | 500 | 600 | 700;
  style: "normal" | "italic";
}

export interface FontFamily {
  /** CSS font-family name templates use in their style.css. */
  family: string;
  /** Folder under src/templates/fonts/. */
  slug: string;
  faces: FontFace[];
}

const standardFaces = (prefix: string): FontFace[] => [
  { file: `${prefix}-400-normal.woff2`, weight: 400, style: "normal" },
  { file: `${prefix}-400-italic.woff2`, weight: 400, style: "italic" },
  { file: `${prefix}-700-normal.woff2`, weight: 700, style: "normal" },
  { file: `${prefix}-700-italic.woff2`, weight: 700, style: "italic" },
];

export const CV_FONTS: Record<string, FontFamily> = {
  "CMU Serif": {
    family: "CMU Serif",
    slug: "cmu-serif",
    // CMU Serif ships its regular weight as 500; map it onto the CSS 400/700 scale.
    faces: [
      { file: "cmu-serif-500-roman.woff2", weight: 400, style: "normal" },
      { file: "cmu-serif-500-italic.woff2", weight: 400, style: "italic" },
      { file: "cmu-serif-700-roman.woff2", weight: 700, style: "normal" },
      { file: "cmu-serif-700-italic.woff2", weight: 700, style: "italic" },
    ],
  },
  Lato: { family: "Lato", slug: "lato", faces: standardFaces("lato-latin") },
  Raleway: { family: "Raleway", slug: "raleway", faces: standardFaces("raleway-latin") },
  "Fira Sans": { family: "Fira Sans", slug: "fira-sans", faces: standardFaces("fira-sans-latin") },
  Roboto: { family: "Roboto", slug: "roboto", faces: standardFaces("roboto-latin") },
  "Source Sans 3": { family: "Source Sans 3", slug: "source-sans-3", faces: standardFaces("source-sans-3-latin") },
  "Libre Baskerville": {
    family: "Libre Baskerville",
    slug: "libre-baskerville",
    faces: standardFaces("libre-baskerville-latin"),
  },
  // Linux Libertine's successor — the open stand-in for Palatino-style academic type.
  "Libertinus Serif": {
    family: "Libertinus Serif",
    slug: "libertinus-serif",
    faces: standardFaces("libertinus-serif-latin"),
  },
  // Cochineal (LaTeX) is a refinement of Crimson; Crimson Text is its open webfont.
  "Crimson Text": { family: "Crimson Text", slug: "crimson-text", faces: standardFaces("crimson-text-latin") },
  Cabin: {
    family: "Cabin",
    slug: "cabin",
    // LaTeX's cabin package is used at [medium,bold]; map medium onto CSS 400.
    faces: [
      { file: "cabin-latin-500-normal.woff2", weight: 400, style: "normal" },
      { file: "cabin-latin-500-italic.woff2", weight: 400, style: "italic" },
      { file: "cabin-latin-700-normal.woff2", weight: 700, style: "normal" },
      { file: "cabin-latin-700-italic.woff2", weight: 700, style: "italic" },
    ],
  },
  // Monospace (LaTeX's zi4) for emails and handles; it has no italics.
  Inconsolata: {
    family: "Inconsolata",
    slug: "inconsolata",
    faces: [
      { file: "inconsolata-latin-400-normal.woff2", weight: 400, style: "normal" },
      { file: "inconsolata-latin-700-normal.woff2", weight: 700, style: "normal" },
    ],
  },
  // Metric-compatible with Times — the open stand-in for LaTeX's newtx.
  Tinos: { family: "Tinos", slug: "tinos", faces: standardFaces("tinos-latin") },
  Poppins: { family: "Poppins", slug: "poppins", faces: standardFaces("poppins-latin") },
  Montserrat: { family: "Montserrat", slug: "montserrat", faces: standardFaces("montserrat-latin") },
  Lora: { family: "Lora", slug: "lora", faces: standardFaces("lora-latin") },
  // Metric-compatible with Arial, as Tinos is with Times.
  Arimo: { family: "Arimo", slug: "arimo", faces: standardFaces("arimo-latin") },
  "Cormorant Garamond": {
    family: "Cormorant Garamond",
    slug: "cormorant-garamond",
    // Its regular weight is too thin for a display name; map medium onto CSS 400.
    faces: [
      { file: "cormorant-garamond-latin-500-normal.woff2", weight: 400, style: "normal" },
      { file: "cormorant-garamond-latin-500-italic.woff2", weight: 400, style: "italic" },
      { file: "cormorant-garamond-latin-700-normal.woff2", weight: 700, style: "normal" },
      { file: "cormorant-garamond-latin-700-italic.woff2", weight: 700, style: "italic" },
    ],
  },
  // Vercel's Geist (also the site's own UI font). No italics; medium and
  // semibold are included because its designs lean on them.
  Geist: {
    family: "Geist",
    slug: "geist",
    faces: [400, 500, 600, 700].map((weight) => ({
      file: `geist-sans-latin-${weight}-normal.woff2`,
      weight: weight as FontFace["weight"],
      style: "normal" as const,
    })),
  },
};

/** "slug/file" for every face — the only paths the font route will serve. */
export const FONT_PATHS = new Set(
  Object.values(CV_FONTS).flatMap((font) => font.faces.map((face) => `${font.slug}/${face.file}`))
);
