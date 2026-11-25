// @ts-nocheck
// Supabase Edge Function: newswire (public, GET). Feeds the "Hot news | Live newswire" panel on /news.
// Source: the investinglive.com breaking-news RSS (formerly ForexLive). Only headline, time, category and a link back to the article are
// shown, with the source named. Khmer: headlines are translated once by a language model (OpenRouter, JURY_API_KEY / JURY_BASE_URL) and
// stored in public.news_tr; when the model is unavailable the English headline is shown. Visitors cannot send text to translate: only
// headlines this function read from the feed itself are translated.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const env = (k, d = "") => Deno.env.get(k) ?? d;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const FEED = "https://investinglive.com/feed/news/";
const BASE = env("JURY_BASE_URL", "https://ai-gateway.vercel.sh/v1").replace(/\/$/, ""), KEY = env("JURY_API_KEY").trim();
const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// "MOVER": headlines that usually move gold, the dollar, indices or oil
const MOVER = /\b(gold|xau|fed|fomc|powell|rate (cut|hike|decision)|cpi|inflation|pce|non-?farm|nfp|payrolls|jobless|gdp|tariff|sanction|war|attack|strike|missile|ceasefire|opec|oil|crude|treasury|yields?|ecb|boj|boe|pboc|intervention|recession|default|emergency|breaking)\b/i;

const decode = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&#8216;/g, "'")
  .replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, "-").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ""; };
async function hash(s) { const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)); return Array.from(new Uint8Array(b)).slice(0, 10).map((x) => x.toString(16).padStart(2, "0")).join(""); }

let cache = { at: 0, items: [] };   // per warm instance: the feed is read at most once a minute
async function readFeed() {
  if (Date.now() - cache.at < 60_000 && cache.items.length) return cache.items;
  const r = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0 (compatible; arom-trade/1.0)", Accept: "application/rss+xml, application/xml" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("feed " + r.status);
  const xml = await r.text(), out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1], title = tag(x, "title").slice(0, 300), link = tag(x, "link"), t = Date.parse(tag(x, "pubDate"));
    if (!title || !/^https:\/\/investinglive\.com\//.test(link) || !isFinite(t)) continue;
    out.push({ id: await hash(title), title, link, t, cat: tag(x, "category").slice(0, 40), mover: MOVER.test(title) });
    if (out.length >= 40) break;
  }
  cache = { at: Date.now(), items: out };
  return out;
}

async function translate(items) {
  const ids = items.map((i) => i.id), have = new Map();
  const { data } = await db.from("news_tr").select("id,km").in("id", ids);
  (data || []).forEach((r) => have.set(r.id, r.km));
  const miss = items.filter((i) => !have.has(i.id) || !have.get(i.id)).slice(0, 25);
  if (miss.length && KEY) {
    try {
      const r = await fetch(BASE + "/chat/completions", { method: "POST", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 2500, reasoning: { effort: "none" }, messages: [
          { role: "system", content: "Translate financial news headlines into natural Khmer for traders. Keep tickers, currency codes, numbers, names of people, central banks and indicators (CPI, GDP, PMI, Fed, ECB, FOMC, NFP) in English. Answer with ONE JSON object {\"t\":[...]} holding the translations in the same order and nothing else." },
          { role: "user", content: JSON.stringify(miss.map((i) => i.title)) }] }) });
      const j = await r.json().catch(() => null), txt = j?.choices?.[0]?.message?.content || "", mm = String(txt).match(/\{[\s\S]*\}/);
      const arr = mm ? JSON.parse(mm[0]).t : null;
      if (Array.isArray(arr) && arr.length === miss.length) {
        const rows = miss.map((i, k) => ({ id: i.id, en: i.title, km: String(arr[k] || "").slice(0, 400) || null }));
        await db.from("news_tr").upsert(rows, { onConflict: "id" });
        rows.forEach((x) => have.set(x.id, x.km));
      } else console.error("newswire: translation unusable", r.status);
    } catch (e) { console.error("newswire: translation failed", String(e?.message || e)); }
  }
  return items.map((i) => ({ ...i, km: have.get(i.id) || null }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const lang = new URL(req.url).searchParams.get("lang") === "km" ? "km" : "en";
    let items = await readFeed();
    if (lang === "km") items = await translate(items);
    return new Response(JSON.stringify({ ok: true, source: "investinglive.com", items }), { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  } catch (e) {
    console.error("newswire error", String(e?.message || e));
    return new Response(JSON.stringify({ ok: false, error: "feed" }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
