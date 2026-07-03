import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";

const API_URL = "https://scys.com/shengcai-web/client/homePage/searchTopic";
const DETAIL_URL_PREFIX = "https://scys.com/articleDetail/xq_topic/";
const DEFAULT_STATE_FILE = path.resolve("data", "scys-digested-post-state.json");
const DEFAULT_OUTPUT_ROOT = path.resolve("outputs");
const PAGE_SIZE_CANDIDATES = [120, 100, 50, 30];

function parseArgs(argv) {
  const options = {
    token: process.env.SCYS_X_TOKEN ?? "",
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    orderBy: "like_count",
    displayMode: 2,
    pageScene: "homePage",
    isDigested: true,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    stateFile: DEFAULT_STATE_FILE,
    pageSize: 0,
    probePageSize: true,
    runLabel: "scys-digested-2025",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!current.startsWith("--")) {
      continue;
    }

    switch (current) {
      case "--token":
        options.token = next;
        index += 1;
        break;
      case "--start-date":
        options.startDate = next;
        index += 1;
        break;
      case "--end-date":
        options.endDate = next;
        index += 1;
        break;
      case "--order-by":
        options.orderBy = next;
        index += 1;
        break;
      case "--output-root":
        options.outputRoot = path.resolve(next);
        index += 1;
        break;
      case "--state-file":
        options.stateFile = path.resolve(next);
        index += 1;
        break;
      case "--page-size":
        options.pageSize = Number(next);
        index += 1;
        break;
      case "--run-label":
        options.runLabel = next;
        index += 1;
        break;
      case "--no-probe-page-size":
        options.probePageSize = false;
        break;
      default:
        throw new Error(`Unsupported argument: ${current}`);
    }
  }

  if (!options.token) {
    throw new Error("Missing token. Pass `--token` or set `SCYS_X_TOKEN`.");
  }

  if (options.pageSize && (!Number.isFinite(options.pageSize) || options.pageSize < 1)) {
    throw new Error("`--page-size` must be a positive integer.");
  }

  return options;
}

function formatRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function toShanghaiTimestamp(dateString, endOfDay = false) {
  const suffix = endOfDay ? "23:59:59+08:00" : "00:00:00+08:00";
  return Math.floor(new Date(`${dateString}T${suffix}`).getTime() / 1000);
}

function formatTimestamp(seconds) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return formatter.format(new Date(Number(seconds) * 1000)).replace(" ", " ");
}

function formatShortDate(seconds) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(new Date(Number(seconds) * 1000)).replaceAll("/", "-");
}

async function requestPage(options, pageIndex, pageSize) {
  const payload = {
    pageIndex,
    pageSize,
    orderBy: options.orderBy,
    displayMode: options.displayMode,
    gmtCreateStart: toShanghaiTimestamp(options.startDate, false),
    gmtCreateEnd: toShanghaiTimestamp(options.endDate, true),
    isDigested: options.isDigested,
    pageScene: options.pageScene,
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: "https://scys.com",
      referer: "https://scys.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      "x-device-type": "pc",
      "x-token": options.token,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON for page ${pageIndex}, pageSize ${pageSize}: ${error}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for page ${pageIndex}, pageSize ${pageSize}`);
  }

  const items = Array.isArray(json?.data?.items) ? json.data.items : [];
  const total = Number(json?.data?.total ?? 0);

  return { payload, response, json, items, total };
}

function isValidTopicItem(item) {
  return Boolean(item?.topicDTO?.entityId && item?.topicDTO?.showTitle);
}

async function probePageSize(options) {
  const probes = [];

  for (const candidate of PAGE_SIZE_CANDIDATES) {
    try {
      const firstPage = await requestPage(options, 1, candidate);
      const validFirstPage = firstPage.total > 0 && firstPage.items.length > 0 && firstPage.items.every(isValidTopicItem);

      if (!validFirstPage) {
        probes.push({
          pageSize: candidate,
          ok: false,
          reason: "Malformed first-page payload",
          total: firstPage.total,
          itemCount: firstPage.items.length,
        });
        continue;
      }

      if (firstPage.total > candidate) {
        const secondPage = await requestPage(options, 2, candidate);
        const validSecondPage =
          secondPage.items.length > 0 && secondPage.items.every(isValidTopicItem);

        if (!validSecondPage) {
          probes.push({
            pageSize: candidate,
            ok: false,
            reason: "Malformed second-page payload",
            total: secondPage.total,
            itemCount: secondPage.items.length,
          });
          continue;
        }
      }

      probes.push({
        pageSize: candidate,
        ok: true,
        total: firstPage.total,
        itemCount: firstPage.items.length,
      });

      return { pageSize: candidate, probes };
    } catch (error) {
      probes.push({
        pageSize: candidate,
        ok: false,
        reason: String(error),
      });
    }
  }

  throw new Error(`Could not find a stable pageSize. Probes: ${JSON.stringify(probes)}`);
}

function toMenuTags(menuList) {
  return Array.isArray(menuList) ? menuList.map((item) => item?.value).filter(Boolean).join(" | ") : "";
}

function normalizeItem(entry, rank) {
  const topic = entry?.topicDTO ?? {};
  const user = entry?.topicUserDTO ?? {};
  const entityId = String(topic.entityId ?? topic.topicId ?? "");

  return {
    rank,
    entity_id: entityId,
    short_date: formatShortDate(topic.gmtCreate),
    publish_time: formatTimestamp(topic.gmtCreate),
    title: topic.showTitle ?? "",
    author: user.name ?? "",
    like_count: Number(topic.likeCount ?? 0),
    favorite_count: Number(topic.favoriteCount ?? 0),
    comments_count: Number(topic.commentsCount ?? 0),
    reading_count: Number(topic.readingCount ?? 0),
    coin_count: Number(topic.coinCount ?? 0),
    detail_url: entityId ? `${DETAIL_URL_PREFIX}${entityId}` : "",
    menu_tags: toMenuTags(topic.menuList),
  };
}

async function loadState(stateFile) {
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch {
    return {
      seen_entity_ids: [],
      runs: [],
      last_updated_at: "",
    };
  }
}

async function saveState(stateFile, nextState) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(nextState, null, 2), "utf8");
}

function buildMarkdown(records, heading) {
  const lines = [`# ${heading}`, ""];

  for (const record of records) {
    lines.push(
      `${String(record.rank).padStart(4, "0")}. [${record.short_date}] Like ${record.like_count} ${record.title}`
    );
    lines.push(
      `Author: ${record.author} | ID: ${record.entity_id} | Link: ${record.detail_url}`
    );

    if (record.menu_tags) {
      lines.push(`Tags: ${record.menu_tags}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pageSizeProbe = options.pageSize
    ? {
        pageSize: options.pageSize,
        probes: [{ pageSize: options.pageSize, ok: true, reason: "Manual override" }],
      }
    : options.probePageSize
      ? await probePageSize(options)
      : { pageSize: 30, probes: [{ pageSize: 30, ok: true, reason: "Probe disabled" }] };

  const pageSize = pageSizeProbe.pageSize;
  const firstPage = await requestPage(options, 1, pageSize);
  const total = firstPage.total;
  const totalPages = Math.ceil(total / pageSize);
  const rawItems = [...firstPage.items];

  for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
    const page = await requestPage(options, pageIndex, pageSize);
    rawItems.push(...page.items);
  }

  const deduped = [];
  const seen = new Set();

  for (const item of rawItems) {
    const entityId = String(item?.topicDTO?.entityId ?? item?.topicDTO?.topicId ?? "");
    if (!entityId || seen.has(entityId)) {
      continue;
    }
    seen.add(entityId);
    deduped.push(item);
  }

  const allRecords = deduped.map((item, index) => normalizeItem(item, index + 1));
  const state = await loadState(options.stateFile);
  const seenEntityIds = new Set(state.seen_entity_ids ?? []);
  const newRecords = allRecords.filter((record) => !seenEntityIds.has(record.entity_id));

  const nextState = {
    seen_entity_ids: [...new Set([...(state.seen_entity_ids ?? []), ...allRecords.map((item) => item.entity_id)])].sort(),
    runs: [
      ...(state.runs ?? []),
      {
        run_id: formatRunId(),
        start_date: options.startDate,
        end_date: options.endDate,
        total_count: allRecords.length,
        new_count: newRecords.length,
        order_by: options.orderBy,
        page_size: pageSize,
      },
    ],
    last_updated_at: new Date().toISOString(),
  };

  const outputDir = path.join(options.outputRoot, `${options.runLabel}-${formatRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const allJsonPath = path.join(outputDir, "all_posts.json");
  const newJsonPath = path.join(outputDir, "new_posts.json");
  const allMdPath = path.join(outputDir, "all_posts.md");
  const newMdPath = path.join(outputDir, "new_posts.md");
  const summaryPath = path.join(outputDir, "summary.json");

  await fs.writeFile(allJsonPath, JSON.stringify(allRecords, null, 2), "utf8");
  await fs.writeFile(newJsonPath, JSON.stringify(newRecords, null, 2), "utf8");
  await fs.writeFile(
    allMdPath,
    `\uFEFF${buildMarkdown(allRecords, `SCYS Digested Posts ${options.startDate} to ${options.endDate} (All)`)}`,
    "utf8"
  );
  await fs.writeFile(
    newMdPath,
    `\uFEFF${buildMarkdown(newRecords, `SCYS Digested Posts ${options.startDate} to ${options.endDate} (New Only)`)}`,
    "utf8"
  );

  const summary = {
    start_date: options.startDate,
    end_date: options.endDate,
    requested_range_start_timestamp: toShanghaiTimestamp(options.startDate, false),
    requested_range_end_timestamp: toShanghaiTimestamp(options.endDate, true),
    total_count: allRecords.length,
    new_count: newRecords.length,
    page_size: pageSize,
    total_pages: totalPages,
    page_size_probe: pageSizeProbe.probes,
    output_dir: outputDir,
    all_json: allJsonPath,
    new_json: newJsonPath,
    all_markdown: allMdPath,
    new_markdown: newMdPath,
    state_file: options.stateFile,
    generated_at: new Date().toISOString(),
  };

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  await saveState(options.stateFile, nextState);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
