import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = "D:/note_new/01-plan/2026/tt.json";
const DEFAULT_OUTPUT_ROOT = "D:/note_new/01-plan/2026";
const DETAIL_URL_PREFIX = "https://scys.com/articleDetail/xq_topic/";

function parseArgs(argv) {
  const options = {
    inputs: [DEFAULT_INPUT],
    outputRoot: DEFAULT_OUTPUT_ROOT,
    mergedName: "merged_all_articles.md",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!current.startsWith("--")) {
      continue;
    }

    switch (current) {
      case "--input":
        if (options.inputs.length === 1 && options.inputs[0] === DEFAULT_INPUT) {
          options.inputs = [];
        }
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
      default:
        throw new Error(`Unsupported argument: ${current}`);
    }
  }

  return options;
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

function runId() {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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

function safeDecodeURIComponent(value = "") {
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
  const value = safeDecodeURIComponent(url).trim();
  if (!value) {
    return "";
  }

  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function renderInlineHtml(html = "") {
  let output = String(html);

  output = output.replace(/<e\b([^>]*)\/?>/gi, (_, rawAttrs) => {
    const attrs = extractAttributes(rawAttrs);
    const type = attrs.type || "";
    const title = safeDecodeURIComponent(attrs.title || "");
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
    const alt = safeDecodeURIComponent(attrs.alt || attrs.title || "");
    return src ? `![${
      alt.replace(/\]/g, "\\]") || ""
    }](${src})` : "";
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

  output = renderInlineHtml(output);
  output = normalizeWhitespace(output);

  return output;
}

function sanitizeFileSegment(value = "", maxLength = 80) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function buildMarkdownDocument(item) {
  const topic = item?.topicDTO ?? {};
  const user = item?.topicUserDTO ?? {};
  const title = topic.showTitle || `未命名文章_${topic.entityId || ""}`;
  const entityId = String(topic.entityId ?? topic.topicId ?? "");
  const detailUrl = entityId ? `${DETAIL_URL_PREFIX}${entityId}` : "";
  const publishTime = formatTimestamp(topic.gmtCreate);
  const tags = Array.isArray(topic.menuList)
    ? topic.menuList.map((entry) => entry?.value).filter(Boolean)
    : [];
  const markdownBody = htmlToMarkdown(topic.articleContent ?? "");
  const lines = [
    `# ${title}`,
    "",
    `- 作者：${user.name ?? ""}`,
    `- 发布时间：${publishTime}`,
    `- 原文链接：${detailUrl}`,
    `- entity_id：${entityId}`,
  ];

  if (tags.length > 0) {
    lines.push(`- 标签：${tags.join(" | ")}`);
  }

  lines.push("", markdownBody || "> 正文为空", "");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allItems = [];
  const sourceFiles = [];

  for (const input of options.inputs) {
    const source = JSON.parse(await fs.readFile(input, "utf8"));
    const items = source?.data?.topicDetailDTO?.items;

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`JSON 中未找到 data.topicDetailDTO.items 或列表为空: ${input}`);
    }

    allItems.push(
      ...items.map((item) => ({
        ...item,
        __sourceFile: input,
      }))
    );
    sourceFiles.push({
      input,
      item_count: items.length,
    });
  }

  const outputDir = path.join(options.outputRoot, `tt-markdown-export-${runId()}`);
  const articlesDir = path.join(outputDir, "articles");
  await fs.mkdir(articlesDir, { recursive: true });

  const mergedParts = [];
  const manifest = [];
  const width = String(allItems.length).length;

  for (let index = 0; index < allItems.length; index += 1) {
    const item = allItems[index];
    const topic = item?.topicDTO ?? {};
    const entityId = String(topic.entityId ?? topic.topicId ?? "");
    const title = topic.showTitle || `未命名文章_${entityId || index + 1}`;
    const filename = `${String(index + 1).padStart(width, "0")}_${entityId}_${sanitizeFileSegment(
      title
    )}.md`;
    const filePath = path.join(articlesDir, filename);
    const markdown = buildMarkdownDocument(item);

    await fs.writeFile(filePath, markdown, "utf8");
    mergedParts.push(markdown.trim());
    manifest.push({
      index: index + 1,
      entity_id: entityId,
      title,
      source_file: item.__sourceFile ?? "",
      file_name: filename,
      file_path: filePath,
      publish_time: formatTimestamp(topic.gmtCreate),
      article_url: entityId ? `${DETAIL_URL_PREFIX}${entityId}` : "",
      article_content_length: Number(topic.articleContentLength ?? String(topic.articleContent ?? "").length),
    });
  }

  const mergedPath = path.join(outputDir, options.mergedName);
  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.writeFile(mergedPath, `${mergedParts.join("\n\n---\n\n")}\n`, "utf8");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        inputs: options.inputs,
        source_files: sourceFiles,
        output_dir: outputDir,
        articles_dir: articlesDir,
        merged_file: mergedPath,
        manifest_file: manifestPath,
        article_count: allItems.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
