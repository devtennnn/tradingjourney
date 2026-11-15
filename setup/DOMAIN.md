# Moving the site to aromx.trade

Vercel already has `aromx.trade` (main) and `www.aromx.trade` (redirects to the main one) on the project `truetradejourney`. The old address
`truetradejourney.vercel.app` keeps working, so nothing breaks while DNS is being set up.

## 1) Cloudflare DNS (Cloudflare → aromx.trade → DNS → Records)
Add these records. Set the proxy to **DNS only (grey cloud)**, otherwise Vercel cannot issue the HTTPS certificate.

| Type  | Name | Content | Proxy |
|-------|------|---------|-------|
| A     | `@` (aromx.trade) | `216.198.79.1` (Vercel's recommended address; `76.76.21.21` also works) | DNS only |
| CNAME | `www` | `f6a1b47521347b68.vercel-dns-017.com` (or `cname.vercel-dns.com`) | DNS only |

Remove any other A / AAAA / CNAME record for `@` or `www` first. Vercel issues the certificate by itself within a few minutes. Check it in
Vercel → Project → Settings → Domains (both should show *Valid Configuration*).

## 2) Supabase (Authentication → URL Configuration)
- **Site URL**: `https://aromx.trade`
- **Redirect URLs**: add `https://aromx.trade/**` and `https://www.aromx.trade/**` (keep the old `https://truetradejourney.vercel.app/**` for now).
Without this, sign-up confirmation, password reset and login links keep pointing at the old address (or are refused).

## 3) Bots (Supabase → Edge Functions → Secrets)
Add the secret `SITE_URL` = `https://aromx.trade` **only after** step 1 works (open https://aromx.trade first). The functions `ai-telegram` and
`news-alerts` then use it for Telegram links and for reading the site's data feeds. Remove the secret to go back to the old address.

## 4) Later
- Update bookmarks, the Telegram channel description and any links you shared.
- When you are happy, the old `truetradejourney.vercel.app` address can stay as a backup or be set to redirect to the new domain in Vercel.
- `api/ai-scan.js` (Vercel) already reads the environment variable `SITE_URL` if you ever use it.
