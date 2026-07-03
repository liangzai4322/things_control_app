#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_ROOT = path.resolve(
  "D:\\page\\2023\\2025\\2026\\4\\12_\\time_control_app\\outputs\\20260421-feishu-md-full",
);

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    output: path.join(DEFAULT_ROOT, "merged_all_markdown.md"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = path.resolve(argv[index + 1]);
      index += 1;
    }
  }

  return options;
}

function stripFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return content;
  }

  const endIndex = content.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return content;
  }

  return content.slice(endIndex + 5);
}

function normalizeContent(content) {
  return stripFrontmatter(content.replace(/^\uFEFF/u, ""))
    .replace(/\r\n?/g, "\n")
    .trim();
}

async function getMarkdownFiles(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => ({
      folderName: path.basename(folderPath),
      fullPath: path.join(folderPath, entry.name),
      fileName: entry.name,
      title: path.basename(entry.name, ".md"),
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-Hans-CN"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const folders = ["feishu_markdown", "scys_markdown"].map((name) => path.join(args.root, name));
  const sections = [];

  for (const folder of folders) {
    const files = await getMarkdownFiles(folder);

    for (const file of files) {
      const rawContent = await fs.readFile(file.fullPath, "utf8");
      const content = normalizeContent(rawContent);
      sections.push(`# ${file.title}\n\n${content}`);
    }
  }

  const mergedContent = `${sections.join("\n\n---\n\n")}\n`;
  await fs.writeFile(args.output, `\uFEFF${mergedContent}`, "utf8");

  console.log(`Merged files: ${sections.length}`);
  console.log(`Output: ${args.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
