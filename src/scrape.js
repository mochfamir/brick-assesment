import puppeteer from "puppeteer";

const DEFAULT_MAX = 100;
const DEFAULT_CATEGORY_SEGMENT = "handphone-tablet/handphone";
const DEFAULT_CATEGORY_URL = `https://www.tokopedia.com/p/${DEFAULT_CATEGORY_SEGMENT}`;

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LIST_ROOT = '[data-testid="lstCL2ProductList"]';
const PRODUCT_LINK = 'a[data-testid="lnkProductContainer"][href]';

function printHelp() {
  console.log(`Usage: node src/scrape.js [options]

Options:
  -n, --num <number>        How many product URLs to collect (default: ${DEFAULT_MAX})
  -c, --category <path>     Category path or full listing URL (default: /${DEFAULT_CATEGORY_SEGMENT})
                            Examples: handphone-tablet/handphone
                                      /handphone-tablet/handphone
                                      https://www.tokopedia.com/p/handphone-tablet/handphone
  -h, --help                Show this message

Environment (optional overrides):
  SCRAPE_MAX_PRODUCTS       Same as --num
  SCRAPE_URL                Full category URL (used when --category is omitted)
`);
}

/**
 * Tokopedia category: default segment "handphone-tablet/handphone" under /p/…
 */
function resolveCategoryUrl(raw) {
  if (!raw?.trim()) return DEFAULT_CATEGORY_URL;
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return s;
  let path = s.startsWith("/") ? s : `/${s}`;
  if (!path.startsWith("/p/")) path = `/p${path}`;
  return `https://www.tokopedia.com${path}`;
}

function parseCli() {
  const argv = process.argv;
  let num = null;
  let category = null;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
    if (a === "--num" || a === "-n") {
      num = Number.parseInt(argv[++i] ?? "", 10);
      continue;
    }
    if (a === "--category" || a === "-c") {
      category = argv[++i] ?? "";
      continue;
    }
  }

  const maxProducts =
    (Number.isFinite(num) && num > 0 ? num : null) ??
    (Number.parseInt(process.env.SCRAPE_MAX_PRODUCTS ?? "", 10) || DEFAULT_MAX);

  const categoryUrl = category
    ? resolveCategoryUrl(category)
    : process.env.SCRAPE_URL?.trim()
      ? resolveCategoryUrl(process.env.SCRAPE_URL)
      : DEFAULT_CATEGORY_URL;

  return { maxProducts, categoryUrl };
}

const { maxProducts: MAX_PRODUCTS, categoryUrl } = parseCli();

function listingUrlForPage(baseHref, pageNum) {
  const u = new URL(baseHref);
  if (pageNum <= 1) u.searchParams.delete("page");
  else u.searchParams.set("page", String(pageNum));
  return u.href;
}

function dedupeKey(href) {
  try {
    return new URL(href).pathname;
  } catch {
    return href;
  }
}

/** Remove query (and hash) before persisting / emitting. */
function productUrlWithoutQuery(href) {
  try {
    const u = new URL(href);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    const i = href.indexOf("?");
    return i === -1 ? href : href.slice(0, i);
  }
}

async function nudgeListScroll(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="lstCL2ProductList"]');
    if (root) root.scrollIntoView({ block: "start", behavior: "instant" });
    window.scrollBy({ top: 480, left: 0, behavior: "instant" });
  });
  await new Promise((r) => setTimeout(r, 1200));
}

async function collectHrefsFromListPage(page) {
  await page.waitForSelector(LIST_ROOT, { timeout: 60_000 });
  await nudgeListScroll(page);

  return page.evaluate((listSel, linkSel) => {
    const root = document.querySelector(listSel);
    if (!root) return [];
    return [...root.querySelectorAll(linkSel)]
      .map((a) => a.getAttribute("href") || "")
      .filter(Boolean)
      .map((h) => {
        try {
          return new URL(h, window.location.href).href;
        } catch {
          return h;
        }
      });
  }, LIST_ROOT, PRODUCT_LINK);
}

async function scrapeTopProductUrls(browser) {
  const seen = new Set();
  const urls = [];
  let listPage = 1;
  let pagesOpened = 0;

  const page = await browser.newPage();
  await page.setUserAgent(chromeUserAgent);
  await page.setViewport({ width: 1280, height: 800 });

  try {
    while (urls.length < MAX_PRODUCTS) {
      const target = listingUrlForPage(categoryUrl, listPage);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
      pagesOpened += 1;

      const batch = await collectHrefsFromListPage(page);
      let addedThisRound = 0;

      for (const href of batch) {
        const key = dedupeKey(href);
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(productUrlWithoutQuery(href));
        addedThisRound += 1;
        if (urls.length >= MAX_PRODUCTS) break;
      }

      if (urls.length >= MAX_PRODUCTS) break;
      if (batch.length === 0) break;
      if (addedThisRound === 0) break;

      listPage += 1;
    }
  } finally {
    await page.close();
  }

  return { urls, pagesOpened };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-http2"],
  });

  try {
    const { urls, pagesOpened } = await scrapeTopProductUrls(browser);
    console.log(
      JSON.stringify(
        {
          categoryUrl,
          maxProducts: MAX_PRODUCTS,
          count: urls.length,
          pagesOpened,
          productUrls: urls,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
