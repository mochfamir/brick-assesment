import puppeteer from "puppeteer";

const url =
  process.argv[2] ||
  process.env.SCRAPE_URL ||
  "https://www.tokopedia.com/";

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function openTargetPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(chromeUserAgent);
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--disable-http2",
    ],
  });

  try {
    const page = await openTargetPage(browser);

    const title = await page.title();
    const html = await page.content();

    console.log(JSON.stringify({ url, title, htmlLength: html.length }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
