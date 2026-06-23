const GITHUB_API_VERSION = "2026-03-10";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(triggerDailyNews(env, "cloudflare-cron"));
  },

  async fetch(request, env) {
    if (request.method === "GET") {
      return json({
        ok: true,
        service: "ai-news-morning-trigger",
        schedule: "06:30 Asia/Shanghai",
        manualTrigger: env.TRIGGER_SECRET ? "enabled" : "disabled"
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (!env.TRIGGER_SECRET) {
      return json({ ok: false, error: "Manual trigger is not configured" }, 403);
    }

    const expected = `Bearer ${env.TRIGGER_SECRET}`;
    if (request.headers.get("authorization") !== expected) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    return triggerDailyNews(env, "manual-http");
  }
};

async function triggerDailyNews(env, source) {
  const token = requireEnv(env, "GITHUB_TOKEN");
  const owner = env.GITHUB_OWNER || "GhuahuaG";
  const repo = env.GITHUB_REPO || "GHUAHUA";
  const workflowId = env.GITHUB_WORKFLOW_ID || "daily-news.yml";
  const ref = env.GITHUB_REF || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "ai-news-morning-trigger",
      "x-github-api-version": GITHUB_API_VERSION
    },
    body: JSON.stringify({
      ref,
      inputs: {
        force_push: false
      }
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${text}`);
  }

  console.log(`Triggered ${owner}/${repo}/${workflowId} from ${source}: ${response.status}`);
  return json({
    ok: true,
    source,
    status: response.status,
    workflow: `${owner}/${repo}/${workflowId}`,
    ref
  });
}

function requireEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
