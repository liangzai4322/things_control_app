import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";

const DETAIL_API_URL = "https://scys.com/shengcai-web/client/homePage/topicDetail";

function parseArgs(argv) {
  const options = {
    input: "",
    output: "",
    token: process.env.SCYS_X_TOKEN ?? "",
    concurrency: 6,
    delayMs: 0,
    refererBase: "https://scys.com/articleDetail/xq_topic/",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!current.startsWith("--")) {
      continue;
    }

    switch (current) {
      case "--input":
        options.input = path.resolve(next);
        index += 1;
        break;
      case "--output":
        options.output = path.resolve(next);
        index += 1;
        break;
      case "--token":
        options.token = next;
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = Number(next);
        index += 1;
        break;
      case "--delay-ms":
        options.delayMs = Number(next);
        index += 1;
        break;
      default:
        throw new Error(`Unsupported argument: ${current}`);
    }
  }

  if (!options.input) {
    throw new Error("Missing `--input`.");
  }

  if (!options.output) {
    throw new Error("Missing `--output`.");
  }

  if (!options.token) {
    throw new Error("Missing token. Pass `--token` or set `SCYS_X_TOKEN`.");
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error("`--concurrency` must be a positive integer.");
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("`--delay-ms` must be a non-negative integer.");
  }

  options.concurrency = Math.floor(options.concurrency);
  options.delayMs = Math.floor(options.delayMs);
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function ensureDir(folderPath) {
  await fs.mkdir(folderPath, { recursive: true });
}

function normalizeInputRecords(source) {
  if (Array.isArray(source)) {
    return source;
  }

  if (Array.isArray(source?.data?.topicDetailDTO?.items)) {
    return source.data.topicDetailDTO.items
      .map((item) => ({
        entity_id: String(item?.topicDTO?.entityId ?? item?.topicDTO?.topicId ?? ""),
        detail_url: item?.detailUrl ?? "",
      }))
      .filter((item) => item.entity_id);
  }

  throw new Error("Input JSON must be an array of records or contain data.topicDetailDTO.items.");
}

async function requestTopicDetail(options, entityId, entityType = "xq_topic") {
  const payload = {
    entityType,
    entityId,
  };

  const response = await fetch(DETAIL_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: "https://scys.com",
      referer: `${options.refererBase}${entityId}`,
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
    throw new Error(`Could not parse JSON for entity ${entityId}: ${error}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for entity ${entityId}`);
  }

  if (!json?.success || !json?.data?.topicDTO?.entityId) {
    throw new Error(`Malformed topicDetail payload for entity ${entityId}`);
  }

  return json.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestTopicDetailWithRetry(options, entityId, entityType) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await requestTopicDetail(options, entityId, entityType);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        const message = error instanceof Error ? error.message : String(error);
        const backoff = message.includes("HTTP 429") ? attempt * 3000 : attempt * 500;
        await sleep(backoff);
      }
    }
  }

  throw lastError;
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

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume())
  );

  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await readJson(options.input);
  const inputRecords = normalizeInputRecords(source);
  const uniqueRecords = [];
  const seen = new Set();

  for (const record of inputRecords) {
    const entityId = String(record?.entity_id ?? record?.entityId ?? "").trim();
    if (!entityId || seen.has(entityId)) {
      continue;
    }

    seen.add(entityId);
    uniqueRecords.push({
      entity_id: entityId,
      entity_type: String(record?.entity_type ?? record?.entityType ?? "xq_topic"),
    });
  }

  const hydrated = [];
  const failures = [];

  const results = await runWithConcurrency(uniqueRecords, options.concurrency, async (record, index) => {
    try {
      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }

      const detail = await requestTopicDetailWithRetry(options, record.entity_id, record.entity_type);
      return {
        ok: true,
        index,
        record,
        detail,
      };
    } catch (error) {
      return {
        ok: false,
        index,
        record,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  for (const result of results) {
    if (result.ok) {
      hydrated.push({
        topicDTO: result.detail.topicDTO ?? null,
        topicUserDTO: result.detail.topicUserDTO ?? null,
        topicLikeDTOList: result.detail.topicLikeDTOList ?? null,
        topicCommentDTOList: result.detail.topicCommentDTOList ?? null,
        topicCoinStatDTO: result.detail.topicCoinStatDTO ?? null,
      });
    } else {
      failures.push({
        entity_id: result.record.entity_id,
        entity_type: result.record.entity_type,
        error: result.error,
      });
    }
  }

  const wrapped = {
    data: {
      topicDetailDTO: {
        total: hydrated.length,
        items: hydrated,
      },
    },
  };

  await ensureDir(path.dirname(options.output));
  await fs.writeFile(options.output, JSON.stringify(wrapped, null, 2), "utf8");

  const summaryPath = options.output.replace(/\.json$/i, ".summary.json");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        input_file: options.input,
        output_file: options.output,
        total_requested: uniqueRecords.length,
        success_count: hydrated.length,
        failure_count: failures.length,
        failures,
        generated_at: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        output_file: options.output,
        summary_file: summaryPath,
        total_requested: uniqueRecords.length,
        success_count: hydrated.length,
        failure_count: failures.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
