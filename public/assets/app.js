const state = {
  report: null,
  region: "all",
  topic: "all",
  priority: "all"
};

const els = {
  displayDate: document.querySelector("#display-date"),
  generatedAt: document.querySelector("#generated-at"),
  highlights: document.querySelector("#highlights"),
  recommended: document.querySelector("#recommended"),
  articles: document.querySelector("#articles"),
  articleCount: document.querySelector("#article-count"),
  tomorrow: document.querySelector("#tomorrow"),
  history: document.querySelector("#history"),
  template: document.querySelector("#article-template")
};

init();

async function init() {
  wireFilters();
  await loadHistory();
  const params = new URLSearchParams(location.search);
  await loadReport(params.get("date"));
}

function wireFilters() {
  document.querySelectorAll("[data-filter-region]").forEach((button) => {
    button.addEventListener("click", () => {
      state.region = button.dataset.filterRegion;
      setActive("[data-filter-region]", button);
      renderArticles();
    });
  });

  document.querySelectorAll("[data-filter-topic]").forEach((button) => {
    button.addEventListener("click", () => {
      state.topic = button.dataset.filterTopic;
      setActive("[data-filter-topic]", button);
      renderArticles();
    });
  });

  document.querySelectorAll("[data-filter-priority]").forEach((button) => {
    button.addEventListener("click", () => {
      state.priority = button.dataset.filterPriority;
      setActive("[data-filter-priority]", button);
      renderArticles();
    });
  });
}

function setActive(selector, activeButton) {
  document.querySelectorAll(selector).forEach((button) => button.classList.toggle("active", button === activeButton));
}

async function loadHistory() {
  try {
    const response = await fetch("./data/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error("history missing");
    const history = await response.json();
    els.history.innerHTML = "";
    if (!history.length) {
      els.history.innerHTML = `<div class="empty">暂无历史日报</div>`;
      return;
    }
    for (const item of history.slice(0, 30)) {
      const button = document.createElement("button");
      button.textContent = `${item.displayDate || item.date} · ${item.count || 0}条`;
      button.addEventListener("click", () => {
        const url = new URL(location.href);
        url.searchParams.set("date", item.date);
        window.history.pushState?.(null, "", url);
        loadReport(item.date);
      });
      button.dataset.date = item.date;
      els.history.append(button);
    }
  } catch {
    els.history.innerHTML = `<div class="empty">生成日报后会出现历史列表</div>`;
  }
}

async function loadReport(date) {
  const url = date ? `./data/reports/${date}.json` : "./data/latest.json";
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    els.articles.innerHTML = `<div class="empty">还没有生成日报。请先运行生成任务。</div>`;
    return;
  }
  state.report = await response.json();
  document.querySelectorAll("#history button").forEach((button) => {
    button.classList.toggle("active", button.dataset.date === state.report.date);
  });
  renderReport();
}

function renderReport() {
  const report = state.report;
  els.displayDate.textContent = report.displayDate || report.date;
  els.generatedAt.textContent = report.generatedAt ? `生成于 ${formatDateTime(report.generatedAt)}` : "";

  renderList(els.highlights, report.todayHighlights || [], (item, index) => {
    return `<strong>${index + 1}. ${escapeHtml(item.title)}</strong><span>${escapeHtml(item.reason || "")}</span>`;
  });

  renderList(els.recommended, report.recommendedReads || [], (item, index) => {
    return `<strong>${index + 1}. <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></strong><span>${escapeHtml(item.reason || "")}</span>`;
  });

  renderList(els.tomorrow, report.tomorrowWatch || [], (item) => escapeHtml(item), "ul");
  renderArticles();
}

function renderArticles() {
  const report = state.report;
  if (!report) return;
  const articles = (report.articles || []).filter(matchesFilters);
  els.articleCount.textContent = `当前显示 ${articles.length} 条，候选池 ${report.stats?.candidates || "-"} 条`;
  els.articles.innerHTML = "";

  if (!articles.length && (state.region !== "all" || state.topic !== "all" || state.priority !== "all")) {
    els.articles.innerHTML = `<div class="empty">当前筛选下没有新闻。可以切换主题或优先级。</div>`;
    return;
  }

  const regions = state.region === "all" ? ["global", "china"] : [state.region];
  const topics = state.topic === "all" ? ["ai", "semiconductor", "rf"] : [state.topic];

  for (const region of regions) {
    const regionBlock = document.createElement("section");
    regionBlock.className = "section-block";
    const regionTitle = document.createElement("h3");
    regionTitle.className = "section-title";
    regionTitle.textContent = region === "china" ? "中国新闻" : "全球新闻";
    regionBlock.append(regionTitle);

    for (const topic of topics) {
      const topicArticles = articles.filter((article) => article.region === region && article.topic === topic);
      const group = document.createElement("div");
      group.className = "topic-group";
      const title = document.createElement("div");
      title.className = "topic-title";
      title.textContent = topicLabel(topic);
      group.append(title);

      if (!topicArticles.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "今日未发现高可信重要新闻";
        group.append(empty);
      } else {
        for (const article of topicArticles) {
          group.append(renderArticle(article));
        }
      }
      regionBlock.append(group);
    }

    els.articles.append(regionBlock);
  }
}

function matchesFilters(article) {
  if (state.region !== "all" && article.region !== state.region) return false;
  if (state.topic !== "all" && article.topic !== state.topic) return false;
  if (state.priority === "read" && !["必读", "建议完整阅读"].includes(article.recommendation)) return false;
  if (state.priority === "scan" && !["重点扫读", "必读", "建议完整阅读"].includes(article.recommendation)) return false;
  return true;
}

function renderArticle(article) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".article-card");
  card.dataset.region = article.region;
  card.dataset.topic = article.topic;

  fragment.querySelector(".meta-line").textContent = [
    article.regionLabel,
    article.topicLabel,
    article.source,
    formatDateTime(article.publishedAt),
    `评分 ${article.score}`
  ].filter(Boolean).join(" · ");

  fragment.querySelector("h3").textContent = article.title;
  const priority = fragment.querySelector(".priority");
  priority.textContent = article.recommendation || "备查";
  priority.classList.toggle("hot", article.recommendation === "必读");
  priority.classList.toggle("read", article.recommendation === "建议完整阅读");

  fragment.querySelector(".summary").textContent = article.summary || "";

  const facts = fragment.querySelector(".facts");
  facts.innerHTML = "";
  for (const fact of article.keyFacts || []) {
    const div = document.createElement("div");
    div.className = "fact";
    div.textContent = fact;
    facts.append(div);
  }

  fragment.querySelector(".impact").textContent = article.impact || "";
  fragment.querySelector(".why").textContent = article.whyRead || "";
  fragment.querySelector(".source-link").href = article.url;
  fragment.querySelector(".credibility").textContent = article.credibility || "";
  return fragment;
}

function renderList(container, items, render, tag = "ol") {
  container.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "今日未发现高可信重要新闻";
    container.append(li);
    return;
  }
  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.innerHTML = render(item, index);
    container.append(li);
  });
}

function formatDateTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function topicLabel(topic) {
  return {
    ai: "AI产业",
    semiconductor: "半导体产业",
    rf: "射频芯片产业"
  }[topic] || topic;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}
