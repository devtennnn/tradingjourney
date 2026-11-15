# KHQR payments: setup (own QR + Bakong check)

Flow: the buyer picks Premium or Elite (optional promo code) → the `khqr` function builds a dynamic KHQR for your Bakong account and stores the
payment (MD5 of the QR) → the site shows the QR with a countdown and asks `khqr` to check every 2–3 s → `khqr` calls Bakong
`/v1/check_transaction_by_md5`; when the amount, currency and receiving account match, the plan is extended 30 days, once.

## 1) Database (Supabase → SQL Editor, run in this order)
1. `supabase/sql/khqr-payments.sql`  (payments table, audit trigger, admin overview/users with revenue)
2. `supabase/sql/khqr-manual-confirmation.sql`  ("I paid" claim + admin approve / reject)
3. `supabase/sql/promo-codes.sql`  (promo functions; the 4 existing codes stay)

## 2) Secrets (Supabase → Edge Functions → Secrets). Never paste them in chat.
- `BAKONG_EMAIL` = the email registered with Bakong Open API. The function renews the token by itself (`/v1/renew_token`).
- `BAKONG_TOKEN` (optional) = a starting token; with `BAKONG_EMAIL` set it is renewed when expired.
- `BAKONG_ACCOUNT_ID` / `BAKONG_ACCOUNT_TYPE` / `BAKONG_MERCHANT_ID` / `BAKONG_ACQUIRING_BANK` / `MERCHANT_NAME` / `MERCHANT_CITY`: your receiving account
  (defaults in the function are the previous values; override all that differ).
- `BAKONG_API_URL` (optional): `https://sit-api-bakong.nbc.gov.kh` to test, or a Cambodian relay URL; `BAKONG_RELAY_KEY` for that relay.

## 3) Bakong only answers from Cambodia
From Supabase's servers the check returns an empty 403 ("geo_blocked"). Until a Cambodian relay is set as `BAKONG_API_URL`, a buyer who paid taps
"I've paid" and you approve it in Admin → Activations (the badge shows waiting claims). Admin → Activations → Check bank connection tells which case you are in.

## Automatic confirmation with Anajak Pay (no Cambodian server needed)
Set two more secrets and the site switches from our own KHQR to Anajak's hosted checkout; see `setup/anajakpay/README.md`.
- `ANAJAK_SECRET` = the profile's Payment Secret, `ANAJAK_PROFILE_ID` = the profile id (the id at the end of the checkout URL).
- Optional safety net: `ANAJAK_TOKEN` (scope `transactions.read` only).
Functions: `khqr` (JWT required) and `khqr-webhook` (JWT verification OFF, the gateway calls it). Both are deployed.
In Anajak's dashboard leave the webhook URL empty (the checkout URL carries it) or set it to `https://<project>.supabase.co/functions/v1/khqr-webhook`.
Remove the two secrets to go back to our own KHQR + admin approval. Then: Admin → Activations → Check bank connection, and make a 0.01 test payment.
