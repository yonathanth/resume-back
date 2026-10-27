import puppeteer from "puppeteer";
import { renderCvHtml } from "./src/services/render.service";
import { LANDING_STORIES } from "./src/config/landing-stories";
import { sampleCvFor } from "./src/config/sample-cv";
const OUT = process.argv[2];
const pairs: [string, string][] = [["hana", "classic"], ["daniel", "spark"], ["sara", "midnight"], ["mateo", "linen"]];
(async () => {
  const b = await puppeteer.launch({ headless: true });
  for (const [story, tpl] of pairs) {
    for (const [label, content] of [["story", LANDING_STORIES[story]], ["sample", sampleCvFor(tpl)]] as const) {
      const html = await renderCvHtml(content, tpl, { mode: "pdf" });
      const pg = await b.newPage();
      await pg.setViewport({ width: 794, height: 1123 });
      await pg.setContent(html, { waitUntil: "load" });
      await pg.evaluateHandle("document.fonts.ready");
      // Lowest bottom edge of any text-bearing element on the first sheet
      const bottom = await pg.evaluate(() => {
        let max = 0;
        document.querySelectorAll("body *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.height < 1000 && (el as HTMLElement).innerText?.trim()) max = Math.max(max, r.bottom);
        });
        return Math.round(max);
      });
      const pdf = await pg.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
      const pages = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
      await pg.screenshot({ path: `${OUT}/${tpl}-${label}.png`, clip: { x: 0, y: 0, width: 794, height: 1123 } });
      console.log(`${tpl.padEnd(9)} ${label.padEnd(6)} pages=${pages} contentBottom=${bottom}px of 1123`);
      await pg.close();
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
