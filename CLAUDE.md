# GoMoxie Backend — Claude Code Build Guide

## Database safety — read first, applies to every session

`DATABASE_URL` in `.env` is a real, shared database with real data. On 2026-10-14 it was wiped by passing it to Prisma as a shadow database. These rules are not optional:

- **Never run any command against `DATABASE_URL` that can change the database:** no `prisma migrate dev`, `migrate reset`, `migrate deploy`, `migrate resolve`, `db push`, `db execute`, and no raw SQL that writes (`DROP`, `TRUNCATE`, `DELETE`, `ALTER`, `UPDATE`, `INSERT`).
- **Never pass `DATABASE_URL` (or any URL read from `.env`) as `--shadow-database-url`** or to any other flag, and never read it out of `.env` into a command. Prisma resets a shadow database.
- **Never create, change or delete rows** in it for testing (no throwaway users either). Test with unit tests and mocks instead.
- **Migrations:** write the migration SQL by hand in `prisma/migrations/<timestamp>_<name>/migration.sql` and hand it to the user to apply. Preview SQL without any database: `npx prisma migrate diff --from-schema-datamodel <old schema file> --to-schema-datamodel prisma/schema.prisma --script`.
- **Safe:** `npx prisma generate` and `npx prisma validate` (they don't connect), and read-only `npx prisma migrate status`.
- **If unsure whether a command touches the database, don't run it — ask.**

## How to use this

Each numbered prompt below is meant to be pasted into Claude Code **as its own session** (start fresh / `/clear` between them). Don't paste the whole guide at once — that burns tokens re-explaining context Claude doesn't need yet. Each prompt already contains the schema it needs, so Claude's job is implementation, not design.

Before Prompt 1, save this whole file as `CLAUDE.md` in your project root. Claude Code reads it automatically at the start of every session, so you stop re-pasting the schema every time.

---

## The canonical CV shape (do not let this drift)

This is the one contract every future feature — manual entry, OCR import, and eventually AI generation — writes into and reads from. Nothing about *how* content gets produced should ever change this shape.

```typescript
interface CVContent {
  personal: {
    full_name: string;
    title: string;
    email: string;
    phone?: string;
    location?: string;
    links?: { label: string; url: string }[];
  };
  summary?: string;
  experience: {
    company: string;
    role: string;
    location?: string;
    start_date: string;       // "2023-01"
    end_date: string | "present";
    bullets: string[];
  }[];
  education: {
    institution: string;
    degree: string;
    field?: string;
    start_date?: string;
    end_date?: string;
    honors?: string;
  }[];
  skills: string[];
  certifications?: { name: string; issuer: string; date?: string; url?: string }[];
  projects?: { name: string; description: string; tech?: string[]; url?: string }[];
  languages?: { language: string; proficiency: string }[];
}
```

Wizard steps, in order: `personal → summary → experience → education → skills → certifications → projects → languages → review`. A `CVDocument` is "complete" only when `personal`, `experience` (≥1 entry), and `skills` (≥1 entry) are filled — everything else can stay empty.

---

## Career profiles — current design (supersedes Prompts 3–4 and the CareerProfile model below)

- One profile per user per role: `@@unique([userId, roleKey])`. `services/roleKey.service.ts` resolves a title to a roleKey (wording normalized, seniority stripped into `seniority`, snapped to the Occupation catalog). No default profile is created at registration.
- The profile *is* the data: `CareerProfile.content` is `ProfileContent` (`schemas/profile-content.schema.ts`) — CVContent sections minus contact details (those stay on User), every list item with a server-owned `id` + `meta` (source, locked, aliases).
- All content changes go through `services/profile.service.ts`: optimistic concurrency on `version`, each change recorded in `ProfileChange` with the previous content (undo).
- Merging a CV into a profile (`services/profileContent.service.ts`) is deterministic, no AI. It only adds; it never overwrites items the user edited (locked) or re-adds items they deleted (`dismissedKeys`). A CV generated against a job description contributes facts, not wording.
- Pro-only to create/change/link (`assertProAccess`); reading and deleting stay open on every plan.
- Matching a new CV to a profile (`services/profileMatch.service.ts`): same roleKey → same occupation → only then a tiny cached AI classification (`classifyRoleMatch`). "Related" roles are only ever suggested, never merged into automatically. `User.profileAutoSync` (ask | always | never) decides whether a matching profile is updated; creating a profile always asks.
- Enhance wording write-back (`wordingProposals` / `applyWording`): only entries the profile already has, never for job-tailored CVs, only the keys the user approved (recomputed server-side); approved entries become locked.

---

## Prisma schema (paste this into Prompt 2 — don't let Claude invent its own)

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  passwordHash  String
  fullName      String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  profiles      CareerProfile[]
}

model CareerProfile {
  id         String   @id @default(uuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  title      String              // "Marketing Manager", "Backend Developer"
  isPrimary  Boolean  @default(false)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  documents  CVDocument[]
  imports    CVImport[]
}

model CVDocument {
  id          String   @id @default(uuid())
  userId      String
  profileId   String
  profile     CareerProfile @relation(fields: [profileId], references: [id])
  templateId  String   @default("professional")   // professional | modern | minimal
  content     Json                                  // matches CVContent — validate with Zod on every write
  currentStep String   @default("personal")         // tracks wizard progress
  status      String   @default("draft")            // draft | final
  source      String   @default("manual")           // manual | ocr | ai  (only field that changes when AI is added)
  pdfPath     String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model CVImport {
  id             String   @id @default(uuid())
  userId         String
  profileId      String
  profile        CareerProfile @relation(fields: [profileId], references: [id])
  cvDocumentId   String?                             // linked once user applies it to a draft
  fileType       String                              // pdf | docx | image
  filePath       String                              // local disk path (see UPLOAD_DIR)
  rawText        String?                             // full extracted text, always populated on success
  extractedData  Json?                                // best-effort Partial<CVContent> from heuristics
  status         String   @default("pending")        // pending | complete | failed
  error          String?
  createdAt      DateTime @default(now())
}
```

**Why `CVImport` is separate from `CVDocument`:** OCR/text extraction is a one-way capture step, not a draft. The person reviews `rawText` + whatever `extractedData` heuristics could confidently guess (email, phone, dates via regex), then copies/confirms fields into an actual `CVDocument` through the normal wizard endpoints. When AI extraction replaces the heuristics later, it just fills `extractedData` more completely — the review-and-confirm flow into `CVDocument` doesn't change at all.

---

## Environment variables

```bash
# Database — Neon (https://neon.tech), free tier, standard Postgres
DATABASE_URL=postgresql://user:pass@ep-xxxx.neon.tech/fitcv?sslmode=require

# Auth
JWT_ACCESS_SECRET=<generate a long random string>
JWT_REFRESH_SECRET=<generate a different long random string>

# File uploads (local disk for now — no third-party storage needed yet)
UPLOAD_DIR=./uploads
MAX_UPLOAD_MB=10

# App
PORT=8000
NODE_ENV=development
```

Nothing else. No AI keys, no payment keys, no cloud storage keys — add those only when you build those specific features, in their own later session.

---

## Prompt 1 — Scaffold

```
Set up a new Node.js + TypeScript backend using Fastify.

Requirements:
- TypeScript, strict mode
- Fastify with @fastify/cors and @fastify/multipart plugins installed
- Prisma installed and initialized (schema.prisma pointing at DATABASE_URL from .env)
- Folder structure:
  src/
    server.ts
    config/env.ts       (load + validate env vars with zod, fail fast if missing)
    db/client.ts         (Prisma client singleton)
    routes/
    services/
    schemas/             (zod validation schemas)
    middleware/
- A GET /health route returning { status: "ok" }
- docker-compose.yml with just a local Postgres service for local dev (in case I don't use Neon locally)
- package.json scripts: dev, build, start, migrate

Do not add any authentication, business logic, or AI-related code yet — this prompt is scaffolding only.
```

---

## Prompt 2 — Database schema

```
Here is the exact Prisma schema for this project. Use it exactly as written — do not add, rename, or restructure fields.

[paste the full Prisma schema block from above]

Tasks:
1. Put this into prisma/schema.prisma
2. Run the initial migration
3. Confirm the generated Prisma client types match the schema
4. Create src/schemas/cv-content.schema.ts — a Zod schema that validates the CVContent shape:

[paste the CVContent TypeScript interface from above]

Export a `validateCVContent` function and a `PartialCVContent` schema (same shape, all fields optional/deep-partial) for use when saving OCR-extracted data.
```

---

## Prompt 3 — Auth

```
Implement authentication using the User model from schema.prisma.

Endpoints:
- POST /api/v1/auth/register — email + password, bcrypt hash (cost 12), create a default CareerProfile (title: "My Career", isPrimary: true) in the same transaction
- POST /api/v1/auth/login — verify password, issue access token (15 min) and refresh token (7 days, httpOnly cookie)
- POST /api/v1/auth/refresh — rotate access token from a valid refresh cookie
- POST /api/v1/auth/logout — clear refresh cookie

Also add a Fastify pre-handler `requireAuth` that verifies the access token from the Authorization header and attaches `userId` to the request. Apply it as a reusable decorator so future routes just declare `{ preHandler: requireAuth }`.

Use Zod to validate all request bodies. Return errors in this shape: { data: null, error: { code, message } }.
```

---

## Prompt 4 — Career profiles

```
Implement CRUD for CareerProfile, scoped to the authenticated user (requireAuth on every route).

Endpoints:
- POST /api/v1/profiles — create { title }
- GET /api/v1/profiles — list all profiles for the current user, each with a count of associated cvDocuments
- GET /api/v1/profiles/:id — full detail (404 if not owned by current user)
- PATCH /api/v1/profiles/:id — update title and/or isPrimary (only one profile per user may be isPrimary=true — unset the previous one in the same transaction)
- DELETE /api/v1/profiles/:id — reject with 400 if it's the user's only profile; reject with 409 if it has cvDocuments unless ?force=true is passed

Every query must filter by the authenticated userId — never trust a client-supplied user id.
```

---

## Prompt 5 — CV documents (step-by-step wizard)

```
Implement the CV document wizard using the CVDocument model. The wizard steps in order are:
personal, summary, experience, education, skills, certifications, projects, languages, review

Endpoints:
- POST /api/v1/cv — create a new draft { profileId, templateId } — content starts as an empty object matching the CVContent shape's structure (empty arrays for list fields), currentStep: "personal"
- GET /api/v1/cv/:id — full document detail
- GET /api/v1/cv?profileId= — list documents for a profile
- PATCH /api/v1/cv/:id/step/:stepName — updates only that section of `content` (e.g. PATCH /cv/abc/step/experience with body { experience: [...] }), validates just that section against cv-content.schema.ts, advances currentStep to the next step in the sequence if this was the current step, does not touch other sections
- POST /api/v1/cv/:id/finalize — validates the full document against validateCVContent (personal, experience with ≥1 entry, and skills with ≥1 entry are required; everything else optional), sets status to "final", rejects with 422 if required fields are missing and returns which fields are missing
- DELETE /api/v1/cv/:id

All routes require requireAuth and must verify the document belongs to the current user via its profile's userId.
```

---

## Prompt 6 — CV import via file upload (OCR / text extraction, no AI)

```
Implement uploading an existing CV file and extracting its text — no AI involved, this is deterministic text extraction only.

Endpoint:
POST /api/v1/profiles/:profileId/import

Accepts multipart/form-data, field name "file". Accepted types: pdf, docx, png, jpg, jpeg. Max size from MAX_UPLOAD_MB env var.

Processing:
1. Save the file to UPLOAD_DIR/{userId}/{uuid}-{originalname}
2. Create a CVImport row with status "pending"
3. Based on file type, extract raw text:
   - pdf → use pdf-parse
   - docx → use mammoth (extractRawText)
   - png/jpg/jpeg → use tesseract.js for OCR
4. Run lightweight regex heuristics against the extracted text to populate extractedData as a best-effort Partial<CVContent> — only extract what's unambiguous: email (regex), phone (regex), and a full_name guess (first non-empty line if it looks like a name, otherwise leave blank). Do not attempt to parse experience, education, or skills with regex — leave those out of extractedData entirely; the rawText field is what the user will read to fill those in manually.
5. Update the CVImport row: rawText, extractedData, status "complete" (or "failed" with an error message if extraction throws)
6. Return the full CVImport record

Also add:
- GET /api/v1/profiles/:profileId/imports — list past imports for a profile
- GET /api/v1/imports/:id — full detail including rawText, for the review screen
- POST /api/v1/imports/:id/apply — body { cvDocumentId }, merges extractedData into that CVDocument's content (only overwriting fields that are currently empty, never clobbering data the user already entered), links cvImport.cvDocumentId

This entire extraction step is designed to be replaced later by an AI-based structured extraction that fills extractedData more completely — do not build anything here that assumes regex is the permanent approach. Keep the extraction logic in its own service file (src/services/importExtraction.service.ts) so it can be swapped without touching the routes.
```

---

## Prompt 7 — Templates and PDF rendering

```
Implement CV rendering using Handlebars templates and Puppeteer.

Setup:
- src/templates/professional.html, modern.html, minimal.html — each a full HTML document with Handlebars placeholders matching the CVContent shape exactly (e.g. {{personal.full_name}}, {{#each experience}}...{{/each}}). Keep the actual visual design simple for now — clean, readable, single-column — since this will be restyled later.
- Each template must render gracefully when optional sections (certifications, projects, languages) are empty or missing — use Handlebars {{#if}} to hide empty sections entirely, not show empty headers.

Endpoint:
POST /api/v1/cv/:id/render
- Loads the CVDocument, requires status "final" (400 if still "draft")
- Picks the template file matching cvDocument.templateId
- Compiles with Handlebars using cvDocument.content as data
- Renders to PDF with Puppeteer (launch headless, setContent, pdf({ format: "A4" }))
- Saves the PDF to UPLOAD_DIR/{userId}/cvs/{cvDocumentId}.pdf
- Updates cvDocument.pdfPath
- Returns { pdfPath }

GET /api/v1/cv/:id/download
- Streams the PDF file from pdfPath if it exists, 404 if not yet rendered
```

---

## Prompt 8 — Validation, error handling, and tests

```
Add production-quality hardening across the whole app:

1. A global Fastify error handler that catches unhandled errors and always responds in the { data: null, error: { code, message } } shape — never leak stack traces in production (NODE_ENV check)
2. Rate limiting via @fastify/rate-limit — 60 req/min per IP globally, 10 req/min on /api/v1/profiles/:id/import specifically
3. Request logging (pino, Fastify's built-in logger) — log method, path, status, duration, but never log request bodies (avoid logging passwords/file contents)
4. Tests (vitest or jest, your choice) covering:
   - auth: register, login, invalid password, expired token
   - profiles: CRUD, ownership enforcement (user A cannot access user B's profile)
   - cv documents: step updates, finalize with missing required fields returns 422
   - imports: successful pdf extraction (use a small fixture file), apply merges without clobbering
```

---

## After this: adding AI later

When you're ready, the only new work is:
1. A new endpoint `POST /api/v1/cv/:id/generate-from-import/:importId` (or similar) that sends `rawText` to Claude and gets back a fully-shaped `CVContent` object
2. Write that object into the same `content` column with `source: "ai"`
3. Everything else — finalize, render, download, templates — needs zero changes, because they were always built against the `CVContent` contract, not against who produced it.