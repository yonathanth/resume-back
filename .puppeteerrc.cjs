// Where Puppeteer keeps its Chrome (PDF downloads and template previews):
// inside the project, so a host that builds in one place and runs in another
// (Render's Node runtime) still has it at run time. PUPPETEER_CACHE_DIR, when
// set (the Dockerfile sets it), takes precedence over this.
const { join } = require("path");

module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
