# GoMoxie admin dashboard — operator guide

The admin dashboard lives in the frontend at `/admin` and talks to `/api/v1/admin/*` on this backend. It uses the same
accounts and sessions as the app: an admin is a normal `User` row with `role = "ADMIN"`. Every admin endpoint checks
the role **from the database on each request**, plus a per-route permission (`src/services/admin/permissions.ts`).

## 1. Apply the database migration

`prisma/migrations/20261013120000_add_admin_platform` is **additive only**. It adds new tables (Entitlement,
PlatformSetting, AdminAuditLog, AiUsageEvent, EmailLog, Notification, UserNotification, PushSubscription,
PasswordResetToken) and new nullable/defaulted columns on `User` and `WebhookEvent`. It backfills the new
`freeXUses` counters from the existing `freeXUsed` flags. It drops or rewrites nothing.

```bash
npm run migrate:deploy        # prisma migrate deploy — applies only pending migrations
```

Never use `prisma migrate dev` / `migrate reset` or a shadow database against the shared Neon database. This
project's migration history doesn't fully match the schema: some columns were added with `db push`, so a reset would
wipe real data.

## 2. Create the first admin

The admin account is created on the server, never through the web:

```bash
npm run admin:create                          # prompts for email + password (hidden), min 12 chars
npm run admin:create -- --email=you@domain.com
npm run admin:create -- --promote --email=existing@user.com   # make an existing account an admin (password unchanged)
npm run admin:create -- --reset-password --email=you@domain.com
npm run admin:create -- --list
npm run admin:create -- --demote --email=other@admin.com      # refuses to demote the last admin
# after `npm run build`, in production:
npm run admin:create:prod
```

Rerunning is safe. An existing admin is left untouched unless you pass `--reset-password`, and an existing normal
user is only promoted with an explicit `--promote`. If you prefer environment variables, set `ADMIN_EMAIL` /
`ADMIN_PASSWORD` for that single run and unset them afterwards. The password is never accepted as a command-line
argument.

Then sign in at `<FRONTEND_URL>/admin/login`. Change your password later under **Platform Settings → Your admin
account**. If you lose it, use `--reset-password` on the server.

## 3. Environment variables (backend)

| Variable | Needed for | Example |
| --- | --- | --- |
| `EMAIL_PROVIDER` | optional: `resend` or `console` (log only) | `resend` |
| `RESEND_API_KEY`, `EMAIL_FROM` | real email delivery (existing) | `re_xxx`, `"GoMoxie <no-reply@yourdomain.com>"` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | browser push (optional) | from `npx web-push generate-vapid-keys`, `mailto:ops@yourdomain.com` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | only for a one-off `admin:create` run | — |

No frontend variables are new. The browser never receives provider keys; the VAPID *public* key is served by
`GET /api/v1/notifications/preferences`.

## 4. Provider configuration

- **Polar access token scopes.** The billing pages read live data from Polar. The organization access token needs
  `orders:read`, `refunds:read`, `disputes:read`, `organizations:read` and `subscriptions:read`. The existing checkout
  and cancel features also need `checkouts:write` and `subscriptions:write`. Without these scopes the dashboard shows
  "Polar API unavailable: insufficient_scope" instead of numbers. Refunds and disputes are handled in the Polar
  dashboard; GoMoxie links to it.
- **Polar webhook.** Same endpoint as before (`/api/v1/webhooks/polar`). Outcomes (processed / failed / unmatched /
  ignored) are now recorded. "Retry sync" re-fetches the subscription from Polar's API; it never replays the old
  payload.
- **Email.** Resend's default limit is about 2 requests/second; announcements are throttled to match. Product
  announcements go only to verified, non-unsubscribed users, carry a one-click unsubscribe link and a
  `List-Unsubscribe` header, and are capped per send (Platform Settings).
- **Push.** Set the three VAPID variables and restart. Users opt in under Settings → Notifications. This needs https
  in production (localhost works for development). Expired subscriptions (404/410) are removed automatically.

## 5. What is enforced where

- `requireAuth` (every protected route) refuses suspended accounts with `403 ACCOUNT_SUSPENDED`. Suspension also
  revokes all refresh tokens, so sign-in, refresh and existing access tokens all stop working immediately.
- `services/access.service.ts` is the single source of truth for Pro, features, free-use limits and exemptions. It
  combines billing state, active grants and the plan settings, and `/subscriptions/status` returns the same result
  to the frontend. Grants never touch billing fields or create payments, and an expired grant stops counting on the
  next request.
- Every admin write is rate limited per admin. Admin sign-in is rate limited per IP and per email, and both successful
  and failed attempts go to the audit log.

## 6. Tests

```bash
npm run test:unit     # pure tests, no database
npm test              # unit + integration; needs a throwaway local Postgres
```

Integration tests use `TEST_DATABASE_URL`, which defaults to `postgresql://postgres@localhost:55432/fitcv_test`. They
refuse to run unless the host is localhost and the database name contains "test". To prepare that database, load the
current schema into it, for example with
`npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script | psql <TEST_DATABASE_URL>`.
Tests set every provider variable to dummy values, so they never send email or call Polar.
