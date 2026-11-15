# Moving the site to aromx.trade

**aromx.trade is the one and only address.** `www.aromx.trade` and the old `truetradejourney.vercel.app` both redirect (308) to it
(`www` in the Vercel domain settings, the old address by the `redirects` rule in `vercel.json`). Visitors who open the old address land on the new one;
because the browser stores logins per address, they have to sign in once on aromx.trade.

Where the domain is used: `canonical` + Open Graph tags in the three pages, `robots.txt`, `sitemap.xml`, the default `SITE` in the Telegram / push / news
functions and `api/ai-scan.js` (the secret `SITE_URL` still overrides it), the setup docs, and the Supabase Auth URLs.

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
- Telegram: put https://aromx.trade in the channel / bot description (BotFather → Edit Bot → About / Description) and in your profile links.
- Google Search Console: add the property `aromx.trade` (Domain) and submit `https://aromx.trade/sitemap.xml`.
- `api/ai-scan.js` (Vercel) already reads the environment variable `SITE_URL` if you ever use it.
