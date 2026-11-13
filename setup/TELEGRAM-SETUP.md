# AROM TRADE · AI Signal → Telegram channel

The bot runs the same A+ scalping engine as the AI Desk on the server, every 5 minutes.
When the latest closed M5 candle is A+, it posts Entry / SL / TP1–TP3 to your channel,
then replies under that post when TP1, TP2, TP3, SL or expiry happens.

You need about 15 minutes. No command line needed.

## 1. Create the bot (Telegram app)
1. Open **@BotFather** → send `/newbot` → choose a name (e.g. *AROM TRADE AI*) and a username ending in `bot`.
2. BotFather replies with a **token** like `123456789:AA…`. Keep it secret — don't paste it in chats.

## 2. Connect the bot to your channel
1. Create a channel (or open your existing one).
2. Channel → **Administrators → Add admin** → search your bot → allow **Post messages** → Save.
3. Your **chat ID**:
   - Public channel: `@yourchannelname`
   - Private channel: forward any channel post to **@RawDataBot** (or @userinfobot) and copy the id that starts with `-100…`

## 3. Supabase (database + scheduler)
1. Supabase → **Settings → API** → copy the **Project URL** and the **service_role** key (server only).
2. Supabase → **SQL Editor** → open `ai-telegram-setup.sql`, replace `YOUR_CRON_SECRET` with a long random text
   (e.g. `arom-7Kx2pQ9vL4mZ`), then **Run**.
   This creates the `ai_signals` table and schedules the scan at minute 1, 6, 11 … of every hour.

## 4. Vercel environment variables
Vercel → your project → **Settings → Environment Variables** → add (Production):

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `TELEGRAM_CHAT_ID` | `@yourchannelname` or `-100…` |
| `CRON_SECRET` | the same random text you put in the SQL |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `AI_SYMBOLS` *(optional)* | `XAUUSD` (default) or `XAUUSD,XAGUSD` |
| `TWELVEDATA_API_KEY` *(optional)* | for spot XAU/USD prices instead of COMEX futures |

Then **Deployments → ⋯ → Redeploy** so the new variables load.

## 5. Test
Open in your browser (use your secret):

```
https://truetradejourney.vercel.app/api/ai-scan?key=YOUR_CRON_SECRET&test=1
```

You should see `{"ok":true,…}` and a "🤖 AROM TRADE AI bot connected" post in the channel.
Without `&test=1` the same link runs one real scan and shows the current grade.

## How a signal looks
```
🔴 A+ SELL · XAUUSD (M5 scalp)

Entry: 3943.11
SL:    3949.85
TP1:   3936.37 (1R)
TP2:   3929.64 (2R)
TP3:   3922.90 (3R)

Trigger: Momentum close · Risk 6.74
M15 trend down · checks 11/11 ✅
🕒 12 Nov, 19:14 ICT · valid until 19:29
↪ Move SL to entry after TP1
```
Follow-ups are posted as replies: ✅ TP1 hit · ✅✅ TP2 hit · 🏆 TP3 hit · ❌ SL hit · ⏹ Closed after TP1/TP2 · ⏱ Expired (4 h).

## Notes
- A+ is strict: expect roughly 0–2 signals a day on XAUUSD, only in London / New York hours (14:00–24:00 ICT),
  never within 30 minutes of high-impact USD news, and none at all if the news calendar can't be checked.
- If the price feed fails, nothing is posted (no data = no signal).
- Stop the bot any time in Supabase SQL: `select cron.unschedule('arom-ai-scan');`
- Algorithmic analysis, not financial advice — keep the disclaimer in your channel description too.
