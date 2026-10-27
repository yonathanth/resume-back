import { env } from "./config/env";
import { buildServer } from "./app";
import { startDeliveryRecovery } from "./services/notification.service";
import { startLifecycleEmails } from "./services/lifecycle.service";
import { checkPdfRenderer } from "./services/render.service";

async function start() {
  const app = await buildServer();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Start Chrome now, so a missing or broken one shows up in /health (and the
  // logs) at deploy time, not on someone's first PDF download.
  void checkPdfRenderer().then((ok) => {
    if (!ok) app.log.error("PDF renderer unavailable: Chrome could not start. PDF downloads will fail until it's fixed.");
  });

  // Finish announcements a previous run (or another server) left half-sent.
  startDeliveryRecovery();
  // Welcome / first-CV nudge / download reminder for new accounts (off until an admin enables it).
  startLifecycleEmails();
}

start();
