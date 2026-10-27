// Last line of defence: refuse to run against anything but a local database.
// A test run truncates tables — pointed at Neon it would wipe real users.
const url = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(`Refusing to run tests against non-local database host "${url.hostname}". Set TEST_DATABASE_URL to a throwaway local database.`);
}
if (!url.pathname.includes("test")) {
  throw new Error(`Refusing to run tests against database "${url.pathname}" — its name must contain "test".`);
}
