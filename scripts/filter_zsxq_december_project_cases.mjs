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

const keep = new Map([
  [1, "红包封面热点引流，明确涨粉数据和执行路径"],
  [3, "电商项目调研与从0到1案例"],
  [4, "京东店群从0到100操盘案例"],
  [6, "裂变微信群获流量与变现复盘"],
  [7, "红包封面副业变现10w+复盘"],
  [8, "抢茅台/套利型项目实操经验"],
  [9, "知乎好物带货方向与避坑实操"],
  [10, "分销快闪群卖货复盘"],
  [12, "公众号垂直粉引流增长案例"],
  [15, "京东服务商拉新月入20w+案例"],
  [16, "多副业赚钱经验与能力复盘，偏项目方法"],
  [20, "ZYNN短视频平台签约变现案例"],
  [21, "母婴社群搭建与开业成交案例"],
  [22, "B2B英文独立站获询盘案例"],
  [23, "猫舍繁育行业盈利模式拆解"],
  [24, "闲鱼起步并放大营收案例"],
  [25, "微信红包封面副业玩法教程"],
  [29, "高客单价线上减脂训练营操盘案例"],
  [30, "企业微信社群运营自动化实操"],
  [32, "外卖红包返佣项目实操指南"],
  [34, "地摊选品与线下小生意复盘"],
  [35, "美容院高成交销售实操复盘"],
  [37, "海外工具型产品营收案例拆解"],
  [40, "无代码采集数据工具与获客思路"],
  [41, "别墅轰趴馆客群分类与分销案例"],
  [42, "知乎投放300w并回本的投放案例"],
  [43, "奶茶加盟项目避坑案例"],
  [46, "三线城市招聘人才网项目拆解"],
  [48, "淘宝联盟丝路计划项目机会分析"],
  [49, "公众号两个月涨粉百万案例拆解"],
  [51, "淘客返利号与代理提点百万案例"],
  [52, "抖音直播带货中间商项目复盘"],
  [53, "IP/盲盒变现项目机会拆解"],
  [54, "知乎引流转化赚100万案例"],
  [56, "知识类抖音账号运营经验"],
  [57, "国美会员返现截流茅台流量复盘"],
  [58, "知乎好物小白1w+复盘"],
  [60, "猫粮业务月销售额10万案例"],
  [61, "标题生成工具海外变现案例"],
  [65, "闲鱼接地气小项目"],
  [66, "公众号拦截引流玩法拆解"],
  [67, "广告投放项目基础实操"],
  [68, "知识付费项目年入500万复盘"],
  [69, "TikTok虚拟物品变现复盘"],
  [70, "知乎好物0到10000+佣金复盘"],
  [73, "游戏虚拟商业8天五位数案例"],
  [74, "公众号改名排名提升玩法"],
  [75, "抖音达人矩阵签约与变现案例"],
  [76, "实体连锁/社群业务抗风险案例"],
  [77, "普通人寻找赚钱项目的方法"],
  [78, "闲鱼捡漏与卖家赚钱实操"],
  [79, "定制T恤海外案例拆解"],
  [80, "外卖返利项目实操经验"],
  [82, "房产抖音和自媒体低成本创业案例"],
  [83, "房产媒体运营阶段拆解"],
  [85, "训练营游戏化设计与交付案例"],
  [87, "本地周边游盈利项目拆解"],
  [88, "外卖淘客模型与执行复盘"],
  [89, "知乎带货IP启动方法"],
  [90, "本地房产垂直公众号低成本创业项目"],
]);

const excludedReasons = new Map([
  [2, "年度资料/经验合集，不是单一项目案例"],
  [5, "个人/企业年度认知随笔"],
  [11, "同城见面会报名通知"],
  [13, "买房方法论，偏投资认知"],
  [14, "见面会分享复盘，非项目案例"],
  [17, "见面会演讲稿，偏个人品牌方法"],
  [18, "职场与创业经验分享，非具体项目"],
  [19, "夜话官招募通知"],
  [26, "圈友成绩祝贺/故事入口，项目信息不足"],
  [27, "谈判方法论，非项目"],
  [28, "电商/私域/APP认知思考，非案例"],
  [31, "收藏夹产品上线通知"],
  [33, "创业方法论，非项目案例"],
  [36, "战略认知文章"],
  [38, "会员日福利互动"],
  [39, "社交破冰方法，非项目"],
  [44, "港股打新投资攻略，非经营项目"],
  [45, "企业经营踩坑，偏管理复盘"],
  [47, "上海见面会报名通知"],
  [50, "龙珠榜单公告"],
  [55, "股票投资指标，非项目案例"],
  [59, "个人第一桶金故事，项目路径不够明确"],
  [62, "大航海计划报名通知"],
  [63, "认知金句分享"],
  [64, "线下活动链接方法，非项目"],
  [71, "电商人才管理方法，非项目案例"],
  [72, "社群定价认知"],
  [81, "广州见面会参会复盘"],
  [84, "闲钱处置讨论/理财"],
  [86, "北京见面会报名通知"],
]);

function compactRecord(record) {
  return {
    rank: record.rank,
    topic_id: record.topic_id,
    create_time: record.create_time,
    title: record.title,
    author: record.author,
    detail_url: record.detail_url,
    likes_count: record.likes_count,
    comments_count: record.comments_count,
    reading_count: record.reading_count,
    links: record.links,
    needs_external_article:
      record.links.some((url) => url.includes("articles.zsxq.com")) &&
      /点击链接查看剩余内容|发布为文章|移步/u.test(record.text),
    selection_reason: keep.get(record.rank),
    text: record.text,
  };
}

function buildKeptMarkdown(items) {
  const lines = ["# 2020 年 12 月项目案例筛选", "", `保留 ${items.length} 条。`, ""];

  for (const item of items) {
    lines.push(`## ${item.rank}. ${item.title}`);
    lines.push("");
    lines.push(`- 筛选理由: ${item.selection_reason}`);
    lines.push(`- 时间: ${item.create_time}`);
    lines.push(`- 作者: ${item.author}`);
    lines.push(`- Topic ID: ${item.topic_id}`);
    lines.push(`- 链接: ${item.detail_url}`);
    lines.push(`- 数据: ${item.likes_count} 赞 / ${item.comments_count} 评论 / ${item.reading_count} 阅读`);
    if (item.links.length > 0) {
      lines.push(`- 外链: ${item.links.join(" ; ")}`);
    }
    if (item.needs_external_article) {
      lines.push("- 备注: 原帖含 articles.zsxq.com 长文入口，API 正文可能只含摘要与入口链接。");
    }
    lines.push("");
    lines.push(item.text || "> 正文为空");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function buildExcludedMarkdown(items) {
  const lines = ["# 2020 年 12 月非项目内容剔除记录", "", `剔除 ${items.length} 条。`, ""];

  for (const item of items) {
    lines.push(`- ${item.rank}. ${item.title}`);
    lines.push(`  - 时间: ${item.create_time} | 作者: ${item.author} | Topic ID: ${item.topic_id}`);
    lines.push(`  - 原因: ${item.exclusion_reason}`);
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = JSON.parse(fs.readFileSync(options.input, "utf8"));
  const kept = records.filter((record) => keep.has(record.rank)).map(compactRecord);
  const excluded = records
    .filter((record) => !keep.has(record.rank))
    .map((record) => ({
      rank: record.rank,
      topic_id: record.topic_id,
      create_time: record.create_time,
      title: record.title,
      author: record.author,
      detail_url: record.detail_url,
      exclusion_reason: excludedReasons.get(record.rank) || "非项目案例/项目相关性不足",
    }));

  const summary = {
    source_total: records.length,
    kept_count: kept.length,
    excluded_count: excluded.length,
    kept_topic_ids: kept.map((item) => item.topic_id),
    generated_at: new Date().toISOString(),
    criteria:
      "保留项目案例、实操复盘、赚钱/增长/运营项目拆解；剔除通知、招募、榜单、见面会安排、纯认知/投资/社交/管理类内容。",
  };

  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(path.join(options.outputDir, "filtered_project_cases.json"), JSON.stringify(kept, null, 2), "utf8");
  fs.writeFileSync(path.join(options.outputDir, "filtered_project_cases.md"), buildKeptMarkdown(kept), "utf8");
  fs.writeFileSync(path.join(options.outputDir, "excluded_non_project.json"), JSON.stringify(excluded, null, 2), "utf8");
  fs.writeFileSync(path.join(options.outputDir, "excluded_non_project.md"), buildExcludedMarkdown(excluded), "utf8");
  fs.writeFileSync(path.join(options.outputDir, "filter_summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main();
