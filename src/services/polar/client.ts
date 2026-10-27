import { createPolar } from "@polar-sh/sdk/2026-10";
import { env } from "../../config/env";

// Singleton, same convention as db/client.ts's Prisma client — every Polar
// API call in this codebase goes through this one instance. The 1.0
// prerelease line dropped the `new Polar(...)` class in favor of a
// `createPolar(options)` factory returning per-resource services
// (`.checkouts`, `.subscriptions`, ...), and renamed `server` to
// `environment` — `accessToken` is unchanged.
export const polarClient = createPolar({
  accessToken: env.POLAR_ACCESS_TOKEN,
  environment: env.POLAR_SERVER,
});
