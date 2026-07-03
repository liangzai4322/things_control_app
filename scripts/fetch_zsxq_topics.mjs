#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";

const API_HOST = "https://api.zsxq.com";
const WEB_ORIGIN = "https://wx.zsxq.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const options = {
    groupId: "",
    beginTime: "",
    endTime: "",
    outputDir: "",
    scope: "digests",
    count: 20,
    cookie: process.env.ZSXQ_COOKIE ?? "",
    aduid: process.env.ZSXQ_ADUID ?? "79085ca02-a4d0-46ca-a22f-f28c5d0e274",
    xVersion: process.env.ZSXQ_X_VERSION ?? "2.91.0",
    concurrency: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!current.startsWith("--")) {
      continue;
    }

    switch (current) {
      case "--group-id":
        options.groupId = next;
        index += 1;
        break;
      case "--begin-time":
        options.beginTime = next;
        index += 1;
        break;
      case "--end-time":
        options.endTime = next;
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = path.resolve(next);
        index += 1;
        break;
      case "--scope":
        options.scope = next;
        index += 1;
        break;
      case "--count":
        options.count = Number(next);
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

  if (!options.groupId) {
    throw new Error("Missing --group-id.");
  }
  if (!options.beginTime || !options.endTime) {
    throw new Error("Missing --begin-time or --end-time.");
  }
  if (!options.outputDir) {
    throw new Error("Missing --output-dir.");
  }
  if (!options.cookie) {
    throw new Error("Missing cookie. Set ZSXQ_COOKIE in the environment.");
  }
  if (!Number.isFinite(options.count) || options.count < 1) {
    throw new Error("--count must be a positive number.");
  }
  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive number.");
  }

  options.count = Math.floor(options.count);
  options.concurrency = Math.floor(options.concurrency);
  return options;
}

function signHeaders(url, options) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();
  const signature = crypto.createHash("sha1").update(`${url} ${timestamp} ${requestId}`).digest("hex");

  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    cookie: options.cookie,
    origin: WEB_ORIGIN,
    referer: `${WEB_ORIGIN}/`,
    "user-agent": DEFAULT_USER_AGENT,
    "x-aduid": options.aduid,
    "x-request-id": requestId,
    "x-signature": signature,
    "x-timestamp": timestamp,
    "x-version": options.xVersion,
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: signHeaders(url, options),
  });
  const text = await response.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON from ${url}: ${error}. Body starts with: ${text.slice(0, 160)}`);
  }

  if (!response.ok || json?.succeeded === false) {
    throw new Error(`Request failed for ${url}: HTTP ${response.status}, code ${json?.code}, info ${json?.info ?? ""}`);
  }

  return json;
}

function buildTopicsUrl(options, endTime) {
  const params = new URLSearchParams({
    scope: options.scope,
    count: String(options.count),
    begin_time: options.beginTime,
    end_time: endTime,
  });
  return `${API_HOST}/v2/groups/${options.groupId}/topics?${params.toString()}`;
}

function parseZsxqTime(value) {
  return new Date(String(value).replace(/([+-]\d{2})(\d{2})$/u, "$1:$2"));
}

function formatZsxqTime(date) {
  const shanghaiParts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).formatToParts(date);
  const part = (type) => shanghaiParts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${part(
    "fractionalSecond"
  )}+0800`;
}

function previousMillisecond(timeValue) {
  return formatZsxqTime(new Date(parseZsxqTime(timeValue).getTime() - 1));
}

async function fetchTopicPages(options) {
  const pages = [];
  const topics = [];
  const seen = new Set();
  let endTime = options.endTime;
  const beginDate = parseZsxqTime(options.beginTime);

  for (let pageIndex = 1; pageIndex <= 500; pageIndex += 1) {
    const url = buildTopicsUrl(options, endTime);
    const json = await requestJson(url, options);
    const pageTopics = Array.isArray(json?.resp_data?.topics) ? json.resp_data.topics : [];

    pages.push({
      page_index: pageIndex,
      request_end_time: endTime,
      url,
      count: pageTopics.length,
      first_time: pageTopics[0]?.create_time ?? "",
      last_time: pageTopics.at(-1)?.create_time ?? "",
      topic_ids: pageTopics.map((topic) => String(topic.topic_id)),
    });

    for (const topic of pageTopics) {
      const id = String(topic.topic_id ?? topic.topic_uid ?? "");
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      topics.push(topic);
    }

    if (pageTopics.length < options.count) {
      break;
    }

    const lastTime = pageTopics.at(-1)?.create_time;
    if (!lastTime || parseZsxqTime(lastTime) < beginDate) {
      break;
    }

    endTime = previousMillisecond(lastTime);
  }

  return { pages, topics };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

async function fetchTopicDetails(topics, options) {
  const failures = [];
  const details = await runWithConcurrency(topics, options.concurrency, async (topic) => {
    const topicId = String(topic.topic_id ?? topic.topic_uid);
    const url = `${API_HOST}/v2/topics/${topicId}`;
    try {
      const json = await requestJson(url, options);
      return json?.resp_data?.topic ?? topic;
    } catch (error) {
      failures.push({
        topic_id: topicId,
        error: error instanceof Error ? error.message : String(error),
      });
      return topic;
    }
  });

  return { details, failures };
}

function decodeHtmlEntities(value = "") {
  const named = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", "\""],
    ["apos", "'"],
    ["nbsp", " "],
  ]);

  return String(value)
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/giu, (match, name) => named.get(name.toLowerCase()) ?? match);
}

function safeDecodeURIComponent(value = "") {
  let current = decodeHtmlEntities(value);
  for (let index = 0; index < 2; index += 1) {
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

function extractAttributes(raw = "") {
  const attrs = {};
  const regex = /([:@\w-]+)=("([^"]*)"|'([^']*)')/gu;
  let match = regex.exec(raw);
  while (match) {
    attrs[match[1]] = match[3] ?? match[4] ?? "";
    match = regex.exec(raw);
  }
  return attrs;
}

function normalizeUrlCandidate(value = "") {
  const cleaned = safeDecodeURIComponent(value)
    .replace(/\\/gu, "")
    .replace(/^[("'`<\s]+/u, "")
    .replace(/[>"'`)\],，。；;、\s]+$/u, "");

  if (!/^https?:\/\//iu.test(cleaned)) {
    return "";
  }

  try {
    const url = new URL(cleaned);
    url.hash = "";
    return url.toString();
  } catch {
    return cleaned;
  }
}

function renderZsxqText(rawText = "") {
  let output = String(rawText);

  output = output.replace(/<e\b([^>]*)\/?>/giu, (_, rawAttrs) => {
    const attrs = extractAttributes(rawAttrs);
    const title = safeDecodeURIComponent(attrs.title ?? "");
    const href = normalizeUrlCandidate(attrs.href ?? "");

    if (attrs.type === "web" && href) {
      return title && title !== href ? `[${title}](${href})` : href;
    }

    return title || href || "";
  });

  output = output
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return decodeHtmlEntities(output);
}

function getRawText(topic) {
  return [
    topic?.talk?.text,
    topic?.question?.text,
    topic?.answer?.text,
    topic?.solution?.text,
    topic?.task?.text,
    topic?.title,
    topic?.annotation,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function getOwnerName(topic) {
  return (
    topic?.talk?.owner?.name ??
    topic?.question?.owner?.name ??
    topic?.answer?.owner?.name ??
    topic?.solution?.owner?.name ??
    topic?.owner?.name ??
    ""
  );
}

function getTitle(topic, text) {
  const explicitTitle = renderZsxqText(topic?.title ?? "").replace(/\s+/gu, " ").trim();
  if (explicitTitle) {
    return explicitTitle.slice(0, 120);
  }

  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? `topic-${topic?.topic_id ?? ""}`).slice(0, 120);
}

function extractLinks(rawText, renderedText) {
  const candidates = new Set();
  const hrefRegex = /href=(?:"([^"]+)"|'([^']+)')/giu;
  let hrefMatch = hrefRegex.exec(rawText);
  while (hrefMatch) {
    candidates.add(hrefMatch[1] || hrefMatch[2] || "");
    hrefMatch = hrefRegex.exec(rawText);
  }

  const directRegex = /(https?:\/\/[^\s"'<>）)】\]]+)/giu;
  let directMatch = directRegex.exec(`${rawText}\n${renderedText}`);
  while (directMatch) {
    candidates.add(directMatch[1]);
    directMatch = directRegex.exec(`${rawText}\n${renderedText}`);
  }

  return [...candidates]
    .map((candidate) => normalizeUrlCandidate(candidate))
    .filter(Boolean)
    .filter((url, index, list) => list.indexOf(url) === index);
}

function isFeishuUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("feishu.cn") && /\/(docx|wiki)\//iu.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeTopic(topic, rank) {
  const rawText = getRawText(topic);
  const text = renderZsxqText(rawText);
  const links = extractLinks(rawText, text);
  const feishuLinks = links.filter(isFeishuUrl);

  return {
    rank,
    topic_id: String(topic.topic_id ?? topic.topic_uid ?? ""),
    type: topic.type ?? "",
    create_time: topic.create_time ?? "",
    modify_time: topic.modify_time ?? "",
    title: getTitle(topic, text),
    author: getOwnerName(topic),
    likes_count: Number(topic.likes_count ?? 0),
    comments_count: Number(topic.comments_count ?? 0),
    reading_count: Number(topic.reading_count ?? 0),
    rewards_count: Number(topic.rewards_count ?? 0),
    detail_url: `${WEB_ORIGIN}/group/${topic?.group?.group_id ?? ""}/topic/${topic.topic_id ?? topic.topic_uid ?? ""}`,
    links,
    feishu_links: feishuLinks,
    images: Array.isArray(topic?.talk?.images) ? topic.talk.images.map((image) => image?.large?.url ?? image?.url ?? "").filter(Boolean) : [],
    text,
    raw: topic,
  };
}

function buildMarkdown(records, heading) {
  const lines = [`# ${heading}`, ""];

  for (const record of records) {
    lines.push(`## ${record.rank}. ${record.title}`);
    lines.push("");
    lines.push(`- 时间: ${record.create_time}`);
    lines.push(`- 作者: ${record.author}`);
    lines.push(`- Topic ID: ${record.topic_id}`);
    lines.push(`- 链接: ${record.detail_url}`);
    lines.push(`- 数据: ${record.likes_count} 赞 / ${record.comments_count} 评论 / ${record.reading_count} 阅读`);
    if (record.links.length > 0) {
      lines.push(`- 外链: ${record.links.join(" ; ")}`);
    }
    lines.push("");
    lines.push(record.text || "> 正文为空");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.outputDir, { recursive: true });

  const { pages, topics } = await fetchTopicPages(options);
  const { details, failures } = await fetchTopicDetails(topics, options);
  const records = details.map((topic, index) => normalizeTopic(topic, index + 1));
  const feishuRows = records.flatMap((record) =>
    record.feishu_links.map((url) => ({
      topic_id: record.topic_id,
      article_title: record.title,
      article_author: record.author,
      publish_time: record.create_time,
      zsxq_detail_url: record.detail_url,
      feishu_url: url,
      feishu_type: new URL(url).pathname.includes("/wiki/") ? "wiki" : "docx",
      likes_count: record.likes_count,
      comments_count: record.comments_count,
      reading_count: record.reading_count,
    }))
  );

  const summary = {
    group_id: options.groupId,
    begin_time: options.beginTime,
    end_time: options.endTime,
    total_topics: records.length,
    page_count: pages.length,
    detail_failure_count: failures.length,
    feishu_row_count: feishuRows.length,
    output_dir: options.outputDir,
    generated_at: new Date().toISOString(),
  };

  await fs.writeFile(path.join(options.outputDir, "raw_pages.json"), JSON.stringify(pages, null, 2), "utf8");
  await fs.writeFile(path.join(options.outputDir, "topics_raw.json"), JSON.stringify(topics, null, 2), "utf8");
  await fs.writeFile(path.join(options.outputDir, "topics_details_raw.json"), JSON.stringify(details, null, 2), "utf8");
  await fs.writeFile(path.join(options.outputDir, "topics_normalized.json"), JSON.stringify(records, null, 2), "utf8");
  await fs.writeFile(path.join(options.outputDir, "topics_normalized.md"), buildMarkdown(records, "ZSXQ 2020-12 Digests"), "utf8");
  await fs.writeFile(path.join(options.outputDir, "feishu_links.json"), JSON.stringify({ feishuRows }, null, 2), "utf8");
  await fs.writeFile(path.join(options.outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
