import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { requireAuth } from "../middleware/auth.middleware";
import { sendError } from "../utils/http-error";
import { env } from "../config/env";
import { runImportExtraction, type ImportFileType } from "../services/importExtraction.service";
import { applyImportSchema } from "../schemas/import.schema";
import { mergeEmptyFields } from "../utils/merge-content";
import { assertFeatureAccess, FeatureUnavailableError, ProFeatureRequiredError } from "../services/access.service";

const EXT_TO_FILE_TYPE: Record<string, ImportFileType> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
};

// A CV import is a raw-file capture step; what it feeds (a CV, and through
// it a career profile) is decided later.
async function handleImportUpload(request: FastifyRequest, reply: FastifyReply) {
  const file = await request.file();
  if (!file) {
    return sendError(reply, 400, "NO_FILE", "No file was uploaded");
  }

  const ext = path.extname(file.filename).toLowerCase();
  const fileType = EXT_TO_FILE_TYPE[ext];
  if (!fileType) {
    return sendError(reply, 400, "UNSUPPORTED_FILE_TYPE", "Accepted file types: pdf, docx, png, jpg, jpeg");
  }

  let buffer: Buffer;
  try {
    buffer = await file.toBuffer();
  } catch {
    return sendError(reply, 413, "FILE_TOO_LARGE", `File exceeds the ${env.MAX_UPLOAD_MB}MB upload limit`);
  }

  let cvImport = await prisma.cVImport.create({
    data: {
      userId: request.userId,
      fileType,
      status: "pending",
    },
  });

  try {
    const { rawText, extractedData } = await runImportExtraction(buffer, fileType);
    cvImport = await prisma.cVImport.update({
      where: { id: cvImport.id },
      data: {
        rawText,
        extractedData: extractedData as Prisma.InputJsonValue,
        status: "complete",
      },
    });
  } catch (err) {
    cvImport = await prisma.cVImport.update({
      where: { id: cvImport.id },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : "Extraction failed",
      },
    });
  }

  return reply.code(201).send({ data: cvImport, error: null });
}

export async function importRoutes(app: FastifyInstance) {
  app.post("/api/v1/imports", { preHandler: requireAuth }, async (request, reply) => {
    try {
      await assertFeatureAccess(request.userId, "cvImport");
    } catch (err) {
      if (err instanceof ProFeatureRequiredError) return sendError(reply, 402, "PRO_REQUIRED", err.message);
      if (err instanceof FeatureUnavailableError) return sendError(reply, 403, "FEATURE_UNAVAILABLE", err.message);
      throw err;
    }
    return handleImportUpload(request, reply);
  });

  app.get("/api/v1/imports/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const cvImport = await prisma.cVImport.findFirst({
      where: { id, userId: request.userId },
    });
    if (!cvImport) {
      return sendError(reply, 404, "IMPORT_NOT_FOUND", "Import not found");
    }

    return reply.send({ data: cvImport, error: null });
  });

  app.post("/api/v1/imports/:id/apply", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = applyImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body");
    }

    const cvImport = await prisma.cVImport.findFirst({
      where: { id, userId: request.userId },
    });
    if (!cvImport) {
      return sendError(reply, 404, "IMPORT_NOT_FOUND", "Import not found");
    }

    const cvDocument = await prisma.cVDocument.findFirst({
      where: { id: parsed.data.cvDocumentId, userId: request.userId },
    });
    if (!cvDocument) {
      return sendError(reply, 404, "CV_DOCUMENT_NOT_FOUND", "CV document not found");
    }

    const extractedData = (cvImport.extractedData ?? {}) as Record<string, unknown>;
    const existingContent = (cvDocument.content ?? {}) as Record<string, unknown>;
    const mergedContent = mergeEmptyFields(existingContent, extractedData);

    const updatedDocument = await prisma.$transaction(async (tx) => {
      await tx.cVImport.update({
        where: { id: cvImport.id },
        data: { cvDocumentId: cvDocument.id },
      });

      return tx.cVDocument.update({
        where: { id: cvDocument.id },
        data: { content: mergedContent as Prisma.InputJsonValue },
      });
    });

    return reply.send({ data: updatedDocument, error: null });
  });
}
