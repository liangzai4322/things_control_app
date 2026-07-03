import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const SEARCH_URL = "https://scys.com/shengcai-web/client/search/contentSearch";
const DETAIL_URL_PREFIX = "https://scys.com/articleDetail/xq_topic/";
const LOCAL_STORAGE_HELPER =
  "C:\\Users\\86180\\.codex\\skills\\local-chrome-site-ops\\scripts\\invoke_site_request.ps1";

const DEFAULT_OPTIONS = {
  keyword: "工作流",
  pageScene: "good",
  pageSize: 30,
  displayMode: 2,
  orderBy: "favorite_count",
  isNeedSceneCount: false,
  isNeedBannerInfo: false,
  outputDir: "",
};

const FEISHU_HEADERS = [
  "entity_id",
  "article_title",
  "article_author",
  "publish_time",
  "scys_detail_url",
  "feishu_url",
  "feishu_type",
  "favorite_count",
  "like_count",
  "comments_count",
  "reading_count",
  "menu_tags",
  "highlight_excerpt",
  "ai_summary",
];

const ARTICLE_HEADERS = [
  "entity_id",
  "article_title",
  "article_author",
  "publish_time",
  "scys_detail_url",
  "favorite_count",
  "like_count",
  "comments_count",
  "reading_count",
  "menu_tags",
  "highlight_excerpt",
  "ai_summary",
];

function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!current.startsWith("--")) {
      continue;
    }

    switch (current) {
      case "--keyword":
        options.keyword = next;
        index += 1;
        break;
      case "--page-scene":
        options.pageScene = next;
        index += 1;
        break;
      case "--page-size":
        options.pageSize = Number(next);
        index += 1;
        break;
      case "--display-mode":
        options.displayMode = Number(next);
        index += 1;
        break;
      case "--order-by":
        options.orderBy = next;
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = next;
        index += 1;
        break;
      default:
        throw new Error(`Unsupported argument: ${current}`);
    }
  }

  return options;
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatTimestamp(seconds) {
  if (!seconds) {
    return "";
  }

  return formatDateTime(new Date(Number(seconds) * 1000));
}

function formatRunId(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function decodeHtmlEntities(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(text = "") {
  return decodeHtmlEntities(String(text))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipText(text = "", maxLength = 240) {
  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeDecodeUrlValue(value = "") {
  let decoded = decodeHtmlEntities(String(value).trim());

  for (let count = 0; count < 2; count += 1) {
    if (!decoded.includes("%")) {
      break;
    }

    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }

  return decoded;
}

function normalizeUrlCandidate(value = "") {
  const cleaned = safeDecodeUrlValue(value)
    .replace(/\\/g, "")
    .replace(/^[("'`<\s]+/, "")
    .replace(/[>"'`)\],\s]+$/, "");

  if (cleaned.includes("...") || cleaned.includes("…")) {
    return null;
  }

  try {
    const parsed = new URL(cleaned);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractFeishuLinks(articleContent = "") {
  const candidates = new Set();
  const rawText = String(articleContent);

  const hrefRegex = /href=(?:"([^"]+)"|'([^']+)')/gi;
  let hrefMatch = hrefRegex.exec(rawText);
  while (hrefMatch) {
    candidates.add(hrefMatch[1] || hrefMatch[2] || "");
    hrefMatch = hrefRegex.exec(rawText);
  }

  const directUrlRegex = /(https?:\/\/[^\s"'<>]+)/gi;
  let directUrlMatch = directUrlRegex.exec(rawText);
  while (directUrlMatch) {
    candidates.add(directUrlMatch[1]);
    directUrlMatch = directUrlRegex.exec(rawText);
  }

  return [...candidates]
    .map((candidate) => normalizeUrlCandidate(candidate))
    .filter((candidate) => candidate && candidate.includes("feishu.cn"))
    .filter((candidate) => {
      const pathname = new URL(candidate).pathname.toLowerCase();
      return pathname.includes("/docx/") || pathname.includes("/wiki/");
    })
    .filter((candidate, index, list) => list.indexOf(candidate) === index);
}

function getFeishuType(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.includes("/docx/")) {
    return "docx";
  }
  if (pathname.includes("/wiki/")) {
    return "wiki";
  }
  return "";
}

function toMenuTags(menuList) {
  return Array.isArray(menuList) ? menuList.map((item) => item?.value).filter(Boolean).join(" | ") : "";
}

function buildBaseRow(item) {
  const topic = item?.topicDTO ?? {};
  const user = item?.topicUserDTO ?? {};
  const entityId = String(topic.entityId ?? topic.topicId ?? "");

  return {
    entity_id: entityId,
    article_title: topic.showTitle ?? "",
    article_author: user.name ?? "",
    publish_time: formatTimestamp(topic.gmtCreate),
    scys_detail_url: entityId ? `${DETAIL_URL_PREFIX}${entityId}` : "",
    favorite_count: topic.favoriteCount ?? 0,
    like_count: topic.likeCount ?? 0,
    comments_count: topic.commentsCount ?? 0,
    reading_count: topic.readingCount ?? 0,
    menu_tags: toMenuTags(topic.menuList),
    highlight_excerpt: clipText(stripTags(topic.highlightArticleContent ?? ""), 320),
    ai_summary: clipText(stripTags(topic.aiSummaryContent ?? ""), 500),
    article_content: topic.articleContent ?? "",
    question_content: topic.questionContent ?? "",
  };
}

function invokeScysSearch(payload, keyword) {
  const referer = `https://scys.com/search?keyword=${encodeURIComponent(keyword)}`;
  const bodyFile = path.join(os.tmpdir(), `scys-content-search-${process.pid}-${Date.now()}-${payload.pageIndex}.json`);

  return fs
    .writeFile(bodyFile, JSON.stringify(payload), "utf8")
    .then(() => {
      const stdout = execFileSync(
        "powershell.exe",
        [
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          LOCAL_STORAGE_HELPER,
          "-StorageOrigin",
          "https://scys.com",
          "-StorageKey",
          "__user_token.v3",
          "-Url",
          SEARCH_URL,
          "-Method",
          "POST",
          "-AuthHeader",
          "X-TOKEN",
          "-DeviceType",
          "pc",
          "-Referer",
          referer,
          "-BodyFile",
          bodyFile,
        ],
        {
          encoding: "utf8",
          maxBuffer: 128 * 1024 * 1024,
        }
      );

      return JSON.parse(stdout);
    })
    .finally(() => fs.unlink(bodyFile).catch(() => {}));
}

async function fetchAllItems(options) {
  const firstPayload = {
    keyword: options.keyword,
    isNeedSceneCount: options.isNeedSceneCount,
    pageScene: options.pageScene,
    pageIndex: 1,
    pageSize: options.pageSize,
    displayMode: options.displayMode,
    orderBy: options.orderBy,
    isNeedBannerInfo: options.isNeedBannerInfo,
  };

  const firstResponse = await invokeScysSearch(firstPayload, options.keyword);
  const firstResult = firstResponse?.data?.topicDetailDTO;
  const total = Number(firstResult?.total ?? 0);
  const items = [...(firstResult?.items ?? [])];

  if (!total) {
    throw new Error("接口返回 total=0，请先确认当前 Chrome 登录态里能正常搜到“工作流”结果。");
  }

  const totalPages = Math.ceil(total / options.pageSize);
  console.log(`第一页完成：${items.length} 条，总计 ${total} 条，共 ${totalPages} 页。`);

  for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
    const payload = {
      ...firstPayload,
      pageIndex,
    };
    const pageResponse = await invokeScysSearch(payload, options.keyword);
    const pageItems = pageResponse?.data?.topicDetailDTO?.items ?? [];
    items.push(...pageItems);
    console.log(`第 ${pageIndex}/${totalPages} 页完成，累计 ${items.length} 条。`);
  }

  return { total, items };
}

function splitRows(items) {
  const feishuRows = [];
  const articleRows = [];

  for (const item of items) {
    const baseRow = buildBaseRow(item);
    const combinedContent = `${baseRow.article_content}\n${baseRow.question_content}`;
    const feishuLinks = extractFeishuLinks(combinedContent);

    if (feishuLinks.length > 0) {
      for (const feishuUrl of feishuLinks) {
        feishuRows.push({
          ...baseRow,
          feishu_url: feishuUrl,
          feishu_type: getFeishuType(feishuUrl),
        });
      }
      continue;
    }

    articleRows.push(baseRow);
  }

  return { feishuRows, articleRows };
}

function columnLetter(index) {
  let current = index + 1;
  let output = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    current = Math.floor((current - 1) / 26);
  }

  return output;
}

function rowsToMatrix(rows, headers) {
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))];
}

function applyColumnWidths(sheet, rowCount, widths) {
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, rowCount, 1).format.columnWidthPx = width;
  });
}

async function buildWorkbook({
  workbookTitle,
  sheetName,
  summaryPairs,
  headers,
  rows,
  outputFile,
  tableName,
  previewFile,
}) {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add(sheetName);
  const lastColumn = columnLetter(headers.length - 1);
  const dataMatrix = rowsToMatrix(rows, headers);
  const totalRowCount = dataMatrix.length + 3;

  sheet.showGridLines = false;
  sheet.getRange(`A1:${lastColumn}1`).merge();
  sheet.getRange("A1").values = [[workbookTitle]];
  sheet.getRange(`A1:${lastColumn}1`).format = {
    fill: "#0F766E",
    font: { bold: true, color: "#FFFFFF", size: 16 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  sheet.getRange(`A1:${lastColumn}1`).format.rowHeightPx = 30;

  const summaryCells = [];
  for (const [label, value] of summaryPairs) {
    summaryCells.push(label, value);
  }
  sheet.getRangeByIndexes(1, 0, 1, summaryCells.length).values = [summaryCells];
  for (let index = 0; index < summaryCells.length; index += 2) {
    sheet.getRangeByIndexes(1, index, 1, 1).format = {
      fill: "#E5E7EB",
      font: { bold: true, color: "#111827" },
    };
  }

  sheet.getRangeByIndexes(3, 0, dataMatrix.length, headers.length).values = dataMatrix;
  sheet.getRangeByIndexes(3, 0, 1, headers.length).format = {
    fill: "#115E59",
    font: { bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };

  if (rows.length > 0) {
    const tableRange = `A4:${lastColumn}${rows.length + 4}`;
    sheet.tables.add(tableRange, true, tableName);
  }

  applyColumnWidths(sheet, totalRowCount + 2, headers.map((header) => {
    switch (header) {
      case "article_title":
        return 280;
      case "article_author":
        return 120;
      case "publish_time":
        return 150;
      case "scys_detail_url":
      case "feishu_url":
        return 280;
      case "feishu_type":
        return 90;
      case "menu_tags":
        return 220;
      case "highlight_excerpt":
        return 320;
      case "ai_summary":
        return 380;
      default:
        return 110;
    }
  }));

  const wrapHeaders = new Set([
    "article_title",
    "scys_detail_url",
    "feishu_url",
    "menu_tags",
    "highlight_excerpt",
    "ai_summary",
  ]);

  headers.forEach((header, index) => {
    if (!wrapHeaders.has(header)) {
      return;
    }

    sheet.getRangeByIndexes(3, index, rows.length + 1, 1).format.wrapText = true;
    sheet.getRangeByIndexes(3, index, rows.length + 1, 1).format.verticalAlignment = "top";
  });

  sheet.freezePanes.freezeRows(4);

  const inspectRange = `A1:${lastColumn}${Math.min(rows.length + 4, 20)}`;
  const inspection = await workbook.inspect({
    kind: "table",
    range: `${sheetName}!${inspectRange}`,
    include: "values",
    tableMaxRows: 20,
    tableMaxCols: headers.length,
  });
  await fs.writeFile(`${outputFile}.inspect.ndjson`, inspection.ndjson, "utf8");

  const preview = await workbook.render({
    sheetName,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  const previewBytes = new Uint8Array(await preview.arrayBuffer());
  await fs.writeFile(previewFile, previewBytes);

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(outputFile);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const runId = formatRunId(now);
  const outputDir =
    options.outputDir || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "outputs", runId);
  const resolvedOutputDir = path.resolve(outputDir);

  await fs.mkdir(resolvedOutputDir, { recursive: true });

  console.log(`输出目录：${resolvedOutputDir}`);
  const { total, items } = await fetchAllItems(options);
  const { feishuRows, articleRows } = splitRows(items);

  console.log(`飞书文档记录：${feishuRows.length} 条；无飞书文档记录：${articleRows.length} 条。`);

  const rawItemsPath = path.join(resolvedOutputDir, "scys-search-raw-items.json");
  await fs.writeFile(rawItemsPath, JSON.stringify(items, null, 2), "utf8");

  const normalizedPath = path.join(resolvedOutputDir, "scys-search-normalized.json");
  await fs.writeFile(
    normalizedPath,
    JSON.stringify(
      {
        keyword: options.keyword,
        total,
        feishuRows,
        articleRows,
      },
      null,
      2
    ),
    "utf8"
  );

  const exportTime = formatDateTime(now);
  const feishuWorkbookPath = path.join(resolvedOutputDir, "scys_feishu_links.xlsx");
  const articleWorkbookPath = path.join(resolvedOutputDir, "scys_without_feishu_links.xlsx");

  await buildWorkbook({
    workbookTitle: `SCYS 搜索结果：${options.keyword}（含飞书文档链接）`,
    sheetName: "飞书文档",
    summaryPairs: [
      ["关键词", options.keyword],
      ["原始总数", total],
      ["导出记录数", feishuRows.length],
      ["导出时间", exportTime],
    ],
    headers: FEISHU_HEADERS,
    rows: feishuRows,
    outputFile: feishuWorkbookPath,
    tableName: "FeishuDocsTable",
    previewFile: path.join(resolvedOutputDir, "scys_feishu_links.preview.png"),
  });

  await buildWorkbook({
    workbookTitle: `SCYS 搜索结果：${options.keyword}（无飞书文档链接）`,
    sheetName: "文章详情",
    summaryPairs: [
      ["关键词", options.keyword],
      ["原始总数", total],
      ["导出记录数", articleRows.length],
      ["导出时间", exportTime],
    ],
    headers: ARTICLE_HEADERS,
    rows: articleRows,
    outputFile: articleWorkbookPath,
    tableName: "ScysArticlesTable",
    previewFile: path.join(resolvedOutputDir, "scys_without_feishu_links.preview.png"),
  });

  const summaryPath = path.join(resolvedOutputDir, "export-summary.json");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        keyword: options.keyword,
        total,
        feishuCount: feishuRows.length,
        nonFeishuCount: articleRows.length,
        outputDir: resolvedOutputDir,
        files: {
          feishuWorkbookPath,
          articleWorkbookPath,
          rawItemsPath,
          normalizedPath,
        },
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("导出完成：");
  console.log(feishuWorkbookPath);
  console.log(articleWorkbookPath);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
