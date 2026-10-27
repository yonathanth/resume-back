import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import {
  CV_TEMPLATE_REGISTRY,
  DEFAULT_CV_TEMPLATE_ID,
  TEMPLATE_CATEGORIES,
  isValidCVTemplateId,
  templatesInDisplayOrder,
  sectionTitle,
} from "../config/cv-templates";
import { FONT_PATHS } from "../config/cv-fonts";
import { FONTS_DIR, renderCVDocumentToPdf, renderCvHtml, renderCvToPng } from "../services/render.service";
import { PartialCVContent } from "../schemas/cv-content.schema";
import { sendError } from "../utils/http-error";
import { env } from "../config/env";
import { prisma } from "../db/client";
import { sampleCvFor } from "../config/sample-cv";
import { LANDING_STORIES } from "../config/landing-stories";
import { resolveAccess } from "../services/access.service";
import { isCvLocked } from "../services/entitlement.service";

const previewSchema = z.object({
  templateId: z.string().min(1),
  content: PartialCVContent,
  /** Draw placeholders for missing details (the editor's "Show gaps" view). */
  showMissing: z.boolean().optional(),
  /** The CV being previewed — a PDF of one that still needs paying for is watermarked. */
  cvDocumentId: z.string().min(1).optional(),
});

// Preview and thumbnail HTML link fonts from this server (PDFs embed them).
const fontBaseUrl = (request: FastifyRequest) => `${request.protocol}://${request.host}/api/v1/templates/fonts`;

// Sample CVs only change with a deploy, so each template's picture is rendered once.
const templatePreviewCache = new Map<string, Promise<Buffer>>();

export async function templateRoutes(app: FastifyInstance) {
  // The gallery: every template the backend can actually render, in gallery
  // order (the default, then the newest); clients filter by category.
  app.get("/api/v1/templates", async (_request, reply) => {
    const templates = templatesInDisplayOrder().map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      hasPhoto: template.sections.includes("photo"),
      twoColumn: Boolean(template.sidebar?.length) && template.category === "Two-column",
      // The editor shows exactly these sections' forms, in this order.
      sections: template.sections.map((key) => ({ key, label: sectionTitle(template, key) })),
      askIfMissing: template.askIfMissing ?? [],
      isDefault: template.id === DEFAULT_CV_TEMPLATE_ID,
    }));
    return reply.send({ data: templates, meta: { categories: TEMPLATE_CATEGORIES }, error: null });
  });

  // A template rendered with its fictional sample CV — the gallery thumbnail
  // (or, with ?story=, one of the landing page's before/after people).
  // Each template has exactly one sample person; `persona`/`personaCount`
  // stay in the response (always 0 and 1) for clients that still send it.
  app.get("/api/v1/templates/:id/sample", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { story } = request.query as { story?: string };
    if (!(id in CV_TEMPLATE_REGISTRY)) {
      return sendError(reply, 404, "TEMPLATE_NOT_FOUND", `Unknown CV template: "${id}"`);
    }
    // ?story= renders one of the landing page's fixed before/after people instead (config/landing-stories).
    if (story !== undefined && !Object.hasOwn(LANDING_STORIES, story)) {
      return sendError(reply, 404, "STORY_NOT_FOUND", `Unknown story: "${story}"`);
    }
    const sample = story !== undefined ? (LANDING_STORIES[story] as ReturnType<typeof sampleCvFor>) : sampleCvFor(id);
    const html = await renderCvHtml(sample, id, { mode: "thumbnail", fontBaseUrl: fontBaseUrl(request) });
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send({
      data: { html, persona: 0, personaCount: 1, label: sample.personal.title },
      error: null,
    });
  });

  // A template's sample CV as a PNG (first page): the picture on its public
  // page's share image (the frontend's /templates/[id] Open Graph image).
  // Public, and rendered once per template per server process, so it can't
  // be used to keep Chromium busy.
  app.get("/api/v1/templates/:id/preview.png", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(id in CV_TEMPLATE_REGISTRY)) {
      return sendError(reply, 404, "TEMPLATE_NOT_FOUND", `Unknown CV template: "${id}"`);
    }
    let png = templatePreviewCache.get(id);
    if (!png) {
      // Fonts from this very server, over loopback (the page is rendered here).
      png = renderCvToPng(sampleCvFor(id), id, `http://127.0.0.1:${env.PORT}/api/v1/templates/fonts`);
      templatePreviewCache.set(id, png);
      // A failed render isn't kept: the next request tries again.
      png.catch(() => templatePreviewCache.delete(id));
    }
    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(await png);
  });

  // Font files referenced by preview HTML. Public, immutable assets — only
  // paths from the font registry are ever served (no path traversal).
  app.get("/api/v1/templates/fonts/:family/:file", async (request, reply) => {
    const { family, file } = request.params as { family: string; file: string };
    const fontPath = `${family}/${file}`;
    if (!FONT_PATHS.has(fontPath)) {
      return sendError(reply, 404, "NOT_FOUND", "Font not found");
    }
    const data = await fs.readFile(path.join(FONTS_DIR, family, file));
    reply.header("Content-Type", "font/woff2");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(data);
  });

  // One of the user's own saved CVs as a gallery thumbnail (dashboard and
  // Past Projects cards), rendered with the template it's saved with.
  app.get("/api/v1/cv/:id/thumbnail", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = await prisma.cVDocument.findFirst({
      where: { id, userId: request.userId },
      select: { content: true, templateId: true },
    });
    if (!document) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }
    const html = await renderCvHtml(document.content, document.templateId, {
      mode: "thumbnail",
      fontBaseUrl: fontBaseUrl(request),
    });
    return reply.send({ data: { html }, error: null });
  });

  // Live preview: renders the editor's current (possibly unsaved) content with
  // the exact template the PDF download uses, so the preview is the PDF.
  app.post("/api/v1/cv/preview", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    if (!isValidCVTemplateId(parsed.data.templateId)) {
      return sendError(reply, 400, "INVALID_TEMPLATE", `Unknown CV template: "${parsed.data.templateId}"`);
    }

    const html = await renderCvHtml(parsed.data.content, parsed.data.templateId, {
      mode: "preview",
      fontBaseUrl: fontBaseUrl(request),
      showMissing: parsed.data.showMissing,
    });
    return reply.send({ data: { html }, error: null });
  });

  // The real PDF of the editor's current (possibly unsaved, possibly
  // incomplete) content — the "Preview PDF" view, for checking page breaks.
  // Unlike the download it neither saves nor requires a finalized document.
  app.post("/api/v1/cv/preview/pdf", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }
    if (!isValidCVTemplateId(parsed.data.templateId)) {
      return sendError(reply, 400, "INVALID_TEMPLATE", `Unknown CV template: "${parsed.data.templateId}"`);
    }
    // The PDF can't stand in for a paid download: on Free (when it isn't one
    // of their unlocked CVs) and for a locked CV, it's watermarked.
    const access = await resolveAccess(request.userId);
    const tier = access?.tier ?? "free";
    const doc = parsed.data.cvDocumentId
      ? await prisma.cVDocument.findFirst({
          where: { id: parsed.data.cvDocumentId, userId: request.userId },
          select: { unlockProduct: true, lockedTier: true, unlockedAt: true },
        })
      : null;
    const watermark = doc ? isCvLocked(doc, tier) : tier === "free";
    const pdf = await renderCVDocumentToPdf(parsed.data.content, parsed.data.templateId, { watermark });
    reply.header("Content-Type", "application/pdf");
    reply.header("Cache-Control", "no-store");
    return reply.send(pdf);
  });
}
