import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const latestPath = path.join(ROOT, "public", "data", "latest.json");
const pushStatePath = path.join(ROOT, "public", "data", "push-state.json");

loadDotEnv();

if (!existsSync(latestPath)) {
  throw new Error("还没有生成日报。请先运行 node scripts/generate-daily.js");
}

const report = JSON.parse(await readFile(latestPath, "utf8"));
await pushWechat(report);

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
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

async function pushWechat(report) {
  const forcePush = ["1", "true", "yes"].includes(String(process.env.FORCE_PUSH || "").toLowerCase());
  const pushState = await readPushState();
  if (!forcePush && pushState.lastPushedDate === report.date) {
    console.log(`Report ${report.date} was already pushed at ${pushState.lastPushedAt}; skipping Pushplus.`);
    return;
  }

  const token = process.env.PUSHPLUS_TOKEN;
  if (!token) {
    throw new Error("PUSHPLUS_TOKEN 为空。请在 .env 或 GitHub Secrets 中配置。");
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

  const response = await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Pushplus ${response.status}: ${text.slice(0, 200)}`);
  const payload = assertPushplusAccepted(text);
  await writePushState(report, payload);
}

async function readPushState() {
  if (!existsSync(pushStatePath)) return {};
  try {
    return JSON.parse(await readFile(pushStatePath, "utf8"));
  } catch {
    return {};
  }
}

async function writePushState(report, payload) {
  const state = {
    lastPushedDate: report.date,
    lastPushedDisplayDate: report.displayDate,
    lastPushedAt: new Date().toISOString(),
    lastPushplusCode: payload.code ?? null,
    lastPushplusMessage: payload.msg ?? null
  };
  await writeFile(pushStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(`Recorded WeChat push state for ${report.date}.`);
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
    return payload;
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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
