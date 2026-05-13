import puppeteer from "puppeteer";

const DEFAULT_MAX = 100;
const DEFAULT_CATEGORY_SEGMENT = "handphone-tablet/handphone";
const DEFAULT_CATEGORY_URL = `https://www.tokopedia.com/p/${DEFAULT_CATEGORY_SEGMENT}`;
const RATING_SCALE = 5;

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LIST_ROOT = '[data-testid="lstCL2ProductList"]';
const PRODUCT_LINK = 'a[data-testid="lnkProductContainer"][href]';

function printHelp() {
  console.log(`Usage: node src/scrape.js [options]

Options:
  -n, --num <number>        How many product URLs to collect (default: ${DEFAULT_MAX})
  -c, --category <path>     Category path or full listing URL (default: /${DEFAULT_CATEGORY_SEGMENT})
  --show-detail[=true|false] After listing URLs, open each PDP and scrape name, description,
                            image, price, rating (/5), merchant (default: false)
  -h, --help                Show this message

Environment (optional overrides):
  SCRAPE_MAX_PRODUCTS       Same as --num
  SCRAPE_URL                Full category URL (used when --category is omitted)
`);
}

function resolveCategoryUrl(raw) {
  if (!raw?.trim()) return DEFAULT_CATEGORY_URL;
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return s;
  let path = s.startsWith("/") ? s : `/${s}`;
  if (!path.startsWith("/p/")) path = `/p${path}`;
  return `https://www.tokopedia.com${path}`;
}

function parseShowDetail(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--show-detail") {
      const next = argv[i + 1];
      if (
        next === "true" ||
        next === "false" ||
        next === "1" ||
        next === "0"
      ) {
        const on = next === "true" || next === "1";
        return on;
      }
      return true;
    }
    if (a.startsWith("--show-detail=")) {
      const v = a.slice("--show-detail=".length).trim().toLowerCase();
      return v === "true" || v === "1";
    }
  }
  return false;
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
    if (a === "--show-detail") {
      const next = argv[i + 1];
      if (
        next === "true" ||
        next === "false" ||
        next === "1" ||
        next === "0"
      ) {
        i += 1;
      }
      continue;
    }
    if (a.startsWith("--show-detail=")) {
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

  const showDetail = parseShowDetail(argv);

  return { maxProducts, categoryUrl, showDetail };
}

const { maxProducts: MAX_PRODUCTS, categoryUrl, showDetail: SHOW_DETAIL } =
  parseCli();

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

async function nudgePdpScroll(page) {
  await page.evaluate(() => {
    const block = document.querySelector("#pdp_comp-product_content");
    if (block) block.scrollIntoView({ block: "start", behavior: "instant" });
    window.scrollBy({ top: 420, left: 0, behavior: "instant" });
    window.scrollBy({ top: 900, left: 0, behavior: "instant" });
  });
  await new Promise((r) => setTimeout(r, 900));
}

async function scrapeOneProductDetail(page, productUrl) {
  await page.goto(productUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await nudgePdpScroll(page);
  await page
    .waitForSelector("#pdp_comp-product_content", { timeout: 45_000 })
    .catch(() => {});

  const detail = await page.evaluate((ratingScale) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const text = (sel) => norm(document.querySelector(sel)?.textContent);

    const name =
      text('[data-testid="lblPDPDetailProductName"]') ||
      text("#pdp_comp-product_content h1");

    const price = text('[data-testid="lblPDPDetailProductPrice"]');

    const ratingRaw = text('[data-testid="lblPDPDetailProductRatingNumber"]');
    let rating = null;
    if (ratingRaw) {
      const n = Number.parseFloat(ratingRaw.replace(",", "."));
      rating = Number.isFinite(n) ? n : null;
    }

    const description =
      text('[data-testid="lblPDPDescriptionProduk"]') ||
      text('[data-testid="lblPDPDescription"]') ||
      text('[data-testid="pdpProductDescription"]') ||
      text("#pdp_comp-product_detail_desk") ||
      text("#pdp_comp-ldp") ||
      "";

    const imgEl =
      document.querySelector("#pdp_comp-product_main_media img") ||
      document.querySelector('[data-testid="PDPImagePrimary"] img') ||
      document.querySelector("#pdp_comp-product_content img");
    const imageLink =
      imgEl?.getAttribute("src") ||
      imgEl?.getAttribute("data-src") ||
      document
        .querySelector('meta[property="og:image"]')
        ?.getAttribute("content") ||
      null;

    const merchantName =
      text('[data-testid="llbPDPFooterShopName"]') ||
      text('[data-testid="lblPDPShopName"]') ||
      text('a[data-testid="lnkSellerName"]') ||
      text('[data-testid="pdpShopName"]') ||
      text('[data-testid="llsPDPShopName"]') ||
      text('[data-testid="lblPDPShopMerchantName"]') ||
      null;

    return {
      name: name || null,
      description: description || null,
      imageLink: imageLink || null,
      price: price || null,
      rating,
      ratingOutOf: ratingScale,
      merchantName,
    };
  }, RATING_SCALE);

  return detail;
}

async function enrichWithProductDetails(browser, urls) {
  const page = await browser.newPage();
  await page.setUserAgent(chromeUserAgent);
  await page.setViewport({ width: 1280, height: 800 });
  const products = [];

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const detail = await scrapeOneProductDetail(page, url);
      products.push({ url, detail });
      if (i < urls.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  } finally {
    await page.close();
  }

  return products;
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-http2"],
  });

  try {
    const { urls, pagesOpened } = await scrapeTopProductUrls(browser);

    if (SHOW_DETAIL) {
      const products = await enrichWithProductDetails(browser, urls);
      console.log(
        JSON.stringify(
          {
            categoryUrl,
            maxProducts: MAX_PRODUCTS,
            count: urls.length,
            pagesOpened,
            showDetail: true,
            products,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          {
            categoryUrl,
            maxProducts: MAX_PRODUCTS,
            count: urls.length,
            pagesOpened,
            showDetail: false,
            productUrls: urls,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
