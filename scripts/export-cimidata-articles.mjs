import fs from "node:fs/promises";
import path from "node:path";

const API_URL = "https://cimidata.coze.site/api/articles";
const TABLE = process.env.CIMIDATA_TABLE || "wechat_articles01";
const COOKIE = process.env.CIMIDATA_COOKIE;
const PAGE_SIZE = Number(process.env.CIMIDATA_PAGE_SIZE || 100);
const OUT_DIR = path.resolve(process.env.CIMIDATA_OUT_DIR || "outputs/cimidata");
const SORT_FIELD = process.env.CIMIDATA_SORT_FIELD || "publish_date";
const SORT_ORDER = process.env.CIMIDATA_SORT_ORDER || "desc";

if (!COOKIE) {
  console.error("Missing CIMIDATA_COOKIE. Set it to the browser cookie string before running.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(page) {
  const url = new URL(API_URL);
  url.searchParams.set("table", TABLE);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("sortField", SORT_FIELD);
  url.searchParams.set("sortOrder", SORT_ORDER);
  return url;
}

async function fetchPage(page, attempt = 1) {
  const response = await fetch(buildUrl(page), {
    headers: {
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Cookie: COOKIE,
      Referer: "https://cimidata.coze.site/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    if (attempt < 4 && [429, 500, 502, 503, 504].includes(response.status)) {
      await sleep(750 * attempt);
      return fetchPage(page, attempt + 1);
    }
    throw new Error(`Page ${page} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text);
  if (!json.success || !json.data || !Array.isArray(json.data.articles)) {
    throw new Error(`Page ${page} returned an unexpected payload: ${text.slice(0, 300)}`);
  }
  return json.data;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const columns = [
    "id",
    "publish_date",
    "account_name",
    "title",
    "url",
    "read_count",
    "like_count",
    "share_count",
    "has_anomaly",
    "heat_score",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const firstPage = await fetchPage(1);
  const total = firstPage.total;
  const serverPageSize = firstPage.pageSize;
  const totalPages = firstPage.totalPages;
  const articles = [...firstPage.articles];

  console.log(
    `Detected total=${total}, pageSize=${serverPageSize}, totalPages=${totalPages}. Exporting...`,
  );

  for (let page = 2; page <= totalPages; page += 1) {
    const data = await fetchPage(page);
    articles.push(...data.articles);
    if (page % 10 === 0 || page === totalPages) {
      console.log(`Fetched page ${page}/${totalPages}; rows=${articles.length}`);
    }
  }

  const byId = new Map(articles.map((article) => [article.id, article]));
  const deduped = [...byId.values()];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  const jsonPath = path.join(OUT_DIR, `wechat_articles01_${timestamp}.json`);
  const csvPath = path.join(OUT_DIR, `wechat_articles01_${timestamp}.csv`);
  const latestJsonPath = path.join(OUT_DIR, "wechat_articles01_latest.json");
  const latestCsvPath = path.join(OUT_DIR, "wechat_articles01_latest.csv");

  const payload = {
    exportedAt: new Date().toISOString(),
    table: TABLE,
    sortField: SORT_FIELD,
    sortOrder: SORT_ORDER,
    totalFromApi: total,
    requestedPageSize: PAGE_SIZE,
    serverPageSize,
    totalPages,
    rowCount: articles.length,
    uniqueRowCount: deduped.length,
    articles: deduped,
  };

  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  const csvText = `${toCsv(deduped)}\n`;
  await fs.writeFile(jsonPath, jsonText, "utf8");
  await fs.writeFile(csvPath, csvText, "utf8");
  await fs.writeFile(latestJsonPath, jsonText, "utf8");
  await fs.writeFile(latestCsvPath, csvText, "utf8");

  console.log(`Saved JSON: ${jsonPath}`);
  console.log(`Saved CSV:  ${csvPath}`);
  console.log(`Unique rows: ${deduped.length}/${total}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
