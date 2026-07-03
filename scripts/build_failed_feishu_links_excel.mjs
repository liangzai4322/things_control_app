#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

function parseArgs(argv) {
  const options = {
    input: path.resolve("outputs", "20260421-132858", "scys-search-normalized.json"),
    docsDir: path.resolve("outputs", "20260421-feishu-md-full", "feishu_markdown"),
    output: path.resolve("outputs", "20260421-feishu-md-full", "failed_feishu_manual_download.xlsx"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.input = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--docs") {
      options.docsDir = path.resolve(argv[index + 1]);
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

function getTokenFromUrl(url) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "unknown";
}

function collectMissingRows(input, exportedTokens) {
  const byUrl = new Map();

  for (const row of input.feishuRows) {
    const token = getTokenFromUrl(row.feishu_url);

    if (!byUrl.has(row.feishu_url)) {
      byUrl.set(row.feishu_url, {
        ...row,
        token,
        duplicate_source_count: 1,
      });
      continue;
    }

    byUrl.get(row.feishu_url).duplicate_source_count += 1;
  }

  return [...byUrl.values()]
    .filter((row) => !exportedTokens.has(row.token))
    .sort((left, right) => {
      const favDiff = Number(right.favorite_count ?? 0) - Number(left.favorite_count ?? 0);
      if (favDiff !== 0) {
        return favDiff;
      }
      return String(left.article_title ?? "").localeCompare(String(right.article_title ?? ""), "zh-Hans-CN");
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await fs.readFile(args.input, "utf8"));
  const exportedTokens = new Set(
    (await fs.readdir(args.docsDir))
      .map((name) => name.match(/__(.+)\.md$/u)?.[1] ?? null)
      .filter(Boolean),
  );

  const missingRows = collectMissingRows(input, exportedTokens);
  const workbook = Workbook.create();

  const summarySheet = workbook.worksheets.add("Summary");
  const detailSheet = workbook.worksheets.add("Failed Links");

  summarySheet.getRange("A1:D5").values = [
    ["Feishu Markdown Export Summary", null, null, null],
    ["Source search keyword", input.keyword, "Unique Feishu docs", new Set(input.feishuRows.map((row) => row.feishu_url)).size],
    ["Exported markdown count", exportedTokens.size, "Missing manual-download count", missingRows.length],
    ["Source normalized JSON", args.input, "Markdown folder", args.docsDir],
    ["Workbook generated at", new Date(), "Output path", args.output],
  ];
  summarySheet.getRange("A1:D5").format.wrapText = true;
  summarySheet.getRange("A1:D5").format.verticalAlignment = "center";
  summarySheet.getRange("A1:D5").format.rowHeightPx = 28;
  summarySheet.getRange("A1:D1").merge();
  summarySheet.getRange("A1").format = {
    fill: "#0F172A",
    font: { color: "#FFFFFF", bold: true, size: 16 },
    horizontalAlignment: "center",
  };
  summarySheet.getRange("A2:D5").format = {
    font: { size: 11 },
  };
  summarySheet.getRange("A2:A5").format.font = { bold: true, color: "#0F172A" };
  summarySheet.getRange("C2:C5").format.font = { bold: true, color: "#0F172A" };
  summarySheet.getRange("B2:B5").format.fill = "#F8FAFC";
  summarySheet.getRange("D2:D5").format.fill = "#F8FAFC";
  summarySheet.getRange("D5").format.numberFormat = "@";
  summarySheet.getRange("B5").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  summarySheet.getRange("A1:D5").format.columnWidthPx = 160;
  summarySheet.getRange("A1").format.columnWidthPx = 220;
  summarySheet.getRange("B4:D5").format.wrapText = true;

  const headers = [
    "序号",
    "飞书类型",
    "飞书链接",
    "打开飞书",
    "来源文章标题",
    "作者",
    "发布时间",
    "生财详情页",
    "打开生财",
    "收藏",
    "点赞",
    "评论",
    "阅读",
    "标签",
    "重复来源数",
  ];

  detailSheet.getRange(`A1:O${missingRows.length + 3}`).format = {
    verticalAlignment: "center",
    wrapText: true,
    font: { size: 10 },
  };
  detailSheet.getRange("A1:O1").merge();
  detailSheet.getRange("A1").values = [["手动补下载飞书链接清单"]];
  detailSheet.getRange("A1").format = {
    fill: "#1D4ED8",
    font: { color: "#FFFFFF", bold: true, size: 15 },
    horizontalAlignment: "center",
  };
  detailSheet.getRange("A2:O2").merge();
  detailSheet.getRange("A2").values = [[`当前缺失 ${missingRows.length} 个飞书文档，已按收藏量倒序排列。可直接点击“打开飞书”或“打开生财”。`]];
  detailSheet.getRange("A2").format = {
    fill: "#DBEAFE",
    font: { color: "#1E3A8A" },
  };
  detailSheet.getRange("A3:O3").values = [headers];
  detailSheet.getRange("A3:O3").format = {
    fill: "#E2E8F0",
    font: { bold: true, color: "#0F172A" },
    horizontalAlignment: "center",
  };

  const rows = missingRows.map((row, index) => [
    index + 1,
    row.feishu_type,
    row.feishu_url,
    null,
    row.article_title,
    row.article_author,
    row.publish_time,
    row.scys_detail_url,
    null,
    Number(row.favorite_count ?? 0),
    Number(row.like_count ?? 0),
    Number(row.comments_count ?? 0),
    Number(row.reading_count ?? 0),
    row.menu_tags,
    Number(row.duplicate_source_count ?? 1),
  ]);

  if (rows.length > 0) {
    detailSheet.getRange(`A4:O${rows.length + 3}`).values = rows;

    const feishuLinkFormulas = missingRows.map((row) => [`=HYPERLINK("${row.feishu_url}","打开飞书")`]);
    const scysLinkFormulas = missingRows.map((row) => [`=HYPERLINK("${row.scys_detail_url}","打开生财")`]);
    detailSheet.getRange(`D4:D${rows.length + 3}`).formulas = feishuLinkFormulas;
    detailSheet.getRange(`I4:I${rows.length + 3}`).formulas = scysLinkFormulas;

    const table = detailSheet.tables.add(`A3:O${rows.length + 3}`, true, "FailedFeishuLinks");
    table.style = "TableStyleMedium2";
  }

  detailSheet.freezePanes.freezeRows(3);
  detailSheet.showGridLines = false;
  detailSheet.getRange("A:A").format.columnWidthPx = 56;
  detailSheet.getRange("B:B").format.columnWidthPx = 74;
  detailSheet.getRange("C:C").format.columnWidthPx = 320;
  detailSheet.getRange("D:D").format.columnWidthPx = 92;
  detailSheet.getRange("E:E").format.columnWidthPx = 260;
  detailSheet.getRange("F:F").format.columnWidthPx = 92;
  detailSheet.getRange("G:G").format.columnWidthPx = 136;
  detailSheet.getRange("H:H").format.columnWidthPx = 240;
  detailSheet.getRange("I:I").format.columnWidthPx = 92;
  detailSheet.getRange("J:M").format.columnWidthPx = 72;
  detailSheet.getRange("N:N").format.columnWidthPx = 220;
  detailSheet.getRange("O:O").format.columnWidthPx = 82;
  detailSheet.getRange(`A4:O${missingRows.length + 3}`).format.rowHeightPx = 48;
  detailSheet.getRange(`J4:M${missingRows.length + 3}`).format.horizontalAlignment = "center";

  const lastDataRow = missingRows.length + 3;
  if (missingRows.length > 0) {
    detailSheet.getRange(`J4:J${lastDataRow}`).conditionalFormats.addDataBar({
      color: "#2563EB",
      gradient: true,
    });
    detailSheet.getRange(`K4:K${lastDataRow}`).conditionalFormats.addDataBar({
      color: "#16A34A",
      gradient: true,
    });
    detailSheet.getRange(`M4:M${lastDataRow}`).conditionalFormats.addDataBar({
      color: "#F59E0B",
      gradient: true,
    });
  }

  const inspectResult = await workbook.inspect({
    kind: "table",
    range: `Failed Links!A1:O${Math.min(lastDataRow, 12)}`,
    include: "values,formulas",
    tableMaxRows: 12,
    tableMaxCols: 15,
  });
  console.log(inspectResult.ndjson);

  const previewBlob = await workbook.render({
    sheetName: "Failed Links",
    range: `A1:O${Math.min(lastDataRow, 14)}`,
    scale: 1.5,
    format: "png",
  });

  const previewPath = args.output.replace(/\.xlsx$/iu, ".png");
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(previewPath, new Uint8Array(await previewBlob.arrayBuffer()));

  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  await xlsx.save(args.output);

  console.log(`Saved workbook: ${args.output}`);
  console.log(`Saved preview: ${previewPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
