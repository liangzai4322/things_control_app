import fs from "node:fs/promises";
import path from "node:path";

const API_URL = "https://cimidata.coze.site/api/articles";
const COOKIE = process.env.CIMIDATA_COOKIE;
const PAGE_SIZE = Number(process.env.CIMIDATA_PAGE_SIZE || 100);
const OUT_DIR = path.resolve(process.env.CIMIDATA_OUT_DIR || "outputs/cimidata/categories");
const SORT_FIELD = process.env.CIMIDATA_SORT_FIELD || "publish_date";
const SORT_ORDER = process.env.CIMIDATA_SORT_ORDER || "desc";

const categories = [
  ["小绿书", "wechat_articles02"],
  ["科技", "wechat_articles03"],
  ["职场", "wechat_articles04"],
  ["情感", "wechat_articles05"],
  ["影视", "wechat_articles06"],
  ["AI", "wechat_articles07"],
  ["星座命理", "wechat_articles08"],
  ["军事国际", "wechat_articles09"],
  ["财经", "wechat_articles10"],
  ["娱乐", "wechat_articles11"],
  ["资讯热点", "wechat_articles12"],
  ["文化", "wechat_articles13"],
  ["美食", "wechat_articles14"],
  ["汽车", "wechat_articles15"],
  ["文案", "wechat_articles16"],
  ["民生", "wechat_articles17"],
  ["教育", "wechat_articles18"],
  ["体育健身", "wechat_articles19"],
  ["游戏", "wechat_articles20"],
  ["科学", "wechat_articles21"],
  ["房产", "wechat_articles22"],
  ["育儿", "wechat_articles23"],
  ["文摘", "wechat_articles24"],
  ["动漫", "wechat_articles25"],
  ["体制", "wechat_articles26"],
  ["健康养生", "wechat_articles27"],
  ["法律", "wechat_articles28"],
  ["壁纸头像", "wechat_articles29"],
  ["个人成长", "wechat_articles30"],
  ["商业营销", "wechat_articles31"],
  ["美妆时尚", "wechat_articles32"],
  ["搞笑", "wechat_articles33"],
  ["历史", "wechat_articles34"],
  ["三农", "wechat_articles35"],
  ["宠物", "wechat_articles36"],
  ["数码", "wechat_articles37"],
  ["生活", "wechat_articles38"],
  ["旅游", "wechat_articles39"],
  ["开发者", "wechat_articles40"],
  ["摄影", "wechat_articles41"],
  ["家居", "wechat_articles42"],
  ["其它", "wechat_articles43"],
];

if (!COOKIE) {
  console.error("Missing CIMIDATA_COOKIE. Set it to the browser cookie string before running.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(table, page) {
  const url = new URL(API_URL);
  url.searchParams.set("table", table);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("sortField", SORT_FIELD);
  url.searchParams.set("sortOrder", SORT_ORDER);
  return url;
}

function fileSafeName(text) {
  return text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_");
}

async function fetchPage(table, page, attempt = 1) {
  const response = await fetch(buildUrl(table, page), {
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
      return fetchPage(table, page, attempt + 1);
    }
    throw new Error(`${table} page ${page} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text);
  if (!json.success || !json.data || !Array.isArray(json.data.articles)) {
    throw new Error(`${table} page ${page} returned an unexpected payload: ${text.slice(0, 300)}`);
  }
  return json.data;
}

async function exportCategory(category, table) {
  const firstPage = await fetchPage(table, 1);
  const articles = [...firstPage.articles];
  const totalPages = firstPage.totalPages || 1;

  for (let page = 2; page <= totalPages; page += 1) {
    const data = await fetchPage(table, page);
    articles.push(...data.articles);
  }

  const byId = new Map(articles.map((article) => [article.id, article]));
  const titles = [...byId.values()].map((article) => article.title ?? "");
  const outputPath = path.join(OUT_DIR, `${table}_${fileSafeName(category)}_titles.txt`);
  await fs.writeFile(outputPath, `${titles.join("\n")}\n`, "utf8");

  return {
    category,
    table,
    totalFromApi: firstPage.total,
    serverPageSize: firstPage.pageSize,
    totalPages,
    rowCount: articles.length,
    uniqueRowCount: titles.length,
    titleFile: outputPath,
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const manifest = [];
  for (const [category, table] of categories) {
    const result = await exportCategory(category, table);
    manifest.push(result);
    console.log(`${category} ${table}: ${result.uniqueRowCount}/${result.totalFromApi}`);
  }

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ exportedAt: new Date().toISOString(), categories: manifest }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Saved manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
