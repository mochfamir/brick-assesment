# brick-assesment

Scrape Tokopedia category listings and optionally product detail pages (name, description, image, price, rating, merchant).

## Requirements

- Node.js 18+ (recommended)

## Setup

```bash
npm install
```

## Usage

```bash
npm run scrape -- [options]
```

Or run the script directly:

```bash
node src/scrape.js [options]
```

### Example

```bash
npm run scrape:handphone
```

This collects up to 100 handphone listing URLs, opens PDPs with concurrency 8, writes JSON to `output.json`.

### Common options

| Option | Description |
|--------|-------------|
| `-n`, `--num` | Max product URLs from the listing (default: 100) |
| `-c`, `--category` | Category path (e.g. `handphone-tablet/handphone`) or full listing URL |
| `--show-detail` | Scrape each product page for full fields |
| `-j`, `--concurrency` | Parallel PDP tabs when `--show-detail` (default: 4, max: 8) |
| `--cheerio` | Parse PDP HTML with Cheerio (faster; may miss fields if markup is client-only) |
| `--format` | `json` or `csv` (default: json); `--csv` shorthand |
| `-o`, `--out` | Write UTF-8 output to a file (handy on Windows vs shell redirect) |

Full CLI help:

```bash
node src/scrape.js --help
```

### Environment (optional)

- `SCRAPE_MAX_PRODUCTS` — same as `--num`
- `SCRAPE_URL` — full category URL when `--category` is omitted
- `SCRAPE_CONCURRENCY` — same as `--concurrency`
- `SCRAPE_FORMAT` — `json` or `csv`

## Stack

- [Cheerio](https://cheerio.js.org/) — HTML parsing
- [Puppeteer](https://pptr.dev/) — browser automation for listings and PDPs
