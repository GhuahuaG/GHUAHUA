import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CONFIG_PATH = path.join(ROOT, "config", "sources.json");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const REPORT_DIR = path.join(DATA_DIR, "reports");

const REGION_LABELS = {
  global: "全球新闻",
  china: "中国新闻"
};

loadDotEnv();

const args = new Set(process.argv.slice(2));
const shouldPush = args.has("--push");

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const today = getZonedDate(process.env.TZ || config.settings.timeZone || "Asia/Shanghai");
const maxArticles = Number(process.env.MAX_ARTICLES || config.settings.maxArticles || 36);
const perCategoryLimit = Number(process.env.PER_CATEGORY_LIMIT || config.settings.perCategoryLimit || 4);
const minScore = Number(process.env.MIN_SCORE || 34);
const gdeltTimespan = process.env.GDelt_TIMESPAN || process.env.GDELT_TIMESPAN || "24h";
const gdeltQueryDelayMs = Number(process.env.GDELT_QUERY_DELAY_MS || 4200);

await mkdir(REPORT_DIR, { recursive: true });

const collected = [];
const errors = [];

for (const query of config.gdeltQueries || []) {
  try {
    const articles = await fetchGdelt(query, gdeltTimespan);
    collected.push(...articles);
  } catch (error) {
    errors.push(`GDELT ${query.region}/${query.topic}: ${error.message}`);
  }
  await delay(gdeltQueryDelayMs);
}

for (const feed of config.rssFeeds || []) {
  try {
    const articles = await fetchRss(feed);
    collected.push(...articles);
  } catch (error) {
    errors.push(`RSS ${feed.name}: ${error.message}`);
  }
}

const prepared = dedupeArticles(collected)
  .map((article) => normalizeArticle(article, config))
  .filter((article) => isTopicRelevant(article, config))
  .filter((article) => isRecentEnough(article, today, 42))
  .filter((article) => article.title && article.url)
  .map((article) => scoreArticle(article, config))
  .filter((article) => article.score >= minScore)
  .sort((a, b) => b.score - a.score);

const selected = selectArticles(prepared, maxArticles, perCategoryLimit);
await enrichWithLlm(selected, config);

const report = buildReport(selected, prepared, today, errors, config);
await writeReport(report);

if (shouldPush) {
  await pushWechat(report);
}

console.log(JSON.stringify({
  date: report.date,
  collected: collected.length,
  afterDedupe: prepared.length,
  selected: selected.length,
  pushed: shouldPush && Boolean(process.env.PUSHPLUS_TOKEN),
  errors
}, null, 2));

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSyncSafe(envPath);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function readFileSyncSafe(file) {
  return readFileSync(file, "utf8");
}

function getZonedDate(timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const zhDate = `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日`;
  return {
    date,
    displayDate: zhDate,
    timeZone,
    generatedAt: now.toISOString()
  };
}

async function fetchGdelt(queryConfig, timespan) {
  const endpoint = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  endpoint.searchParams.set("query", queryConfig.query);
  endpoint.searchParams.set("mode", "ArtList");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("timespan", timespan);
  endpoint.searchParams.set("maxrecords", "50");
  endpoint.searchParams.set("sort", "HybridRel");

  const json = await fetchJson(endpoint.toString());
  const articles = Array.isArray(json.articles) ? json.articles : [];

  return articles.map((item) => ({
    id: makeId(item.url || item.title || ""),
    title: cleanText(item.title || ""),
    url: item.url,
    source: cleanText(item.domain || item.source || "GDELT"),
    domain: normalizeDomain(item.domain || item.url || ""),
    publishedAt: parseGdeltDate(item.seendate || item.date || item.datetime),
    snippet: cleanText(item.snippet || item.socialimage || ""),
    image: item.socialimage || "",
    topic: queryConfig.topic,
    region: queryConfig.region,
    origin: "gdelt",
    language: item.language || "",
    raw: item
  }));
}

async function fetchRss(feed) {
  const text = await fetchText(feed.url);
  const entries = parseFeed(text);
  return entries.map((item) => {
    const topics = classifyTopics(`${item.title} ${item.description}`, feed.topics || []);
    return {
      id: makeId(item.link || item.title || ""),
      title: cleanText(item.title || ""),
      url: item.link,
      source: feed.name,
      domain: normalizeDomain(item.link || feed.url),
      publishedAt: parseDate(item.pubDate || item.published || item.updated),
      snippet: cleanText(stripHtml(item.description || item.summary || "")),
      image: item.image || "",
      topic: topics[0] || feed.topics?.[0] || "semiconductor",
      region: feed.region || "global",
      origin: "rss",
      language: "",
      raw: item
    };
  });

  function classifyTopics(text, allowedTopics) {
    const matched = [];
    for (const topic of allowedTopics) {
      const keywords = config.topics?.[topic]?.keywords || [];
      if (keywords.some((keyword) => containsTerm(text, keyword))) {
        matched.push(topic);
      }
    }
    return matched.length ? matched : allowedTopics;
  }
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, { headers: { "user-agent": userAgent() } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    const text = await response.text();
    throw new Error(trimText(text, 160) || "non-JSON response");
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetchWithRetry(url, { headers: { "user-agent": userAgent() } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastResponse;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (![429, 500, 502, 503, 504].includes(response.status)) return response;
      lastResponse = response;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await delay(retryAfter ? retryAfter * 1000 : 1800 * attempt);
    } catch (error) {
      lastError = error;
      await delay(1000 * attempt);
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error("fetch failed");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function userAgent() {
  return "AIIndustryNewsAssistant/0.1 (+https://example.com)";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFeed(xml) {
  const itemBlocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const entryBlocks = itemBlocks.length ? [] : [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks;

  return blocks.map((block) => {
    const linkText = readTag(block, "link");
    const href = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
    const image = block.match(/<media:content\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1]
      || block.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1]
      || "";

    return {
      title: decodeXml(readTag(block, "title")),
      link: decodeXml(href || linkText),
      pubDate: decodeXml(readTag(block, "pubDate")),
      published: decodeXml(readTag(block, "published")),
      updated: decodeXml(readTag(block, "updated")),
      description: decodeXml(readTag(block, "description") || readTag(block, "summary") || readTag(block, "content:encoded")),
      image
    };
  });
}

function readTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeXml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeArticles(articles) {
  const byKey = new Map();
  for (const article of articles) {
    const key = canonicalUrl(article.url) || titleFingerprint(article.title);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...article, mentions: 1, mergedSources: [article.source].filter(Boolean) });
      continue;
    }
    current.mentions += 1;
    if (article.source && !current.mergedSources.includes(article.source)) current.mergedSources.push(article.source);
    if (!current.snippet && article.snippet) current.snippet = article.snippet;
    if (!current.image && article.image) current.image = article.image;
    if (new Date(article.publishedAt || 0) > new Date(current.publishedAt || 0)) {
      current.publishedAt = article.publishedAt;
    }
  }
  return [...byKey.values()];
}

function normalizeArticle(article, fullConfig) {
  const text = `${article.title} ${article.snippet} ${article.source}`.toLowerCase();
  const topic = chooseTopic(article.topic, text, fullConfig);
  const region = chooseRegion(article.region, text, article.domain);

  return {
    ...article,
    id: makeId(article.url || article.title),
    topic,
    topicLabel: fullConfig.topics?.[topic]?.label || topic,
    region,
    regionLabel: REGION_LABELS[region] || region,
    source: article.source || article.domain || "Unknown",
    domain: article.domain || normalizeDomain(article.url),
    publishedAt: article.publishedAt || new Date().toISOString(),
    snippet: trimText(article.snippet || "", 420),
    mentions: article.mentions || 1,
    mergedSources: article.mergedSources || [article.source].filter(Boolean)
  };
}

function chooseTopic(explicitTopic, text, fullConfig) {
  const scores = {};
  for (const [topic, def] of Object.entries(fullConfig.topics || {})) {
    scores[topic] = 0;
    for (const keyword of def.keywords || []) {
      if (containsTerm(text, keyword)) scores[topic] += keyword.length > 4 ? 2 : 1;
    }
  }
  if (explicitTopic) scores[explicitTopic] = (scores[explicitTopic] || 0) + 3;
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] || explicitTopic || "semiconductor";
}

function chooseRegion(explicitRegion, text, domain = "") {
  const chinaSignals = [
    "china", "chinese", "beijing", "shanghai", "shenzhen", "hong kong",
    "huawei", "smic", "hua hong", "alibaba", "tencent", "baidu", "bytedance",
    "a-share", "a股", "mainland", "domestic chip",
    "中国", "国内", "国产", "我国", "北京", "上海", "深圳", "香港", "华为", "中芯国际", "华虹", "阿里", "腾讯", "百度", "字节"
  ];
  if (chinaSignals.some((signal) => containsTerm(text, signal))) return "china";
  return explicitRegion === "china" ? "global" : explicitRegion || "global";
}

function isTopicRelevant(article, fullConfig) {
  const text = `${article.title} ${article.snippet} ${article.source} ${article.domain}`;
  const topicKeywords = fullConfig.topics?.[article.topic]?.keywords || [];
  const hasTopicHit = topicKeywords.some((keyword) => containsTerm(text, keyword));
  if (!hasTopicHit) return false;

  if (article.topic !== "rf") return true;

  const rfCore = [
    "RF front-end", "RFFE", "radio frequency chip", "power amplifier", "PA module",
    "filter", "SAW", "BAW", "GaN", "SiGe", "mmWave", "5G", "6G",
    "Qorvo", "Skyworks", "Broadcom", "Qualcomm", "Murata", "Maxscend", "Vanchip",
    "satellite communications", "satcom", "satellite internet", "phased array", "T/R module",
    "microwave module", "space RF",
    "射频前端", "射频芯片", "功率放大器", "滤波器", "氮化镓", "毫米波",
    "卫星通信", "卫星互联网", "低轨卫星", "商业航天", "相控阵", "T/R组件", "TR组件",
    "微波组件", "射频组件", "射频微波", "星载", "天线", "雷达",
    "卓胜微", "唯捷创芯", "慧智微", "昂瑞微", "时代速信"
  ];
  const chipContext = [
    "chip", "semiconductor", "module", "wafer", "foundry", "device", "component",
    "芯片", "半导体", "模组", "器件", "晶圆", "前端", "组件", "核心组件", "模块"
  ];
  const eventOnly = ["conference", "webinar", "workshop", "course", "summit", "expo", "研讨会", "峰会", "课程", "展会"];
  const hasRfCore = rfCore.some((keyword) => containsTerm(text, keyword));
  const hasChipContext = chipContext.some((keyword) => containsTerm(text, keyword));
  const isEvent = eventOnly.some((keyword) => containsTerm(text, keyword));

  if (isEvent && !hasChipContext) return false;
  return hasRfCore && (hasChipContext || !isEvent);
}

function isRecentEnough(article, day, hours) {
  const published = new Date(article.publishedAt);
  if (Number.isNaN(published.getTime())) return true;
  const ageHours = (Date.now() - published.getTime()) / 36e5;
  return ageHours <= hours || article.publishedAt.startsWith(day.date);
}

function scoreArticle(article, fullConfig) {
  const text = `${article.title} ${article.snippet} ${article.source} ${article.domain}`.toLowerCase();
  let score = 12;
  const reasons = [];

  if (article.origin === "rss") {
    score += 4;
    reasons.push("来自订阅源，来源可追踪");
  }
  if ((article.mentions || 1) > 1) {
    score += Math.min(12, article.mentions * 3);
    reasons.push("多源出现，事件关注度上升");
  }

  if ((fullConfig.authorityDomains || []).some((domain) => article.domain.includes(domain))) {
    score += 14;
    reasons.push("权威或产业核心来源");
  }

  const matchedEntities = unique((fullConfig.majorEntities || []).filter((entity) => containsTerm(text, entity)));
  if (matchedEntities.length) {
    score += Math.min(20, matchedEntities.length * 7);
    reasons.push(`涉及关键公司：${matchedEntities.slice(0, 4).join("、")}`);
  }

  for (const [group, words] of Object.entries(fullConfig.importanceSignals || {})) {
    const hits = words.filter((word) => containsTerm(text, word));
    if (!hits.length) continue;
    const weight = { policy: 22, capital: 16, operations: 15, technology: 13 }[group] || 10;
    score += Math.min(weight, 6 + hits.length * 3);
    reasons.push(signalLabel(group, hits));
  }

  if (article.topic === "rf") {
    score += 4;
    reasons.push("射频赛道信息稀缺，值得保留");
  }

  const ageHours = (Date.now() - new Date(article.publishedAt).getTime()) / 36e5;
  if (!Number.isNaN(ageHours) && ageHours <= 12) {
    score += 5;
    reasons.push("发布时间较新");
  }

  const recommendation = score >= 70 ? "必读"
    : score >= 52 ? "建议完整阅读"
    : score >= 36 ? "重点扫读"
    : "备查";

  return {
    ...article,
    score,
    scoreReasons: unique(reasons).slice(0, 5),
    recommendation,
    keyFacts: fallbackKeyFacts(article),
    summary: fallbackSummary(article),
    impact: fallbackImpact(article),
    whyRead: fallbackWhyRead(article, score, reasons),
    credibility: credibility(article)
  };
}

function signalLabel(group, hits) {
  const labels = {
    policy: "涉及政策/监管/出口管制变量",
    capital: "涉及融资、并购或资本开支",
    operations: "涉及财报、订单、产能或供应链",
    technology: "涉及技术发布、量产或路线图"
  };
  return `${labels[group] || "出现重要信号"}：${hits.slice(0, 3).join("、")}`;
}

function fallbackKeyFacts(article) {
  const facts = [];
  facts.push(`来源：${article.source}`);
  if (article.publishedAt) facts.push(`时间：${formatDateTime(article.publishedAt)}`);
  if (article.topicLabel) facts.push(`主题：${article.topicLabel}`);
  if (article.snippet) facts.push(trimText(article.snippet, 120));
  return facts.slice(0, 4);
}

function fallbackSummary(article) {
  if (article.snippet) {
    return trimText(article.snippet, 260);
  }
  return "该新闻标题命中了产业关键词，但公开摘要有限。建议结合原文确认事件细节、涉及主体与后续影响。";
}

function fallbackImpact(article) {
  const topicImpact = {
    ai: "关注其对算力需求、模型商业化、数据中心建设、AI应用落地和监管环境的影响。",
    semiconductor: "关注其对先进制程、存储、晶圆代工、设备材料、封装测试和供应链议价的影响。",
    rf: "关注其对手机射频前端、PA/滤波器、5G/6G、车载通信和国产替代节奏的影响。"
  };
  return topicImpact[article.topic] || "关注其对产业链供需、竞争格局和资本预期的影响。";
}

function fallbackWhyRead(article, score, reasons) {
  if (score >= 72) return `这条新闻同时具备高产业相关性和重要信号，${reasons[0] || "可能影响产业判断"}，值得完整阅读原文。`;
  if (score >= 56) return `这条新闻可能影响短期产业预期，${reasons[0] || "建议看原文确认细节"}。`;
  if (score >= 40) return "适合快速扫读，确认是否与关注公司或细分赛道相关。";
  return "信息价值偏背景，可作为后续检索线索。";
}

function credibility(article) {
  if (article.origin === "rss" && article.domain) return "较高：来自固定订阅源，仍建议以原文为准。";
  if (article.domain?.includes("reuters.com") || article.domain?.includes("bloomberg.com")) return "较高：主流媒体报道。";
  if (article.origin === "gdelt") return "中等：来自新闻索引，需要点开原文确认完整上下文。";
  return "中等：建议交叉验证。";
}

function selectArticles(articles, maxCount, perTopicCount) {
  const chosen = new Map();
  for (const region of ["global", "china"]) {
    for (const topic of ["ai", "semiconductor", "rf"]) {
      const group = articles
        .filter((article) => article.region === region && article.topic === topic)
        .slice(0, perTopicCount);
      for (const article of group) chosen.set(article.id, article);
    }
  }
  for (const article of articles) {
    if (chosen.size >= maxCount) break;
    chosen.set(article.id, article);
  }
  return [...chosen.values()].sort((a, b) => b.score - a.score);
}

async function enrichWithLlm(articles, fullConfig) {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || !articles.length) return;

  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const payloadArticles = articles.slice(0, 24).map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source,
    publishedAt: article.publishedAt,
    topic: article.topicLabel,
    region: article.regionLabel,
    snippet: article.snippet,
    scoreReasons: article.scoreReasons,
    url: article.url
  }));

  const prompt = [
    "你是AI、半导体、射频芯片产业情报分析师。",
    "基于给出的新闻元数据，提取重要内容并判断是否值得完整阅读。",
    "不要编造未提供的事实；不确定时写需要原文确认。",
    "输出严格JSON数组，每项包含：id, keyFacts(数组3-5条), summary(80-160字), impact(40-100字), whyRead(30-80字), credibility。",
    "不要全文转载新闻。"
  ].join("\n");

  try {
    const response = await fetchJsonLlm(`${baseUrl}/chat/completions`, {
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(payloadArticles, null, 2) }
      ]
    }, apiKey);

    const text = response.choices?.[0]?.message?.content || "";
    const enriched = JSON.parse(extractJson(text));
    const byId = new Map(enriched.map((item) => [item.id, item]));
    for (const article of articles) {
      const item = byId.get(article.id);
      if (!item) continue;
      article.keyFacts = Array.isArray(item.keyFacts) ? item.keyFacts.slice(0, 5) : article.keyFacts;
      article.summary = item.summary || article.summary;
      article.impact = item.impact || article.impact;
      article.whyRead = item.whyRead || article.whyRead;
      article.credibility = item.credibility || article.credibility;
    }
  } catch (error) {
    console.warn(`LLM enrichment skipped: ${error.message}`);
  }
}

async function fetchJsonLlm(url, body, apiKey) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  }, 60000);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function buildReport(selected, allArticles, day, errors, fullConfig) {
  const recommended = selected
    .filter((article) => article.score >= 52)
    .slice(0, 10)
    .map((article) => ({
      id: article.id,
      title: article.title,
      source: article.source,
      url: article.url,
      score: article.score,
      recommendation: article.recommendation,
      reason: article.whyRead
    }));

  const highlights = selected.slice(0, 8).map((article) => ({
    id: article.id,
    title: article.title,
    source: article.source,
    reason: article.scoreReasons[0] || article.whyRead,
    score: article.score
  }));

  return {
    date: day.date,
    displayDate: day.displayDate,
    timeZone: day.timeZone,
    generatedAt: day.generatedAt,
    siteUrl: process.env.SITE_URL || "",
    stats: {
      selected: selected.length,
      candidates: allArticles.length,
      errors
    },
    topics: fullConfig.topics,
    todayHighlights: highlights,
    recommendedReads: recommended,
    sections: buildSections(selected),
    tomorrowWatch: buildTomorrowWatch(selected),
    articles: selected
  };
}

function buildSections(articles) {
  const sections = {};
  for (const region of ["global", "china"]) {
    sections[region] = { label: REGION_LABELS[region], topics: {} };
    for (const topic of ["ai", "semiconductor", "rf"]) {
      const list = articles.filter((article) => article.region === region && article.topic === topic);
      sections[region].topics[topic] = {
        label: config.topics?.[topic]?.label || topic,
        articles: list
      };
    }
  }
  return sections;
}

function buildTomorrowWatch(articles) {
  const watch = [];
  const entityCounts = new Map();
  for (const article of articles) {
    for (const reason of article.scoreReasons || []) {
      const match = reason.match(/涉及关键公司：(.+)/);
      if (!match) continue;
      for (const entity of match[1].split("、")) {
        entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
      }
    }
  }
  for (const [entity] of [...entityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    watch.push(`继续跟踪 ${entity} 相关后续报道、公告和供应链反馈。`);
  }
  if (articles.some((article) => article.scoreReasons?.some((reason) => reason.includes("政策") || reason.includes("出口管制")))) {
    watch.push("关注出口管制、监管审查和补贴政策是否出现后续细则。");
  }
  if (articles.some((article) => article.topic === "rf")) {
    watch.push("射频芯片新闻较分散，重点看PA、滤波器、GaN与手机链订单变化。");
  }
  if (!watch.length) watch.push("明日继续观察AI算力、半导体供应链和射频前端订单变化。");
  return unique(watch).slice(0, 6);
}

async function writeReport(report) {
  const reportJson = path.join(REPORT_DIR, `${report.date}.json`);
  await writeFile(reportJson, JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(report, null, 2), "utf8");

  const indexPath = path.join(DATA_DIR, "index.json");
  const existing = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, "utf8")) : [];
  const next = [
    { date: report.date, displayDate: report.displayDate, generatedAt: report.generatedAt, count: report.articles.length },
    ...existing.filter((item) => item.date !== report.date)
  ].slice(0, 90);
  await writeFile(indexPath, JSON.stringify(next, null, 2), "utf8");
}

async function pushWechat(report) {
  const token = process.env.PUSHPLUS_TOKEN;
  if (!token) {
    console.log("PUSHPLUS_TOKEN is empty, skip push.");
    return;
  }

  const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
  const reportUrl = siteUrl ? `${siteUrl}/?date=${report.date}` : "";
  const content = buildPushContent(report, reportUrl);
  const body = {
    token,
    title: `产业新闻助手日报 ${report.displayDate}`,
    content,
    template: "html",
    channel: process.env.PUSHPLUS_CHANNEL || "wechat"
  };
  if (process.env.PUSHPLUS_TOPIC) body.topic = process.env.PUSHPLUS_TOPIC;

  const response = await fetchWithTimeout("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, 30000);
  const text = await response.text();
  if (!response.ok) throw new Error(`Pushplus ${response.status}: ${text.slice(0, 200)}`);
  assertPushplusAccepted(text);
}

function assertPushplusAccepted(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Pushplus returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (payload.code === 200 || payload.code === 0) {
    console.log(`Pushplus accepted message: ${payload.msg || "ok"}`);
    return;
  }

  throw new Error(`Pushplus rejected message: code ${payload.code}, ${payload.msg || "no message"}`);
}

function buildPushContent(report, reportUrl) {
  const highlights = report.todayHighlights.slice(0, 6)
    .map((item, index) => `<li><strong>${index + 1}. ${escapeHtml(item.title)}</strong><br><span>${escapeHtml(item.reason || "")}</span></li>`)
    .join("");
  const recommended = report.recommendedReads.slice(0, 5)
    .map((item) => {
      const href = reportUrl ? `${reportUrl}#article-${item.id}` : item.url;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(item.title)}</a><br><span>${escapeHtml(item.reason || "")}</span></li>`;
    })
    .join("");

  return [
    `<h2>产业新闻助手日报 ${escapeHtml(report.displayDate)}</h2>`,
    reportUrl ? `<p><a href="${escapeHtml(reportUrl)}">打开完整日报页面</a></p>` : `<p>完整日报已生成。请配置 SITE_URL 后推送可点击入口。</p>`,
    `<h3>今日重点</h3><ol>${highlights || "<li>今日未发现高可信重要新闻。</li>"}</ol>`,
    `<h3>建议完整阅读</h3><ol>${recommended || "<li>今日没有达到完整阅读阈值的新闻。</li>"}</ol>`,
    `<p style="color:#666">说明：微信内优先打开日报页面查看完整摘要、产业影响和阅读判断；原文链接保留在日报页面中。</p>`
  ].join("\n");
}

function makeId(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `n${(hash >>> 0).toString(16)}`;
}

function canonicalUrl(url = "") {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const param of [...parsed.searchParams.keys()]) {
      if (/^(utm_|spm|from|ref|fbclid|gclid)/i.test(param)) parsed.searchParams.delete(param);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function titleFingerprint(title = "") {
  return cleanText(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120);
}

function normalizeDomain(input = "") {
  try {
    const url = input.startsWith("http") ? new URL(input) : new URL(`https://${input}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(input).replace(/^www\./, "").toLowerCase();
  }
}

function parseGdeltDate(value) {
  if (!value) return new Date().toISOString();
  const str = String(value);
  const match = str.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})?Z?$/);
  if (match) {
    const [, y, m, d, hh, mm, ss = "00"] = match;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`).toISOString();
  }
  return parseDate(str);
}

function parseDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: process.env.TZ || "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function cleanText(value = "") {
  return decodeXml(stripHtml(String(value))).replace(/\s+/g, " ").trim();
}

function trimText(value = "", limit = 240) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function containsTerm(text = "", term = "") {
  const haystack = String(text).toLowerCase();
  const needle = String(term).toLowerCase().trim();
  if (!needle) return false;
  const asciiLike = /^[a-z0-9.+#-]+$/i.test(needle);
  if (asciiLike && needle.length <= 3) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, "i").test(String(text));
  }
  return haystack.includes(needle);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
