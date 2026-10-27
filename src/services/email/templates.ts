// Email bodies. Same look as the original confirmation email. Everything
// inserted into HTML is escaped — announcement text is admin-written, but it
// still must never become markup.

const BRAND = "GoMoxie";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:#171717;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">${escapeHtml(label)}</a>`;
}

function layout(title: string, inner: string, footer?: string): string {
  return `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#171717">
        <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
        ${inner}
        ${footer ? `<p style="font-size:13px;line-height:1.5;color:#737373;margin:24px 0 0">${footer}</p>` : ""}
      </div>`;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function codeBox(code: string): string {
  return `<div style="background:#f5f5f5;border:1px solid #e5e5e5;border-radius:12px;padding:18px 12px;text-align:center;margin:0 0 8px">
          <span style="font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#171717;-webkit-user-select:all;user-select:all">${escapeHtml(code)}</span>
        </div>
        <p style="font-size:13px;line-height:1.5;color:#737373;margin:0">Tap the code to select it, then copy.</p>`;
}

// The code is in the subject and the inbox preview, so it can be read
// without opening the email, and set large on its own in the body. Email
// can't run a copy button; instead the code box selects as one piece on a
// tap, and mail apps detect it themselves — Gmail's "Copy code", Apple's
// code autofill above the keyboard — which is what the "verification code"
// wording next to the digits is for.
export function verificationCodeEmail(code: string, ttlMinutes: number): RenderedEmail {
  const expiry = `The code expires in ${ttlMinutes} minutes. If you didn't sign up for ${BRAND}, you can ignore this email.`;
  return {
    subject: `Your ${BRAND} verification code: ${code}`,
    text: [`Your ${BRAND} verification code is ${code}.`, "", `Enter it in ${BRAND} to finish signing up.`, "", expiry].join("\n"),
    html: `
      <div style="display:none;max-height:0;overflow:hidden">Your verification code is ${escapeHtml(code)}</div>${layout(
        "Your verification code",
        `<p style="font-size:15px;line-height:1.5;margin:0 0 16px">Enter this ${BRAND} verification code to finish signing up:</p>
        ${codeBox(code)}`,
        expiry
      )}`,
  };
}

// Sent to the NEW address when a signed-in user changes their email; same
// shape and wording as the sign-up code, so mail apps pick the code up too.
export function emailChangeCodeEmail(code: string, ttlMinutes: number): RenderedEmail {
  const footer = `The code expires in ${ttlMinutes} minutes. If you didn't ask to use this email for ${BRAND}, you can ignore this email. Nothing changes.`;
  return {
    subject: `Your ${BRAND} verification code: ${code}`,
    text: [`Your ${BRAND} verification code is ${code}.`, "", `Enter it in ${BRAND} to make this your account's email.`, "", footer].join("\n"),
    html: `
      <div style="display:none;max-height:0;overflow:hidden">Your verification code is ${escapeHtml(code)}</div>${layout(
        "Confirm your new email",
        `<p style="font-size:15px;line-height:1.5;margin:0 0 16px">Enter this ${BRAND} verification code to make this your account's email:</p>
        ${codeBox(code)}`,
        footer
      )}`,
  };
}

// Sent to the OLD address once the change is done, in case it wasn't them.
export function emailChangedNoticeEmail(newEmail: string): RenderedEmail {
  const body = `Your ${BRAND} account now uses ${newEmail}. From now on, sign in with that email.`;
  // TODO: name a real support address here once there is one.
  const warning = `If you didn't make this change, contact ${BRAND} support right away so we can secure your account.`;
  return {
    subject: `Your ${BRAND} email was changed`,
    text: [body, "", warning].join("\n"),
    html: layout(
      "Your email was changed",
      `<p style="font-size:15px;line-height:1.5;margin:0 0 16px">Your ${BRAND} account now uses <strong>${escapeHtml(newEmail)}</strong>. From now on, sign in with that email.</p>`,
      escapeHtml(warning)
    ),
  };
}

export function passwordResetEmail(link: string, ttlMinutes: number): RenderedEmail {
  return {
    subject: `Reset your ${BRAND} password`,
    text: [
      `Someone asked to reset the password for your ${BRAND} account.`,
      "",
      "Choose a new password here:",
      link,
      "",
      `This link expires in ${ttlMinutes} minutes and works once. If you didn't ask for this, you can ignore this email. Your password stays the same.`,
    ].join("\n"),
    html: layout(
      "Reset your password",
      `<p style="font-size:15px;line-height:1.5;margin:0 0 24px">Someone asked to reset the password for your ${BRAND} account. Choose a new one below.</p>${button(link, "Choose a new password")}`,
      `This link expires in ${ttlMinutes} minutes and works once. If you didn't ask for this, you can ignore this email. Your password stays the same.`
    ),
  };
}

export function announcementEmail(input: {
  title: string;
  body: string;
  actionUrl?: string | null;
  unsubscribeUrl?: string | null;
}): RenderedEmail {
  const footer = input.unsubscribeUrl
    ? `You're receiving this because you have a ${BRAND} account. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#737373">Unsubscribe from announcements</a>.`
    : `You're receiving this service notice because you have a ${BRAND} account.`;
  return {
    subject: input.title,
    text: [
      input.body,
      ...(input.actionUrl ? ["", input.actionUrl] : []),
      "",
      input.unsubscribeUrl ? `Unsubscribe from announcements: ${input.unsubscribeUrl}` : `${BRAND}`,
    ].join("\n"),
    html: layout(input.title, `${paragraphs(input.body)}${input.actionUrl ? button(input.actionUrl, "Open") : ""}`, footer),
  };
}

export function proActivatedEmail(input: { until: Date | null; dashboardUrl: string; planName?: string }): RenderedEmail {
  const until = input.until ? ` until ${input.until.toUTCString().slice(5, 16)}` : "";
  const plan = input.planName ?? "paid";
  return {
    subject: `Your ${BRAND} ${plan} plan is active`,
    text: `Thanks, your ${BRAND} ${plan} plan is active${until}.

Open your dashboard: ${input.dashboardUrl}`,
    html: layout(
      `Your ${escapeHtml(plan)} plan is active`,
      `<p style="font-size:15px;line-height:1.5;margin:0 0 24px">Thanks, your ${BRAND} ${escapeHtml(plan)} plan is active${escapeHtml(until)}.</p>${button(input.dashboardUrl, "Open dashboard")}`
    ),
  };
}

export function proEndedEmail(input: { upgradeUrl: string; planName?: string }): RenderedEmail {
  const plan = input.planName ?? "paid";
  return {
    subject: `Your ${BRAND} ${plan} plan has ended`,
    text: `Your ${BRAND} ${plan} plan has ended. Your CVs and profiles are still there. You can renew any time: ${input.upgradeUrl}`,
    html: layout(
      `Your ${escapeHtml(plan)} plan has ended`,
      `<p style="font-size:15px;line-height:1.5;margin:0 0 24px">Your ${BRAND} ${escapeHtml(plan)} plan has ended. Your CVs and profiles are still there, and you can renew any time.</p>${button(input.upgradeUrl, "See plans")}`
    ),
  };
}

export function testEmail(sentBy: string): RenderedEmail {
  return {
    subject: `${BRAND} test email`,
    text: `This is a test email from the ${BRAND} admin dashboard, sent by ${sentBy}. If you can read it, email delivery works.`,
    html: layout(
      "Test email",
      `<p style="font-size:15px;line-height:1.5;margin:0">This is a test email from the ${BRAND} admin dashboard, sent by ${escapeHtml(sentBy)}. If you can read it, email delivery works.</p>`
    ),
  };
}

// ---- Lifecycle emails (services/lifecycle.service.ts) ----
// Product emails: they carry the unsubscribe link and respect the opt-out.

function lifecycleFooter(unsubscribeUrl: string): string {
  return `You're receiving this because you recently created a ${BRAND} account. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#737373">Unsubscribe from tips and announcements</a>.`;
}

function lifecycleText(lines: string[], unsubscribeUrl: string): string {
  return [...lines, "", `Unsubscribe from tips and announcements: ${unsubscribeUrl}`].join("\n");
}

function greeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : "Hi,";
}

const INTENT_COPY: Record<"create" | "tailor" | "improve", { line: string; cta: string }> = {
  create: {
    line: "Tell us about your experience in your own words, and we'll turn it into a clean, ATS-friendly CV in a few minutes.",
    cta: "Create my CV",
  },
  tailor: {
    line: "Paste a job posting and we'll tailor your CV to it: the right keywords, your most relevant experience first.",
    cta: "Tailor my CV",
  },
  improve: {
    line: "Upload the CV you have and we'll strengthen it with clearer bullet points and stronger wording.",
    cta: "Improve my CV",
  },
};

export function welcomeEmail(input: {
  firstName: string | null;
  intent: "create" | "tailor" | "improve" | null;
  actionUrl: string;
  unsubscribeUrl: string;
}): RenderedEmail {
  const copy = INTENT_COPY[input.intent ?? "create"];
  const lines = [
    greeting(input.firstName),
    "",
    `Welcome to ${BRAND}. ${copy.line}`,
    "",
    "Your contact details are saved, so every new CV starts with them filled in.",
    "",
    `${copy.cta}: ${input.actionUrl}`,
  ];
  return {
    subject: `Welcome to ${BRAND}`,
    text: lifecycleText(lines, input.unsubscribeUrl),
    html: layout(
      `Welcome to ${BRAND}`,
      `${paragraphs(`${greeting(input.firstName)}\n\n${copy.line}\n\nYour contact details are saved, so every new CV starts with them filled in.`)}${button(input.actionUrl, copy.cta)}`,
      lifecycleFooter(input.unsubscribeUrl)
    ),
  };
}

export function firstCvNudgeEmail(input: { firstName: string | null; actionUrl: string; unsubscribeUrl: string }): RenderedEmail {
  const body = `${greeting(input.firstName)}\n\nYour first CV takes about five minutes. Answer a few questions, or upload one you already have, and you'll have a polished PDF to send today.`;
  return {
    subject: "Your CV is five minutes away",
    text: lifecycleText([body, "", `Start my CV: ${input.actionUrl}`], input.unsubscribeUrl),
    html: layout("Your CV is five minutes away", `${paragraphs(body)}${button(input.actionUrl, "Start my CV")}`, lifecycleFooter(input.unsubscribeUrl)),
  };
}

export function downloadReminderEmail(input: {
  firstName: string | null;
  cvTitle: string | null;
  actionUrl: string;
  unsubscribeUrl: string;
}): RenderedEmail {
  const which = input.cvTitle ? `"${input.cvTitle}"` : "Your CV";
  const body = `${greeting(input.firstName)}\n\n${which} is ready. You just haven't downloaded it yet. Open it to give it a last look, then download the PDF and send it out.`;
  return {
    subject: "Your CV is ready to download",
    text: lifecycleText([body, "", `Open my CV: ${input.actionUrl}`], input.unsubscribeUrl),
    html: layout("Your CV is ready to download", `${paragraphs(body)}${button(input.actionUrl, "Open my CV")}`, lifecycleFooter(input.unsubscribeUrl)),
  };
}
