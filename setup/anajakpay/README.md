# Anajak Pay (KHQRPay) hosted checkout

Why: Bakong refuses calls from outside Cambodia, so our own KHQR could not be confirmed automatically (see `../bakong-relay/`).
Anajak Pay confirms the payment from inside Cambodia and tells our server with a signed webhook, so no relay or VPS is needed.

## How it works
1. The buyer picks a plan. `khqr` (action `create`) saves a pending payment row and returns a **signed checkout URL**
   (`https://anajakpay.com/api/payment/request/<profile>?transaction_id=<our bill>&amount=…&success_url=…&remark=…&hash=…`,
   `hash = sha1(secret + transaction_id + amount + success_url + remark)`).
2. The site shows that page inside the payment window (with an "open in a new tab" link).
3. After payment, Anajak POSTs `{req_time, transaction_id, amount, status, hash}` to `success_url`, which is the `khqr-webhook` function.
   It checks `hash == sha256(secret + req_time + transaction_id + amount + "SUCCESS")`, that the amount covers our price, then marks the row
   paid and adds the plan days once. The open payment window sees the change on its next check and unlocks.
4. Promo codes, the claim/approve fallback and the admin screens are unchanged.

## Turn it on
Supabase → Edge Functions → Secrets:
- `ANAJAK_SECRET` = the profile's Payment Secret (Anajak dashboard → Settings). Never put it in the site or in chat.
- `ANAJAK_PROFILE_ID` = the profile id (the long id at the end of the checkout URL).
Functions: `khqr` (JWT required) and `khqr-webhook` (**JWT verification off**: the gateway calls it). Both are deployed.
Without the two secrets the site keeps using its own KHQR, so nothing breaks.

Then: sign in as admin → Admin → Activations → **Check bank connection** (it should say payments use Anajak Pay) and pay a real 0.01 test
(use promo code with a 99% discount on Premium, or a fixed discount that leaves $0.01).

## Optional safety net: Account API token
If a webhook is ever missed (their server down, wrong webhook URL), `khqr` can ask Anajak directly:
`GET https://anajakpay.com/api/v1/transactions?search=<bill>` with `Authorization: Bearer kacc_...`. A `SUCCESS` row whose amount covers
our price is settled the same way as a webhook (once only). Create the token in the Anajak dashboard → Account Tokens with **only the scope
`transactions.read`**, merchant-limited to your profile, and store it as the Supabase secret `ANAJAK_TOKEN`. Never in the site or in chat.
Calls are cached 8 s per bill (their limit is 120/minute per token). Admin → Check bank connection reports if the token is rejected.
Not needed: `transactions.write` (resync / callback retry), `settings.*`, `merchants.*`.

## Not proven yet (needs your account)
- A real payment end to end. The request signing follows their PHP sample and the webhook check follows their callback docs; both are tested
  against our own implementation of those formulas, not against their server.
- If Anajak's Settings has a *global webhook URL*, it is used instead of `success_url`. Set it to the same `…/functions/v1/khqr-webhook` URL or leave it empty.
- Where the money goes and the fee: check Anajak's terms.
