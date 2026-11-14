# Bakong relay (turns on automatic KHQR confirmation)

## The problem

When someone pays your KHQR, the `khqr` function asks Bakong "was this QR paid?". Bakong answers calls that come from
outside Cambodia with an **empty HTTP 403**, before it even checks your token. Supabase Edge Functions run in Singapore or
Seoul, so every check is refused and the payment is never confirmed automatically.

The function log shows it: `Bakong not usable: geo_blocked http 403`. In Admin → Activations the **Check bank
connection** button shows the same verdict and where the function runs from.

## Until it is fixed: confirm by hand

The site already handles this. The buyer taps **I've paid, notify admin** (or **I paid this one** under *Paid but not
activated?*). You see the payment in **Admin → Activations → Unconfirmed QR payments**. Find the bill number (`DT…`) or the
exact amount in your ABA app, then press **Approve +30 days**. The buyer's window unlocks by itself.

## Quick start on a VPS (recommended)

Needs: a VPS with a **Cambodian IP** running Ubuntu 22.04/24.04 or Debian 12, root SSH, ports 80 and 443 open.
A real domain is best (point an `A` record at the VPS first). Without one the installer uses a free `<ip>.sslip.io` name.

```bash
scp -r setup/bakong-relay root@YOUR_VPS_IP:/root/
ssh root@YOUR_VPS_IP
cd /root/bakong-relay
sudo bash install.sh --domain relay.yourdomain.com      # or: sudo bash install.sh   (uses sslip.io)
# optional first: sudo bash install.sh --dry-run        (prints the plan, changes nothing)
```

The installer checks the server's country and whether Bakong answers it, installs Node, the relay (own user, sandboxed
systemd service) and Caddy (automatic HTTPS), then prints the two secrets. Put them in Supabase → Edge Functions → Secrets:
`BAKONG_API_URL` and `BAKONG_RELAY_KEY`. Then Admin → Activations → **Check bank connection**, then one real test payment.

## Manual setup (any server with a Cambodian IP)

`relay.mjs` forwards exactly one call (`check_transaction_by_md5`) from your function to Bakong. It runs on any server that
has a Cambodian IP address (for example a small VPS in Phnom Penh).

1. On that server (Node 18+): `RELAY_KEY=$(openssl rand -hex 24) node relay.mjs` and write down the key.
2. Put HTTPS in front of it (Caddy, nginx or a Cloudflare Tunnel). Never expose it over plain HTTP: the Bakong token travels in the request.
3. In Supabase → Edge Functions → Secrets set:
   - `BAKONG_API_URL` = `https://relay.yourdomain.com` (no trailing slash)
   - `BAKONG_RELAY_KEY` = the key from step 1
   - `BAKONG_TOKEN` stays as it is (the relay passes it through)
4. In the site open Admin → Activations → **Check bank connection**. It should say *Automatic bank confirmation is working*.
5. Make one real $2.50 test payment to confirm the whole path.

The relay is not an open proxy: it only accepts `POST /v1/check_transaction_by_md5` with `{"md5":"<32 hex>"}` and your secret in
`x-relay-key`; anything else gets 401, 404, 400 or 413. It never stores or logs the token.

## What is proven and what is not

- Proven (tests): the relay's forwarding and refusals; the function's handling of every Bakong answer (blocked, bad token, not found, server error, paid, wrong amount, wrong account); the claim and approve flow.
- Strongly indicated, not proven: that Bakong blocks by location. The empty 403 is the classic block; a bad token returns a JSON answer instead.
- Not tested: a real Bakong payment through the relay. Do step 5.
- Open question: Bakong may not list payments between two accounts at the same bank (payer on ABA paying an ABA merchant). If your own ABA-to-ABA test is never found even through a relay, use a payer at another bank for the test, and keep the manual approval for same-bank payers.
