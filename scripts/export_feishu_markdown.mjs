#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_WAIT_MS = [6000, 12000, 20000];
const DEFAULT_CONCURRENCY = 4;
const EXTENSION_ID = "ehkomhhcinhikfddnmklbloahaakploh";

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    concurrency: DEFAULT_CONCURRENCY,
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--input") {
      options.input = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--output") {
      options.output = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      options.concurrency = Number(argv[index + 1] ?? DEFAULT_CONCURRENCY);
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      options.limit = Number(argv[index + 1] ?? 0);
      index += 1;
      continue;
    }
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error("`--concurrency` must be a positive integer.");
  }

  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit < 1)) {
    throw new Error("`--limit` must be a positive integer.");
  }

  options.concurrency = Math.floor(options.concurrency);
  options.limit = options.limit === null ? null : Math.floor(options.limit);

  return options;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveInputPath(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const outputsDir = path.resolve("outputs");
  const entries = await fs.readdir(outputsDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidate = path.join(outputsDir, entry.name, "scys-search-normalized.json");
    if (await fileExists(candidate)) {
      candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => right.localeCompare(left));

  if (candidates.length === 0) {
    throw new Error("Could not find `scys-search-normalized.json` under the `outputs` directory.");
  }

  return candidates[0];
}

async function resolveViewScriptPath() {
  const baseDir = path.join(
    process.env.LOCALAPPDATA ?? "",
    "Google",
    "Chrome",
    "User Data",
    "Default",
    "Extensions",
    EXTENSION_ID,
  );

  const versionEntries = await fs.readdir(baseDir, { withFileTypes: true });
  const versions = versionEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const version of versions) {
    const scriptPath = path.join(baseDir, version, "bundles", "scripts", "view-lark-docx-as-markdown.js");
    if (await fileExists(scriptPath)) {
      return scriptPath;
    }
  }

  throw new Error("Could not find `view-lark-docx-as-markdown.js` in the installed Cloud Document Converter extension.");
}

function decodeHtmlEntities(text) {
  const namedMap = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", "\""],
    ["apos", "'"],
    ["nbsp", " "],
  ]);

  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-zA-Z]+);/g, (fullMatch, name) => namedMap.get(name) ?? fullMatch);
}

function escapeYamlString(value) {
  return JSON.stringify(String(value ?? "").replace(/\r\n?/g, "\n"));
}

function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s*-\s*飞书云文档\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFileName(name) {
  const normalized = String(name ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();

  return normalized.slice(0, 120) || "untitled";
}

function getFeishuToken(url) {
  const parsedUrl = new URL(url);
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? "unknown";
}

function getFeishuKind(url) {
  if (url.includes("/docx/")) {
    return "docx";
  }

  if (url.includes("/wiki/")) {
    return "wiki";
  }

  return "unknown";
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/["\r\n,]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function createCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return lines.join("\n");
}

async function getExistingExports(docsDir) {
  const existing = new Map();

  if (!(await fileExists(docsDir))) {
    return existing;
  }

  const entries = await fs.readdir(docsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const match = entry.name.match(/__(.+)\.md$/u);
    if (!match) {
      continue;
    }

    existing.set(match[1], path.join(docsDir, entry.name));
  }

  return existing;
}

function buildItemIndex(feishuRows) {
  const byUrl = new Map();

  for (const row of feishuRows) {
    const current = byUrl.get(row.feishu_url);
    if (current) {
      current.source_rows.push(row);
      continue;
    }

    byUrl.set(row.feishu_url, {
      feishu_url: row.feishu_url,
      feishu_type: row.feishu_type || getFeishuKind(row.feishu_url),
      token: getFeishuToken(row.feishu_url),
      source_rows: [row],
    });
  }

  return [...byUrl.values()].sort((left, right) => {
    const leftFav = Number(left.source_rows[0]?.favorite_count ?? 0);
    const rightFav = Number(right.source_rows[0]?.favorite_count ?? 0);
    return rightFav - leftFav;
  });
}

function buildFrontmatter(item, pageTitle, exportedAt) {
  const primaryRow = item.source_rows[0] ?? {};
  const lines = [
    "---",
    `title: ${escapeYamlString(pageTitle)}`,
    `feishu_url: ${escapeYamlString(item.feishu_url)}`,
    `feishu_type: ${escapeYamlString(item.feishu_type)}`,
    `feishu_token: ${escapeYamlString(item.token)}`,
    `source_article_title: ${escapeYamlString(primaryRow.article_title ?? "")}`,
    `source_article_author: ${escapeYamlString(primaryRow.article_author ?? "")}`,
    `source_article_url: ${escapeYamlString(primaryRow.scys_detail_url ?? "")}`,
    `source_entity_id: ${escapeYamlString(primaryRow.entity_id ?? "")}`,
    `source_publish_time: ${escapeYamlString(primaryRow.publish_time ?? "")}`,
    `duplicate_source_count: ${item.source_rows.length}`,
    `exported_at: ${escapeYamlString(exportedAt)}`,
    "---",
    "",
  ];

  return lines.join("\n");
}

async function exportMarkdownFromUrl(context, scriptPath, url, waitMs) {
  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(waitMs);

    const popupPromise = page.waitForEvent("popup", { timeout: 120000 });
    await page.addScriptTag({ path: scriptPath });
    const popup = await popupPromise;

    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
      await popup.locator("pre").waitFor({ timeout: 120000 });
      const markdown = await popup.locator("pre").innerText();
      const title = cleanTitle(await page.title());
      return { markdown, title };
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function processItem(item, context, scriptPath, docsDir, exportedAt) {
  const primaryRow = item.source_rows[0] ?? {};
  let lastError = null;

  for (const waitMs of DEFAULT_WAIT_MS) {
    try {
      const { markdown, title } = await exportMarkdownFromUrl(context, scriptPath, item.feishu_url, waitMs);
      const normalizedTitle = title || primaryRow.article_title || item.token;
      const fileBase = `${sanitizeFileName(normalizedTitle)}__${item.token}.md`;
      const outputPath = path.join(docsDir, fileBase);
      const content = decodeHtmlEntities(markdown).replace(/\r\n?/g, "\n").trim();
      const finalText = `${buildFrontmatter(item, normalizedTitle, exportedAt)}${content}\n`;

      await fs.writeFile(outputPath, finalText, "utf8");

      return {
        status: "success",
        feishu_url: item.feishu_url,
        feishu_type: item.feishu_type,
        token: item.token,
        page_title: normalizedTitle,
        source_article_title: primaryRow.article_title ?? "",
        source_article_author: primaryRow.article_author ?? "",
        source_article_url: primaryRow.scys_detail_url ?? "",
        source_entity_id: primaryRow.entity_id ?? "",
        duplicate_source_count: item.source_rows.length,
        markdown_path: outputPath,
        markdown_char_count: content.length,
        wait_ms: waitMs,
        attempts: DEFAULT_WAIT_MS.indexOf(waitMs) + 1,
        error: "",
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    status: "failed",
    feishu_url: item.feishu_url,
    feishu_type: item.feishu_type,
    token: item.token,
    page_title: "",
    source_article_title: primaryRow.article_title ?? "",
    source_article_author: primaryRow.article_author ?? "",
    source_article_url: primaryRow.scys_detail_url ?? "",
    source_entity_id: primaryRow.entity_id ?? "",
    duplicate_source_count: item.source_rows.length,
    markdown_path: "",
    markdown_char_count: 0,
    wait_ms: DEFAULT_WAIT_MS.at(-1),
    attempts: DEFAULT_WAIT_MS.length,
    error: String(lastError ?? "Unknown error"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = await resolveInputPath(args.input);
  const scriptPath = await resolveViewScriptPath();
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const items = buildItemIndex(input.feishuRows);
  const limitedItems = args.limit === null ? items : items.slice(0, args.limit);

  const exportRoot = args.output
    ? path.resolve(args.output)
    : path.resolve("outputs", timestamp());

  const docsDir = path.join(exportRoot, "feishu_markdown");
  const exportedAt = new Date().toISOString();

  await fs.mkdir(docsDir, { recursive: true });

  const existingExports = await getExistingExports(docsDir);
  const results = limitedItems.map((item) => {
    const existingPath = existingExports.get(item.token);
    if (!existingPath) {
      return null;
    }

    const primaryRow = item.source_rows[0] ?? {};
    const existingName = path.basename(existingPath, ".md").replace(new RegExp(`__${item.token}$`, "u"), "");

    return {
      status: "existing",
      feishu_url: item.feishu_url,
      feishu_type: item.feishu_type,
      token: item.token,
      page_title: existingName,
      source_article_title: primaryRow.article_title ?? "",
      source_article_author: primaryRow.article_author ?? "",
      source_article_url: primaryRow.scys_detail_url ?? "",
      source_entity_id: primaryRow.entity_id ?? "",
      duplicate_source_count: item.source_rows.length,
      markdown_path: existingPath,
      markdown_char_count: 0,
      wait_ms: 0,
      attempts: 0,
      error: "",
    };
  });

  const pendingIndexes = results
    .map((result, index) => (result === null ? index : -1))
    .filter((index) => index >= 0);

  console.log(`Input: ${inputPath}`);
  console.log(`View script: ${scriptPath}`);
  console.log(`Output: ${exportRoot}`);
  console.log(`Unique Feishu URLs: ${limitedItems.length}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`Already exported: ${limitedItems.length - pendingIndexes.length}`);
  console.log(`Pending export: ${pendingIndexes.length}`);

  let nextIndex = 0;
  let completed = 0;
  let browser = null;

  if (pendingIndexes.length > 0) {
    browser = await chromium.launch({ channel: "chrome", headless: true });

    try {
      await Promise.all(
        Array.from({ length: Math.min(args.concurrency, pendingIndexes.length) }, async (_, workerIndex) => {
          const context = await browser.newContext();
          try {
            while (true) {
              const queueIndex = nextIndex;
              nextIndex += 1;

              if (queueIndex >= pendingIndexes.length) {
                break;
              }

              const currentIndex = pendingIndexes[queueIndex];
              const item = limitedItems[currentIndex];
              const result = await processItem(item, context, scriptPath, docsDir, exportedAt);
              results[currentIndex] = result;
              completed += 1;

              const prefix = `[${completed}/${pendingIndexes.length}] [worker ${workerIndex + 1}]`;
              if (result.status === "success") {
                console.log(`${prefix} OK ${result.page_title}`);
              } else {
                console.log(`${prefix} FAIL ${result.feishu_url} :: ${result.error}`);
              }
            }
          } finally {
            await context.close().catch(() => {});
          }
        }),
      );
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const manifestHeaders = [
    "status",
    "feishu_url",
    "feishu_type",
    "token",
    "page_title",
    "source_article_title",
    "source_article_author",
    "source_article_url",
    "source_entity_id",
    "duplicate_source_count",
    "markdown_path",
    "markdown_char_count",
    "wait_ms",
    "attempts",
    "error",
  ];

  const manifestPath = path.join(exportRoot, "feishu_markdown_manifest.csv");
  const manifestJsonPath = path.join(exportRoot, "feishu_markdown_manifest.json");
  const summaryPath = path.join(exportRoot, "feishu_markdown_summary.json");

  await fs.writeFile(manifestPath, `\uFEFF${createCsv(results, manifestHeaders)}`, "utf8");
  await fs.writeFile(manifestJsonPath, JSON.stringify(results, null, 2), "utf8");

  const summary = {
    input_path: inputPath,
    output_path: exportRoot,
    docs_dir: docsDir,
    total_unique_urls: limitedItems.length,
    success_count: results.filter((result) => result.status === "success").length,
    existing_count: results.filter((result) => result.status === "existing").length,
    failed_count: results.filter((result) => result.status === "failed").length,
    concurrency: args.concurrency,
    exported_at: exportedAt,
    hostname: os.hostname(),
  };

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("\nSummary");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
