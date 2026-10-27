import { promises as dns } from "node:dns";

// DNS answers that mean the domain really has no mail setup. Anything else
// (timeouts, SERVFAIL) is our resolver's problem, not the user's address.
const NO_MAIL_CODES = new Set(["ENOTFOUND", "ENODATA", "ENODOMAIN", "ENONAME", "NXDOMAIN"]);

/**
 * True unless DNS says the email's domain can't receive mail: no such domain,
 * no MX records, or only a "null MX" (RFC 7505) declaring it accepts none.
 */
export async function canDomainReceiveMail(email: string): Promise<boolean> {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  try {
    const records = await dns.resolveMx(domain);
    return records.some((record) => record.exchange && record.exchange !== ".");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return !(code && NO_MAIL_CODES.has(code));
  }
}
