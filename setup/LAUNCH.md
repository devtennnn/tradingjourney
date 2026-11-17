# Launch gift: 3 days of Ultra for joining the Telegram channel and community

Members who (1) connect Telegram, (2) join https://t.me/aromxtrade and (3) join https://t.me/aromxtradecommunity can claim 3 days of Ultra once.
The bot checks membership with Telegram itself (`getChatMember`), so it cannot be faked, and one Telegram account can claim only once.

## One-time setup
1. Run `supabase/sql/launch-ultra.sql` in the Supabase SQL Editor (already applied on 17 Nov 2026).
2. Deploy the edge function `launch-claim` with **verify_jwt = false** (`supabase/functions/launch-claim`).
3. **Make the bot an ADMINISTRATOR of both the channel and the community** (Telegram → chat → Administrators → Add admin → pick the bot; no special rights needed).
   Without this Telegram refuses to show the member list, and claims are blocked with "We cannot check Telegram right now".
4. Check it: open `https://<project>.supabase.co/functions/v1/launch-claim?run=diag&key=<ai_bot_config.cron_secret>`. Both chats must show `"bot_is_admin": true` and `"problem": null`.

## Settings (SQL)
```sql
select * from public.launch_promo;
update public.launch_promo set closes_at = '2026-11-30 12:00+00', max_claims = 500;   -- times are UTC; 12:00 UTC = 19:00 Cambodia
update public.launch_promo set enabled = false;                                        -- switch the gift off
```
## Watch
- Every 10 minutes (`arom-launch-watch`) the function re-checks active claims. A member who LEFT the channel or community loses the gift (the plan returns to what it was); a Telegram error never removes a gift.
- Claims: `select * from public.launch_claims order by claimed_at desc;`
