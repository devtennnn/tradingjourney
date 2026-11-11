// KHQR (Bakong) dynamic payload builder — EMV merchant-presented QR with CRC16/CCITT-FALSE.
// Pure functions, no dependencies, so it runs in Deno (Edge Function) and Node (tests).

const tlv = (tag: string, val: string): string => tag + String(val.length).padStart(2, "0") + val;

/** CRC16-CCITT (poly 0x1021, init 0xFFFF) as 4 uppercase hex chars. */
export function crc16(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export interface KhqrInput {
  accountId: string;              // Bakong account, e.g. "devten@aclb"
  accountType?: "individual" | "merchant";
  merchantId?: string;            // merchant accounts only
  acquiringBank?: string;         // merchant accounts only
  merchantName: string;           // max 25 chars
  merchantCity: string;           // max 15 chars
  amount: number;
  currency: "USD" | "KHR";
  billNumber: string;             // max 25 chars, unique per payment
  storeLabel?: string;
  terminalLabel?: string;
  createdMs: number;
  expiresMs: number;
}

/** Build a DYNAMIC KHQR string (point of initiation "12") with an expiry timestamp. */
export function buildKHQR(o: KhqrInput): string {
  const isKhr = o.currency === "KHR";
  const amount = isKhr ? String(Math.round(o.amount)) : Number(o.amount).toFixed(2);
  let s = tlv("00", "01") + tlv("01", "12");

  if (o.accountType === "merchant") {
    s += tlv("30", tlv("00", o.accountId) + tlv("01", o.merchantId || "") + tlv("02", o.acquiringBank || ""));
  } else {
    s += tlv("29", tlv("00", o.accountId));
  }

  s += tlv("52", "5999");
  s += tlv("53", isKhr ? "116" : "840");
  s += tlv("54", amount);
  s += tlv("58", "KH");
  s += tlv("59", o.merchantName.slice(0, 25));
  s += tlv("60", o.merchantCity.slice(0, 15));

  let extra = tlv("01", o.billNumber.slice(0, 25));
  if (o.storeLabel) extra += tlv("03", o.storeLabel.slice(0, 25));
  if (o.terminalLabel) extra += tlv("07", o.terminalLabel.slice(0, 25));
  s += tlv("62", extra);

  s += tlv("99", tlv("00", String(o.createdMs)) + tlv("01", String(o.expiresMs)));

  s += "6304";
  return s + crc16(s);
}

/** Parse top-level TLV pairs (used by tests / debugging). */
export function parseTLV(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len)) throw new Error("bad TLV length at " + i);
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** True when the trailing CRC matches the payload. */
export function verifyCRC(payload: string): boolean {
  return payload.slice(-4) === crc16(payload.slice(0, -4));
}
