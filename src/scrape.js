import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import puppeteer from "puppeteer";

const DEFAULT_MAX = 100;
const DEFAULT_CATEGORY_SEGMENT = "handphone-tablet/handphone";
const DEFAULT_CATEGORY_URL = `https://www.tokopedia.com/p/${DEFAULT_CATEGORY_SEGMENT}`;
const RATING_SCALE = 5;

function parseTokopediaPriceToInt(priceDisplay) {
  if (priceDisplay == null) return null;
  if (typeof priceDisplay === "number" && Number.isFinite(priceDisplay)) {
    return Math.round(priceDisplay);
  }
  const s = String(priceDisplay)
    .replace(/^rp\s*/i, "")
    .replace(/\s/g, "")
    .trim();
  if (!s) return null;
  const digitsOnly = s.replace(/\./g, "").replace(/,/g, "");
  const n = Number.parseInt(digitsOnly, 10);
  return Number.isFinite(n) ? n : null;
}

function finalizeProductDetail(part) {
  const outOf = part.ratingOutOf ?? RATING_SCALE;
  const price = parseTokopediaPriceToInt(part.price);

  let rating = null;
  if (part.rating != null && Number.isFinite(Number(part.rating))) {
    const r = Number(part.rating);
    const left = Number.isInteger(r) ? String(r) : String(r);
    rating = `${left}/${outOf}`;
  }

  return {
    name: part.name ?? null,
    description: part.description ?? null,
    imageLink: part.imageLink ?? null,
    price,
    rating,
    merchantName: part.merchantName ?? null,
  };
}

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
  -j, --concurrency <n>     Parallel PDP tabs when --show-detail (default: 4, max: 8)
  --cheerio[=true|false]   With --show-detail, fetch PDP HTML and parse with Cheerio
                            (faster; needs SSR/markup in response — else fields may be empty)
  --format <json|csv>      stdout format (default: json). Shorthand: --csv
  -o, --out <path>         Write result to this file as UTF-8 (recommended on Windows
                            instead of PowerShell ">" which may use UTF-16 and break CSV in Excel)
  -h, --help                Show this message

Environment (optional overrides):
  SCRAPE_MAX_PRODUCTS       Same as --num
  SCRAPE_URL                Full category URL (used when --category is omitted)
  SCRAPE_CONCURRENCY        Same as --concurrency
  SCRAPE_FORMAT             json or csv (same as --format)
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

function parseCheerio(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cheerio") {
      const next = argv[i + 1];
      if (next === "false" || next === "0") return false;
      if (next === "true" || next === "1") return true;
      return true;
    }
    if (a.startsWith("--cheerio=")) {
      const v = a.slice("--cheerio=".length).trim().toLowerCase();
      return v === "true" || v === "1";
    }
  }
  return false;
}

function parseCli() {
  const argv = process.argv;
  let num = null;
  let category = null;
  let concurrency = null;
  let formatArg = null;
  let outPath = null;

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
    if (a === "--concurrency" || a === "-j") {
      concurrency = Number.parseInt(argv[++i] ?? "", 10);
      continue;
    }
    if (a === "--format") {
      formatArg = (argv[++i] ?? "").trim().toLowerCase();
      continue;
    }
    if (a.startsWith("--format=")) {
      formatArg = a.slice("--format=".length).trim().toLowerCase();
      continue;
    }
    if (a === "--csv") {
      formatArg = "csv";
      continue;
    }
    if (a === "--out" || a === "-o") {
      outPath = (argv[++i] ?? "").trim();
      continue;
    }
    if (a.startsWith("--out=")) {
      outPath = a.slice("--out=".length).trim();
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
    if (a === "--cheerio") {
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
    if (a.startsWith("--cheerio=")) {
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

  const rawConc =
    (Number.isFinite(concurrency) && concurrency > 0 ? concurrency : null) ??
    Number.parseInt(process.env.SCRAPE_CONCURRENCY ?? "", 10);
  const detailConcurrency = Math.min(
    8,
    Math.max(1, Number.isFinite(rawConc) && rawConc > 0 ? rawConc : 4),
  );

  const envFmt = (process.env.SCRAPE_FORMAT ?? "").trim().toLowerCase();
  const rawFmt = (formatArg || envFmt || "json").trim().toLowerCase();
  const outputFormat = rawFmt === "csv" ? "csv" : "json";

  const useCheerio = parseCheerio(argv);

  return {
    maxProducts,
    categoryUrl,
    showDetail,
    detailConcurrency,
    outputFormat,
    outPath: outPath || null,
    useCheerio,
  };
}

const {
  maxProducts: MAX_PRODUCTS,
  categoryUrl,
  showDetail: SHOW_DETAIL,
  detailConcurrency: DETAIL_CONCURRENCY,
  outputFormat: OUTPUT_FORMAT,
  outPath: OUTPUT_PATH,
  useCheerio: USE_CHEERIO,
} = parseCli();

const SCRAPE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PDP_DEBUG_ASSETS_DIR = path.join(SCRAPE_DIR, "..", "assets");

function pdpDebugSinglePath(engine) {
  const name =
    engine === "cheerio"
      ? "pdp-debug-cheerio.html"
      : "pdp-debug-puppeteer.html";
  return path.join(PDP_DEBUG_ASSETS_DIR, name);
}

/** One file per URL so parallel workers do not clobber each other. */
function pdpDebugMissingPath(engine, productUrl) {
  const h = crypto.createHash("sha256").update(productUrl).digest("hex").slice(0, 16);
  const stem =
    engine === "cheerio"
      ? "pdp-debug-cheerio-missing"
      : "pdp-debug-puppeteer-missing";
  return path.join(PDP_DEBUG_ASSETS_DIR, `${stem}-${h}.html`);
}

function detailMissingRatingOrShop(detail) {
  const noRating =
    detail.rating == null || String(detail.rating).trim() === "";
  const noShop =
    detail.merchantName == null ||
    String(detail.merchantName).trim() === "";
  return noRating || noShop;
}

function writePdpDebugFile(outFile, html, logLabel) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, { encoding: "utf8" });
  console.error(`Wrote PDP debug HTML (${logLabel}): ${outFile}`);
}

function maybeWritePdpDebugSingle(engine, html) {
  if (MAX_PRODUCTS !== 1) return;
  writePdpDebugFile(pdpDebugSinglePath(engine), html, `${engine} -n1`);
}

function maybeWritePdpDebugMissing(engine, productUrl, html, detail) {
  if (!detailMissingRatingOrShop(detail)) return;
  writePdpDebugFile(
    pdpDebugMissingPath(engine, productUrl),
    html,
    `${engine} missing rating/shop`,
  );
}

/** stderr progress when scraping multiple PDPs (`-n` > 1). */
function logPdpProgress(ordinal, total, url, engine) {
  if (total <= 1) return;
  const label = engine === "cheerio" ? "cheerio" : "puppeteer";
  console.error(`[PDP ${ordinal}/${total}] (${label})`);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvLines(rows) {
  return rows.map((cells) => cells.map(csvCell).join(",")).join("\r\n");
}

function writeOutput(text) {
  if (OUTPUT_PATH) {
    fs.writeFileSync(OUTPUT_PATH, text, { encoding: "utf8" });
    console.error(`Wrote ${OUTPUT_PATH}`);
    return;
  }
  process.stdout.write(text);
}

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
  await new Promise((r) => setTimeout(r, 650));
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
  await new Promise((r) => setTimeout(r, 350));
}

const BLOCK_URL_PARTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "facebook.net",
  "hotjar.com",
  "tiktok.com",
  "clarity.ms",
  "branch.io",
];

async function attachDetailPageOptimizations(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") {
      void req.abort();
      return;
    }
    const u = req.url();
    if (BLOCK_URL_PARTS.some((p) => u.includes(p))) {
      void req.abort();
      return;
    }
    void req.continue();
  });
}

function normDetailText(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function parsePdpStatsRatingFromHtml(html) {
  const m = html.match(
    /"countTalk":"[^"]*","rating":([0-9]+(?:\.[0-9]+)?),"__typename":"pdpStats"/,
  );
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parsePdpBasicInfoShopNameFromHtml(html) {
  let m = html.match(/"shopID":"[^"]*","shopName":"([^"]*)"/);
  if (m?.[1]?.trim()) return m[1].trim();
  m = html.match(/"shopName":"([^"]*)","minOrder":/);
  if (m?.[1]?.trim()) return m[1].trim();
  return null;
}

function parseProductDetailFromHtml(html) {
  const $ = load(html);
  const text = (sel) => normDetailText($(sel).first().text());

  const name =
    text('[data-testid="lblPDPDetailProductName"]') ||
    normDetailText($("#pdp_comp-product_content h1").first().text());

  const price = text('[data-testid="lblPDPDetailProductPrice"]');

  const ratingRaw = text('[data-testid="lblPDPDetailProductRatingNumber"]');
  let rating = null;
  if (ratingRaw) {
    const n = Number.parseFloat(ratingRaw.replace(",", "."));
    rating = Number.isFinite(n) ? n : null;
  }
  if (rating == null) {
    rating = parsePdpStatsRatingFromHtml(html);
  }

  const description =
    text('[data-testid="lblPDPDescriptionProduk"]') ||
    text('[data-testid="lblPDPDescription"]') ||
    text('[data-testid="pdpProductDescription"]') ||
    normDetailText($("#pdp_comp-product_detail_desk").first().text()) ||
    normDetailText($("#pdp_comp-ldp").first().text()) ||
    "";

  let img = $("#pdp_comp-product_main_media img").first();
  if (!img.length) img = $('[data-testid="PDPImagePrimary"] img').first();
  if (!img.length) img = $("#pdp_comp-product_content img").first();

  const imageLink =
    img.attr("src") ||
    img.attr("data-src") ||
    $('meta[property="og:image"]').attr("content") ||
    null;

  const merchantName =
    text('[data-testid="llbPDPFooterShopName"]') ||
    text('[data-testid="lblPDPShopName"]') ||
    text('a[data-testid="lnkSellerName"]') ||
    text('[data-testid="pdpShopName"]') ||
    text('[data-testid="llsPDPShopName"]') ||
    text('[data-testid="lblPDPShopMerchantName"]') ||
    parsePdpBasicInfoShopNameFromHtml(html) ||
    null;

  return finalizeProductDetail({
    name: name || null,
    description: description || null,
    imageLink: imageLink || null,
    price,
    rating,
    ratingOutOf: RATING_SCALE,
    merchantName,
  });
}

async function fetchPdpHtml(productUrl) {
  const res = await fetch(productUrl, {
    redirect: "follow",
    headers: {
      "user-agent": chromeUserAgent,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${productUrl}`);
  }
  return res.text();
}

async function scrapeOneProductDetailCheerio(productUrl) {
  try {
    const html = await fetchPdpHtml(productUrl);
    const detail = parseProductDetailFromHtml(html);
    maybeWritePdpDebugSingle("cheerio", html);
    maybeWritePdpDebugMissing("cheerio", productUrl, html, detail);
    return detail;
  } catch {
    return finalizeProductDetail({
      name: null,
      description: null,
      imageLink: null,
      price: null,
      rating: null,
      ratingOutOf: RATING_SCALE,
      merchantName: null,
    });
  }
}

async function enrichWithProductDetailsCheerio(urls, concurrency) {
  const results = new Array(urls.length);
  let cursor = 0;

  function claimIndex() {
    if (cursor >= urls.length) return -1;
    return cursor++;
  }

  async function worker() {
    for (;;) {
      const i = claimIndex();
      if (i < 0) break;
      const url = urls[i];
      logPdpProgress(i + 1, urls.length, url, "cheerio");
      const detail = await scrapeOneProductDetailCheerio(url);
      results[i] = { url, detail };
    }
  }

  const workers = Math.min(concurrency, Math.max(1, urls.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function scrapeOneProductDetail(page, productUrl) {
  await page.goto(productUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page
    .waitForSelector("#pdp_comp-product_content", { timeout: 30_000 })
    .catch(() => {});

  await nudgePdpScroll(page);
  await page
    .waitForSelector('[data-testid="lblPDPDescriptionProduk"]', {
      timeout: 6000,
    })
    .catch(() => {});

  await page
    .waitForSelector('[data-testid="lblPDPDetailProductRatingNumber"]', {
      timeout: 12_000,
    })
    .catch(() => {});

  const detail = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function querySelectorDeep(root, selector) {
      if (!root?.querySelector) return null;
      try {
        const hit = root.querySelector(selector);
        if (hit) return hit;
      } catch {
        return null;
      }
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) {
          const found = querySelectorDeep(node.shadowRoot, selector);
          if (found) return found;
        }
      }
      return null;
    }

    const text = (sel) => norm(querySelectorDeep(document, sel)?.textContent);

    const name =
      text('[data-testid="lblPDPDetailProductName"]') ||
      norm(
        querySelectorDeep(
          document,
          "#pdp_comp-product_content h1",
        )?.textContent,
      );

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
      querySelectorDeep(document, "#pdp_comp-product_main_media img") ||
      querySelectorDeep(document, '[data-testid="PDPImagePrimary"] img') ||
      querySelectorDeep(document, "#pdp_comp-product_content img");
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
      merchantName,
    };
  });

  let detailForFinalize = { ...detail };
  let htmlSnapshot = null;
  const needScriptFallback =
    detailForFinalize.rating == null ||
    !String(detailForFinalize.merchantName ?? "").trim();
  if (needScriptFallback) {
    htmlSnapshot = await page.content();
    if (detailForFinalize.rating == null) {
      const r = parsePdpStatsRatingFromHtml(htmlSnapshot);
      if (r != null) detailForFinalize.rating = r;
    }
    if (!String(detailForFinalize.merchantName ?? "").trim()) {
      const s = parsePdpBasicInfoShopNameFromHtml(htmlSnapshot);
      if (s) detailForFinalize.merchantName = s;
    }
  }

  const finalized = finalizeProductDetail({
    ...detailForFinalize,
    ratingOutOf: RATING_SCALE,
  });

  if (MAX_PRODUCTS === 1 || detailMissingRatingOrShop(finalized)) {
    const html = htmlSnapshot ?? (await page.content());
    maybeWritePdpDebugSingle("puppeteer", html);
    maybeWritePdpDebugMissing("puppeteer", productUrl, html, finalized);
  }

  return finalized;
}

async function enrichWithProductDetails(browser, urls, concurrency) {
  const results = new Array(urls.length);
  let cursor = 0;

  function claimIndex() {
    if (cursor >= urls.length) return -1;
    return cursor++;
  }

  async function worker() {
    const page = await browser.newPage();
    await page.setUserAgent(chromeUserAgent);
    await page.setViewport({ width: 1280, height: 800 });
    await attachDetailPageOptimizations(page);
    try {
      for (;;) {
        const i = claimIndex();
        if (i < 0) break;
        const url = urls[i];
        logPdpProgress(i + 1, urls.length, url, "puppeteer");
        const detail = await scrapeOneProductDetail(page, url);
        results[i] = { url, detail };
      }
    } finally {
      await page.close();
    }
  }

  const workers = Math.min(concurrency, Math.max(1, urls.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function printResult(payload) {
  if (OUTPUT_FORMAT === "csv") {
    if (payload.showDetail) {
      const header = [
        "url",
        "name",
        "description",
        "imageLink",
        "price",
        "rating",
        "merchantName",
      ];
      const rows = [header];
      for (const { url, detail } of payload.products) {
        rows.push([
          url,
          detail.name,
          detail.description,
          detail.imageLink,
          detail.price,
          detail.rating,
          detail.merchantName,
        ]);
      }
      writeOutput(`\uFEFF${toCsvLines(rows)}\n`);
    } else {
      const rows = [["url"], ...payload.productUrls.map((u) => [u])];
      writeOutput(`\uFEFF${toCsvLines(rows)}\n`);
    }
    return;
  }

  writeOutput(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  let browser = await puppeteer.launch({
    headless: true,
    args: ["--disable-http2"],
  });

  try {
    const { urls, pagesOpened } = await scrapeTopProductUrls(browser);

    if (!SHOW_DETAIL) {
      printResult({
        categoryUrl,
        maxProducts: MAX_PRODUCTS,
        count: urls.length,
        pagesOpened,
        showDetail: false,
        productUrls: urls,
      });
      return;
    }

    let products;
    let detailEngine;

    if (USE_CHEERIO) {
      await browser.close();
      browser = null;
      products = await enrichWithProductDetailsCheerio(
        urls,
        DETAIL_CONCURRENCY,
      );
      detailEngine = "cheerio";
    } else {
      products = await enrichWithProductDetails(
        browser,
        urls,
        DETAIL_CONCURRENCY,
      );
      detailEngine = "puppeteer";
    }

    printResult({
      categoryUrl,
      maxProducts: MAX_PRODUCTS,
      count: urls.length,
      pagesOpened,
      showDetail: true,
      detailConcurrency: DETAIL_CONCURRENCY,
      detailEngine,
      products,
    });
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
