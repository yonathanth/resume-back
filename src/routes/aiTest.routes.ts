import type { FastifyInstance } from "fastify";
import path from "node:path";
import { env } from "../config/env";
import { sendError } from "../utils/http-error";
import { runImportExtraction, type ImportFileType } from "../services/importExtraction.service";
import { generateCVContent } from "../services/aiGeneration.service";

/**
 * TEMPORARY, NO-AUTH endpoint for manually testing raw Groq CV generation
 * output — bypasses profile/CVDocument creation entirely. Accepts a CV file
 * upload and/or free-text description, with or without a job description.
 * Remove before shipping to production.
 */

const EXT_TO_FILE_TYPE: Record<string, ImportFileType> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
};

interface TestGenerateFields {
  description?: string;
  sourceText?: string;
  jobDescription?: string;
  templateId?: string;
  enhancementLevel?: string;
  name?: string;
  email?: string;
}

export async function aiTestRoutes(app: FastifyInstance) {
  app.post("/api/v1/test/generate-cv", async (request, reply) => {
    const fields: TestGenerateFields = {};
    let fileBuffer: Buffer | undefined;
    let fileType: ImportFileType | undefined;

    if (request.isMultipart()) {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const ext = path.extname(part.filename).toLowerCase();
          const matchedType = EXT_TO_FILE_TYPE[ext];
          if (!matchedType) {
            return sendError(reply, 400, "UNSUPPORTED_FILE_TYPE", "Accepted file types: pdf, docx, png, jpg, jpeg");
          }
          try {
            fileBuffer = await part.toBuffer();
          } catch {
            return sendError(reply, 413, "FILE_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_MB}MB upload limit`);
          }
          fileType = matchedType;
        } else if (part.type === "field") {
          (fields as Record<string, string>)[part.fieldname] = String(part.value);
        }
      }
    } else {
      Object.assign(fields, (request.body as TestGenerateFields) ?? {});
    }

    try {
      let sourceText = (fields.description ?? fields.sourceText ?? "").trim();

      if (fileBuffer && fileType) {
        const { rawText } = await runImportExtraction(fileBuffer, fileType);
        sourceText = [rawText, sourceText].filter(Boolean).join("\n\n");
      }

      if (!sourceText) {
        return sendError(reply, 400, "NO_SOURCE", "Provide a CV file upload and/or a description");
      }

      const result = await generateCVContent({
        sourceText,
        jobDescription: fields.jobDescription?.trim() || undefined,
        templateId: fields.templateId?.trim() || "default",
        enhancementLevel: fields.enhancementLevel ? Number(fields.enhancementLevel) : undefined,
        name: fields.name?.trim() || undefined,
        email: fields.email?.trim() || undefined,
      });

      return reply.send({ data: result, error: null });
    } catch (err) {
      return sendError(reply, 500, "AI_GENERATION_FAILED", err instanceof Error ? err.message : "AI generation failed");
    }
  });
}
