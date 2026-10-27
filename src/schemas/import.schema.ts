import { z } from "zod";

export const applyImportSchema = z.object({
  cvDocumentId: z.string().min(1, "cvDocumentId is required"),
});

export type ApplyImportInput = z.infer<typeof applyImportSchema>;
