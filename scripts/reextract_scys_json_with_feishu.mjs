#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DETAIL_URL_PREFIX = "https://scys.com/articleDetail/xq_topic/";
const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const options = {
    inputs: [],
    outputRoot: process.cwd(),
    mergedName: "merged_all_articles.md",
    runName: "scys-reextract",
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!current.startsWith("--")) {
      continue;
    }

    switch (current) {
      case "--input":
        options.inputs.push(next);
        index += 1;
        break;
      case "--output-root":
        options.outputRoot = next;
        index += 1;
        break;
      case "--merged-name":
        options.mergedName = next;
        index += 1;
        break;
      case "--run-name":
        options.runName = next;
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = Number(next);
        index += 1;
        break;
      default:
        throw new Error(`Unsupported argument: ${current}`);
    }
  }

  if (options.inputs.length === 0) {
    throw new Error("At least one `--input` path is required.");
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error("`--concurrency` must be a positive integer.");
  }

  options.concurrency = Math.floor(options.concurrency);
  options.outputRoot = path.resolve(options.outputRoot);
  return options;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(date) {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
}

function formatTimestamp(seconds) {
  if (!seconds) {
    return "";
  }

  return formatDateTime(new Date(Number(seconds) * 1000));
}

function decodeHtmlEntities(text = "") {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function safeDecodeURIComponentValue(value = "") {
  let current = decodeHtmlEntities(String(value));

  for (let count = 0; count < 2; count += 1) {
    if (!current.includes("%")) {
      break;
    }

    try {
      const next = decodeURIComponent(current);
      if (next === current) {
        break;
      }
      current = next;
    } catch {
      break;
    }
  }

  return current;
}

function stripTags(text = "") {
  return decodeHtmlEntities(String(text))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeWhitespace(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractAttributes(raw = "") {
  const attributes = {};
  const regex = /([:@\w-]+)=("([^"]*)"|'([^']*)')/g;
  let match = regex.exec(raw);

  while (match) {
    attributes[match[1]] = match[3] ?? match[4] ?? "";
    match = regex.exec(raw);
  }

  return attributes;
}

function normalizeUrl(url = "") {
  const value = safeDecodeURIComponentValue(url).trim();
  if (!value) {
    return "";
  }

  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function safeDecodeUrlValue(value = "") {
  return safeDecodeURIComponentValue(value);
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

function sanitizeFileSegment(value = "", maxLength = 90) {
  return String(value)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function renderInlineHtml(html = "") {
  let output = String(html);

  output = output.replace(/<e\b([^>]*)\/?>/gi, (_, rawAttrs) => {
    const attrs = extractAttributes(rawAttrs);
    const type = attrs.type || "";
    const title = safeDecodeURIComponentValue(attrs.title || "");
    const href = normalizeUrl(attrs.href || "");

    if (type === "text_bold") {
      return title ? `**${title}**` : "";
    }

    if (type === "mention" || type === "hashtag") {
      return title;
    }

    if (type === "web") {
      if (!href) {
        return title;
      }
      return title && title !== href ? `[${title}](${href})` : href;
    }

    if (href) {
      return title && title !== href ? `[${title}](${href})` : href;
    }

    return title;
  });

  output = output.replace(/<img\b([^>]*)\/?>/gi, (_, rawAttrs) => {
    const attrs = extractAttributes(rawAttrs);
    const src = normalizeUrl(attrs.src || "");
    const alt = safeDecodeURIComponentValue(attrs.alt || attrs.title || "");
    return src ? `![${alt.replace(/\]/g, "\\]")}](${src})` : "";
  });

  output = output.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, rawAttrs, inner) => {
    const attrs = extractAttributes(rawAttrs);
    const href = normalizeUrl(attrs.href || "");
    const text = stripTags(inner) || href;
    if (!href) {
      return text;
    }
    return text === href ? href : `[${text}](${href})`;
  });

  output = output.replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
    const text = stripTags(renderInlineHtml(inner));
    return text ? `**${text}**` : "";
  });

  output = output.replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
    const text = stripTags(renderInlineHtml(inner));
    return text ? `*${text}*` : "";
  });

  output = output.replace(/<(u|span|font|mark)(?:\s[^>]*)?>/gi, "");
  output = output.replace(/<\/(u|span|font|mark)>/gi, "");
  output = output.replace(/<br\s*\/?>/gi, "\n");
  output = output.replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(output);
}

function convertCodeBlockContainers(html = "") {
  return String(html).replace(
    /<div\b[^>]*class="[^"]*ql-code-block-container[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    (_, inner) => {
      const lines = [...inner.matchAll(/<div\b[^>]*class="[^"]*ql-code-block[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
        .map((match) => decodeHtmlEntities(stripTags(match[1])))
        .join("\n");

      return lines.trim() ? `\n\n\`\`\`\n${lines.trimEnd()}\n\`\`\`\n\n` : "\n\n";
    }
  );
}

function convertPreBlocks(html = "") {
  return String(html).replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = decodeHtmlEntities(stripTags(inner));
    return code.trim() ? `\n\n\`\`\`\n${code.trimEnd()}\n\`\`\`\n\n` : "\n\n";
  });
}

function htmlToMarkdown(html = "") {
  let output = String(html);

  output = output.replace(/\\(?=\s*(?:<\/p>|<\/div>|<h\d|$))/g, "");
  output = convertCodeBlockContainers(output);
  output = convertPreBlocks(output);

  output = output.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const text = normalizeWhitespace(renderInlineHtml(inner));
    return text
      ? `\n\n${text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`
      : "\n\n";
  });

  output = output.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const text = normalizeWhitespace(renderInlineHtml(inner));
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
  });

  output = output.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
    const text = normalizeWhitespace(renderInlineHtml(inner));
    return text ? `- ${text}\n` : "";
  });

  output = output.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
  output = output.replace(/<\/?(div|section|article|main)\b[^>]*>/gi, "\n");
  output = output.replace(/<p\b[^>]*>/gi, "");
  output = output.replace(/<\/p>/gi, "\n\n");
  output = output.replace(/<br\s*\/?>/gi, "\n");
  output = output.replace(/<\/?(span|font|mark)\b[^>]*>/gi, "");

  output = renderInlineHtml(output);
  output = normalizeWhitespace(output);

  return output;
}

function buildBaseInfo(item, sourceFile) {
  const topic = item?.topicDTO ?? {};
  const user = item?.topicUserDTO ?? {};
  const entityId = String(topic.entityId ?? topic.topicId ?? "");

  return {
    source_file: sourceFile,
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
    article_content: topic.articleContent ?? "",
    question_content: topic.questionContent ?? "",
    item,
  };
}

function buildScysMarkdownDocument(base) {
  const topic = base.item?.topicDTO ?? {};
  const tags = Array.isArray(topic.menuList)
    ? topic.menuList.map((entry) => entry?.value).filter(Boolean)
    : [];
  const markdownBody = htmlToMarkdown(base.article_content ?? "");
  const lines = [
    `# ${base.article_title || `未命名文章_${base.entity_id}`}`,
    "",
    `- 作者：${base.article_author}`,
    `- 发布时间：${base.publish_time}`,
    `- 原文链接：${base.scys_detail_url}`,
    `- entity_id：${base.entity_id}`,
  ];

  if (tags.length > 0) {
    lines.push(`- 标签：${tags.join(" | ")}`);
  }

  lines.push("", markdownBody || "> 正文为空", "");
  return `${lines.join("\n")}\n`;
}

function stripFrontmatter(content = "") {
  const clean = String(content).replace(/^\uFEFF/u, "");
  if (!clean.startsWith("---\n")) {
    return clean;
  }
  const endIndex = clean.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return clean;
  }
  return clean.slice(endIndex + 5);
}

function cleanFeishuMarkdownBody(content = "") {
  return decodeHtmlEntities(stripFrontmatter(content))
    .replace(/\r\n?/g, "\n")
    .replace(/<\/?(span|font|mark)\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildFeishuVisibleHeader(result) {
  const lines = [
    `# ${result.page_title || result.source_article_title || result.token}`,
    "",
    "- 来源：飞书",
    `- 飞书链接：${result.feishu_url}`,
  ];

  if (result.source_article_title) {
    lines.push(`- 来源文章：${result.source_article_title}`);
  }
  if (result.source_article_author) {
    lines.push(`- 来源作者：${result.source_article_author}`);
  }
  if (result.source_article_url) {
    lines.push(`- SCYS链接：${result.source_article_url}`);
  }
  if (result.source_entity_id) {
    lines.push(`- entity_id：${result.source_entity_id}`);
  }

  return `${lines.join("\n")}\n\n`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function ensureDir(folderPath) {
  await fs.mkdir(folderPath, { recursive: true });
}

async function getMarkdownFiles(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(folderPath, entry.name))
      .sort((left, right) => path.basename(left).localeCompare(path.basename(right), "zh-Hans-CN"));
  } catch {
    return [];
  }
}

async function mergeMarkdownFolders(rootDir, outputPath) {
  const folders = ["feishu_markdown", "scys_markdown"].map((name) => path.join(rootDir, name));
  const sections = [];

  for (const folder of folders) {
    const files = await getMarkdownFiles(folder);
    for (const file of files) {
      const content = String(await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "").trim();
      if (content) {
        sections.push(content);
      }
    }
  }

  await fs.writeFile(outputPath, `${sections.join("\n\n---\n\n")}\n`, "utf8");
}

async function runFeishuExporter(inputPath, outputRoot, concurrency) {
  const scriptPath = path.resolve("scripts", "export_feishu_markdown.mjs");
  const { stdout, stderr } = await execFileAsync("node", [
    scriptPath,
    "--input",
    inputPath,
    "--output",
    outputRoot,
    "--concurrency",
    String(concurrency),
  ], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 16,
  });

  return { stdout, stderr };
}

async function rewriteFeishuMarkdownDocs(outputRoot) {
  const manifestPath = path.join(outputRoot, "feishu_markdown_manifest.json");
  const docsDir = path.join(outputRoot, "feishu_markdown");
  const manifest = await readJson(manifestPath);

  for (const result of manifest) {
    if (!result.markdown_path || !["success", "existing"].includes(result.status)) {
      continue;
    }

    const raw = await fs.readFile(result.markdown_path, "utf8");
    const body = cleanFeishuMarkdownBody(raw);
    const nextContent = `${buildFeishuVisibleHeader(result)}${body}\n`;
    await fs.writeFile(result.markdown_path, nextContent, "utf8");
  }

  return {
    manifestPath,
    docsDir,
    successCount: manifest.filter((item) => item.status === "success").length,
    existingCount: manifest.filter((item) => item.status === "existing").length,
    failedCount: manifest.filter((item) => item.status === "failed").length,
  };
}

async function writeScysMarkdownDocs(articleRows, outputRoot) {
  const docsDir = path.join(outputRoot, "scys_markdown");
  await ensureDir(docsDir);
  const width = String(articleRows.length || 1).length;

  for (let index = 0; index < articleRows.length; index += 1) {
    const row = articleRows[index];
    const filename = `${String(index + 1).padStart(width, "0")}_${row.entity_id}_${sanitizeFileSegment(
      row.article_title || row.entity_id
    )}.md`;
    const filePath = path.join(docsDir, filename);
    await fs.writeFile(filePath, buildScysMarkdownDocument(row), "utf8");
  }

  return docsDir;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.join(options.outputRoot, `${options.runName}-${timestamp()}`);
  const normalizedPath = path.join(outputDir, "scys-search-normalized.json");
  const summaryPath = path.join(outputDir, "summary.json");

  await ensureDir(outputDir);

  const sourceFiles = [];
  const articleMap = new Map();
  const feishuRows = [];
  const entityIdsWithFeishu = new Set();
  let rawItemCount = 0;

  for (const input of options.inputs.map((item) => path.resolve(item))) {
    const source = await readJson(input);
    const items = source?.data?.topicDetailDTO?.items;

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`No items found at data.topicDetailDTO.items: ${input}`);
    }

    sourceFiles.push({ input, item_count: items.length });

    for (const item of items) {
      rawItemCount += 1;
      const base = buildBaseInfo(item, input);
      const combinedContent = `${base.article_content}\n${base.question_content}`;
      const links = extractFeishuLinks(combinedContent);

      if (links.length > 0) {
        entityIdsWithFeishu.add(base.entity_id);
        for (const url of links) {
          feishuRows.push({
            entity_id: base.entity_id,
            article_title: base.article_title,
            article_author: base.article_author,
            publish_time: base.publish_time,
            scys_detail_url: base.scys_detail_url,
            feishu_url: url,
            feishu_type: getFeishuType(url),
            favorite_count: base.favorite_count,
            like_count: base.like_count,
            comments_count: base.comments_count,
            reading_count: base.reading_count,
            menu_tags: base.menu_tags,
            source_file: base.source_file,
          });
        }
        continue;
      }

      if (!articleMap.has(base.entity_id)) {
        articleMap.set(base.entity_id, base);
      }
    }
  }

  for (const entityId of entityIdsWithFeishu) {
    articleMap.delete(entityId);
  }

  const articleRows = [...articleMap.values()].sort((left, right) =>
    (left.publish_time || "").localeCompare(right.publish_time || "") || left.entity_id.localeCompare(right.entity_id)
  );

  const normalized = {
    sourceFiles,
    feishuRows,
    articleRows: articleRows.map((row) => ({
      source_file: row.source_file,
      entity_id: row.entity_id,
      article_title: row.article_title,
      article_author: row.article_author,
      publish_time: row.publish_time,
      scys_detail_url: row.scys_detail_url,
      favorite_count: row.favorite_count,
      like_count: row.like_count,
      comments_count: row.comments_count,
      reading_count: row.reading_count,
      menu_tags: row.menu_tags,
    })),
  };

  await writeJson(normalizedPath, normalized);

  const scysDocsDir = await writeScysMarkdownDocs(articleRows, outputDir);

  let feishuSummary = {
    manifestPath: "",
    docsDir: path.join(outputDir, "feishu_markdown"),
    successCount: 0,
    existingCount: 0,
    failedCount: 0,
    stdout: "",
    stderr: "",
  };

  if (feishuRows.length > 0) {
    const { stdout, stderr } = await runFeishuExporter(normalizedPath, outputDir, options.concurrency);
    const rewritten = await rewriteFeishuMarkdownDocs(outputDir);
    feishuSummary = {
      ...rewritten,
      stdout,
      stderr,
    };
  } else {
    await ensureDir(feishuSummary.docsDir);
  }

  const mergedPath = path.join(outputDir, options.mergedName);
  await mergeMarkdownFolders(outputDir, mergedPath);

  const summary = {
    inputs: options.inputs.map((item) => path.resolve(item)),
    source_files: sourceFiles,
    output_dir: outputDir,
    normalized_file: normalizedPath,
    merged_file: mergedPath,
    scys_markdown_dir: scysDocsDir,
    feishu_markdown_dir: feishuSummary.docsDir,
    raw_item_count: rawItemCount,
    scys_article_count: articleRows.length,
    feishu_row_count: feishuRows.length,
    unique_feishu_url_count: new Set(feishuRows.map((row) => row.feishu_url)).size,
    feishu_success_count: feishuSummary.successCount,
    feishu_existing_count: feishuSummary.existingCount,
    feishu_failed_count: feishuSummary.failedCount,
    generated_at: new Date().toISOString(),
  };

  await writeJson(summaryPath, summary);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
