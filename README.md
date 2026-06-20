# 产业新闻助手

这是一个“独立网页 + 微信推送”的每日产业新闻助手，用来追踪：

- AI产业
- 半导体产业
- 射频芯片产业

它每天生成一份适合手机和电脑阅读的日报，并通过 Pushplus 推送到微信。推送里只放今日重点和建议完整阅读的入口，完整内容在网页里看。

## 它会做什么

1. 从 GDELT 新闻索引和 RSS 新闻源收集当天新闻。
2. 按“全球新闻 / 中国新闻”分区。
3. 按“AI产业 / 半导体产业 / 射频芯片产业”归类。
4. 对每条新闻打重要性分数。
5. 提取关键事实、中文摘要、产业影响、可信度提示。
6. 判断哪些新闻值得完整阅读，并说明原因。
7. 低于最低重要性分数的内容不会进入日报，避免用弱相关新闻凑数。
8. 生成网页日报和历史归档。
9. 通过微信推送“今日重点 + 完整日报链接”。

## 重要性判断逻辑

系统不是简单堆新闻，会优先识别这些信号：

- 政策、制裁、出口管制、监管、补贴、关税
- 融资、并购、IPO、资本开支、合资
- 财报、收入指引、重大订单、出货、产能、良率、供应链
- 先进制程、HBM、先进封装、光刻、EDA、量产、流片、路线图
- AI模型、算力、GPU、数据中心、AI芯片
- 射频前端、PA、SAW/BAW滤波器、GaN、毫米波、5G/6G
- 关键公司，例如 NVIDIA、TSMC、ASML、Qualcomm、Broadcom、华为、中芯国际、卓胜微等

分数越高，越可能进入“必读”或“建议完整阅读”。

## 本地使用

复制环境变量模板：

```bash
cp .env.example .env
```

在 `.env` 里填：

```bash
SITE_URL=https://你的网页地址
PUSHPLUS_TOKEN=你的Pushplus token
```

生成日报：

```bash
node scripts/generate-daily.js
```

生成并推送到微信：

```bash
node scripts/generate-daily.js --push
```

本地预览网页：

```bash
node scripts/serve.js
```

然后打开：

```text
http://localhost:4173
```

## 部署建议

推荐用 GitHub Pages 或 Cloudflare Pages 托管 `public` 目录。

如果用 GitHub：

1. 新建一个仓库。
2. 把本项目文件推送到仓库根目录。
3. 在仓库的 Secrets 里配置：
   - `PUSHPLUS_TOKEN`
   - 可选：`PUSHPLUS_TOPIC`
   - 可选：`LLM_API_KEY`
4. 在仓库的 Variables 里配置：
   - `SITE_URL`
   - 可选：`LLM_BASE_URL`
   - 可选：`LLM_MODEL`
5. 启用 GitHub Pages，来源选择 GitHub Actions。

项目里的 `.github/workflows/daily-news.yml` 已经配置了每天北京时间 20:30 运行。

## 微信推送

微信推送使用 Pushplus：

- 接口文档：https://www.pushplus.plus/doc/guide/api.html
- 默认渠道：`wechat`
- 默认模板：`html`

推送内容包括：

- 打开完整日报页面的链接
- 今日重点
- 建议完整阅读
- 简短说明

## 可调新闻源

新闻源在这里：

```text
config/sources.json
```

你可以增删 RSS 源，也可以调整 GDELT 查询词、关键词和重要性信号。

## 可选 AI 增强

如果配置了 `LLM_API_KEY`，系统会调用 OpenAI-compatible Chat Completions 接口，把候选新闻进一步压缩成更像产业分析师写的摘要。

如果不配置，也能运行，只是摘要和判断会使用本地规则。

## 文件结构

```text
config/sources.json            新闻源、关键词、评分信号
scripts/generate-daily.js      抓取、评分、生成日报、可选推送
scripts/push-wechat.js         单独推送最新日报
scripts/serve.js               本地预览服务
public/index.html              阅读网页
public/assets/app.css          样式
public/assets/app.js           前端交互
public/data/latest.json        最新日报
public/data/reports/*.json     历史日报
```
