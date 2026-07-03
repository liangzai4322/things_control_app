#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    input: "",
    outputDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--input") {
      options.input = path.resolve(next);
      index += 1;
    } else if (current === "--output-dir") {
      options.outputDir = path.resolve(next);
      index += 1;
    }
  }

  if (!options.input) {
    throw new Error("Missing --input.");
  }
  if (!options.outputDir) {
    throw new Error("Missing --output-dir.");
  }

  return options;
}

function sanitizeFilename(value) {
  return String(value || "untitled")
    .normalize("NFKC")
    .replace(/，/g, ",")
    .replace(/[：:？?]/g, " ")
    .replace(/[<>"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72)
    .replace(/[. ]+$/g, "") || "untitled";
}

function yamlString(value) {
  if (value === null || value === undefined || value === "") {
    return '""';
  }

  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function countTextChars(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

function buildTopicMarkdown(item) {
  const lines = [
    "---",
    `title: ${yamlString(item.title)}`,
    `rank: ${Number(item.rank)}`,
    `topic_id: ${yamlString(item.topic_id)}`,
    `create_time: ${yamlString(item.create_time)}`,
    `author: ${yamlString(item.author)}`,
    `detail_url: ${yamlString(item.detail_url)}`,
    `selection_reason: ${yamlString(item.selection_reason)}`,
    `likes_count: ${Number(item.likes_count ?? 0)}`,
    `comments_count: ${Number(item.comments_count ?? 0)}`,
    `reading_count: ${Number(item.reading_count ?? 0)}`,
    `needs_external_article: ${Boolean(item.needs_external_article)}`,
    "---",
    "",
    `# ${item.title || `Topic ${item.topic_id}`}`,
    "",
    `- Rank: ${item.rank}`,
    `- Time: ${item.create_time || ""}`,
    `- Author: ${item.author || ""}`,
    `- Topic ID: ${item.topic_id || ""}`,
    `- Source: ${item.detail_url || ""}`,
    `- Selection reason: ${item.selection_reason || ""}`,
    `- Stats: ${Number(item.likes_count ?? 0)} likes / ${Number(item.comments_count ?? 0)} comments / ${Number(item.reading_count ?? 0)} reads`,
  ];

  if (item.needs_external_article) {
    lines.push(
      "- Note: This topic references an external long article; the file only contains content already present in the fetched topic detail."
    );
  }

  if (Array.isArray(item.links) && item.links.length > 0) {
    lines.push("", "## Links", "");
    for (const link of item.links) {
      lines.push(`- ${link.title || link.url || "link"}: ${link.url || ""}`);
    }
  }

  lines.push("", String(item.text || "").trim(), "");
  return lines.join("\n");
}

function buildIndex(manifest, input) {
  const lines = [
    "# Project Case Markdown Index",
    "",
    `Source: ${input}`,
    `Count: ${manifest.length}`,
    "",
  ];

  for (const item of manifest) {
    const note = item.needs_external_article ? " [partial article note]" : "";
    lines.push(`- ${String(item.rank).padStart(2, "0")}. [${item.title}](./${encodeURIComponent(item.file)})${note}`);
  }

  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = JSON.parse(fs.readFileSync(options.input, "utf8"));
  if (!Array.isArray(records)) {
    throw new Error("--input must be a JSON array.");
  }

  fs.mkdirSync(options.outputDir, { recursive: true });

  const manifest = [];
  for (const item of records) {
    const rank = Number(item.rank);
    const prefix = String(Number.isFinite(rank) ? rank : manifest.length + 1).padStart(2, "0");
    const topicId = String(item.topic_id || "unknown");
    const filename = `${prefix}_${topicId}_${sanitizeFilename(item.title)}.md`;
    const outputPath = path.join(options.outputDir, filename);

    fs.writeFileSync(outputPath, buildTopicMarkdown(item), "utf8");
    manifest.push({
      rank: item.rank,
      topic_id: topicId,
      title: item.title || "",
      file: filename,
      create_time: item.create_time || "",
      author: item.author || "",
      needs_external_article: Boolean(item.needs_external_article),
      text_chars: countTextChars(item.text),
    });
  }

  fs.writeFileSync(path.join(options.outputDir, "00_index.md"), buildIndex(manifest, options.input), "utf8");
  fs.writeFileSync(path.join(options.outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`Wrote ${manifest.length} project case markdown files to ${options.outputDir}`);
}

main();
