# Cloudflare Morning Trigger

This Worker is the external clock for the daily news assistant.

- Target time: 06:30 Asia/Shanghai
- Cloudflare cron time: 22:30 UTC
- Action: trigger `daily-news.yml` through GitHub `workflow_dispatch`

## Deploy

1. Create a GitHub fine-grained personal access token for `GhuahuaG/GHUAHUA`.
   Grant repository permission: `Actions: Read and write`.

2. In PowerShell:

```powershell
cd "C:\Users\HUA\Documents\Codex\2026-06-20\ai\outputs\ai-news-assistant\cloudflare-cron"
npx wrangler@latest login
npx wrangler@latest secret put GITHUB_TOKEN
npx wrangler@latest secret put TRIGGER_SECRET
npx wrangler@latest deploy
```

When `GITHUB_TOKEN` is requested, paste the GitHub token.
When `TRIGGER_SECRET` is requested, paste any long random password.

After deploy, Cloudflare will trigger the GitHub workflow every day at 06:30 Beijing time.

This Worker is not published to a public `workers.dev` URL. It only needs the cron trigger, so `workers_dev = false` avoids the workers.dev subdomain setup prompt.
