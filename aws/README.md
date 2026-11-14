# Hosting AROM TRADE on AWS

Layout on AWS:
- **AWS Amplify Hosting** serves the static site (index.html, analysis.html, pricing.html, sw.js, icons…) from this GitHub repo and redeploys on every push. Config: `amplify.yml` (repo root).
- **AWS Lambda** (Node.js 20) serves `/api/candles`, `/api/live`, `/api/quotes`, `/api/news`, `/api/market-news` using the same files in `/api`. Entry: `aws/lambda/index.js`. Build the zip with `bash aws/build-lambda.sh`.
- Amplify rewrites `/api/*` to the Lambda Function URL (`aws/amplify-rewrites.json`), so the site keeps calling `/api/...` with no code change.
- Supabase (database, auth, edge functions, cron, Telegram, push) stays exactly where it is.

Environment variable on the Lambda: `TWELVEDATA_API_KEY` (same value as in Vercel). Region suggestion: ap-southeast-1 (Singapore), closest to Cambodia.

After the AWS site works: add the new domain to Supabase → Authentication → URL Configuration, and change `SITE` in the
Supabase edge functions `ai-telegram` and `push-send` (they read candles/news from the site) if Vercel is switched off.
