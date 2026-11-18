//+------------------------------------------------------------------+
//| AROM_Sync.mq5                                                    |
//| Sends this MT5 account's balance, open positions and closed      |
//| trades to your AROM TRADE journal (Ultra · Broker sync).         |
//| READ-ONLY: it never opens, changes or closes a trade.            |
//|                                                                  |
//| Setup                                                            |
//| 1. Tools > Options > Expert Advisors: tick "Allow WebRequest for |
//|    listed URL" and add  https://sksvwikfyrdhgjngekqp.supabase.co |
//| 2. Drag AROM_Sync onto any one chart, paste your sync code from  |
//|    aromx.trade (Journal > Broker sync), click OK.                |
//| 3. Keep MT5 running (PC or VPS). The chart shows the last sync.  |
//+------------------------------------------------------------------+
#property copyright "AROM TRADE"
#property link      "https://aromx.trade"
#property version   "1.00"
#property description "Read-only sync of balance, open positions and closed trades to your AROM TRADE journal."

input string SyncCode    = "";   // AROM sync code (Journal > Broker sync)
input int    IntervalSec = 60;   // Sync every N seconds (30 or more)
input int    HistoryDays = 30;   // Closed trades to send on the first sync (days)

const string AROM_URL = "https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/broker-sync";
const string AROM_VER = "mt5-1.00";
const int    MAX_DEALS = 300;    // per request; the rest follow on the next syncs

string g_status = "starting…";

//--- small JSON helpers
string J(string s)
  {
   string o = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"') o += "\\\"";
      else if(c == '\\') o += "\\\\";
      else if(c < 32) o += " ";
      else o += ShortToString(c);
     }
   return "\"" + o + "\"";
  }
string N(double v, int digits = 8) { return DoubleToString(v, digits); }
string I(long v) { return IntegerToString(v); }

string AckKey() { return "AROM_ack_" + I(AccountInfoInteger(ACCOUNT_LOGIN)); }

//--- one closed position, built from its deals
struct TradeRec
  {
   ulong    pid;
   string   sym;
   int      side;       // 0 buy, 1 sell (direction of the opening deal)
   double   vol;        // closed volume
   datetime ot, ct;
   double   op;         // opening price
   double   cpw;        // sum(close price * volume) for a volume-weighted exit
   double   profit, comm, swap, sl, tp;
   string   comment;
   bool     hasEntry;
  };

int FindRec(TradeRec &arr[], ulong pid)
  {
   for(int i = 0; i < ArraySize(arr); i++) if(arr[i].pid == pid) return i;
   return -1;
  }

//--- closed trades whose last exit is after `from`
int CollectDeals(datetime from, TradeRec &out[])
  {
   ArrayResize(out, 0);
   if(!HistorySelect(from - 86400, TimeCurrent() + 86400)) return 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      long type = HistoryDealGetInteger(d, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;      // skip balance, credit, etc.
      ulong pid = (ulong)HistoryDealGetInteger(d, DEAL_POSITION_ID);
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      int k = FindRec(out, pid);
      if(k < 0)
        {
         k = ArraySize(out); ArrayResize(out, k + 1);
         out[k].pid = pid; out[k].sym = HistoryDealGetString(d, DEAL_SYMBOL); out[k].side = -1; out[k].vol = 0; out[k].ot = 0; out[k].ct = 0;
         out[k].op = 0; out[k].cpw = 0; out[k].profit = 0; out[k].comm = 0; out[k].swap = 0; out[k].sl = 0; out[k].tp = 0; out[k].comment = ""; out[k].hasEntry = false;
        }
      out[k].comm += HistoryDealGetDouble(d, DEAL_COMMISSION);
      out[k].swap += HistoryDealGetDouble(d, DEAL_SWAP);
      out[k].profit += HistoryDealGetDouble(d, DEAL_PROFIT);
      if(entry == DEAL_ENTRY_IN)
        {
         out[k].hasEntry = true; out[k].side = (type == DEAL_TYPE_BUY ? 0 : 1);
         out[k].ot = (datetime)HistoryDealGetInteger(d, DEAL_TIME); out[k].op = HistoryDealGetDouble(d, DEAL_PRICE);
        }
      else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT)
        {
         double v = HistoryDealGetDouble(d, DEAL_VOLUME);
         out[k].vol += v; out[k].cpw += HistoryDealGetDouble(d, DEAL_PRICE) * v;
         datetime t = (datetime)HistoryDealGetInteger(d, DEAL_TIME); if(t > out[k].ct) out[k].ct = t;
         out[k].sl = HistoryDealGetDouble(d, DEAL_SL); out[k].tp = HistoryDealGetDouble(d, DEAL_TP);
         if(out[k].side < 0) out[k].side = (type == DEAL_TYPE_SELL ? 0 : 1);   // an exit SELL closes a BUY
         out[k].comment = HistoryDealGetString(d, DEAL_COMMENT);
        }
     }
   // keep fully closed positions with an exit after `from`
   TradeRec keep[]; int n = 0;
   for(int i = 0; i < ArraySize(out); i++)
     {
      if(out[i].ct < from || out[i].vol <= 0) continue;                 // same second as the last ack is re-sent; the server ignores duplicates
      if(PositionSelectByTicket(out[i].pid)) continue;                     // still (partly) open: wait until it is closed
      ArrayResize(keep, n + 1); keep[n] = out[i]; n++;
     }
   // opening deal older than the window: look it up
   for(int i = 0; i < n; i++)
     {
      if(keep[i].hasEntry) continue;
      if(HistorySelectByPosition(keep[i].pid))
        for(int j = 0; j < HistoryDealsTotal(); j++)
          {
           ulong d = HistoryDealGetTicket(j);
           if(HistoryDealGetInteger(d, DEAL_ENTRY) == DEAL_ENTRY_IN)
             {
              keep[i].ot = (datetime)HistoryDealGetInteger(d, DEAL_TIME); keep[i].op = HistoryDealGetDouble(d, DEAL_PRICE);
              keep[i].side = (HistoryDealGetInteger(d, DEAL_TYPE) == DEAL_TYPE_BUY ? 0 : 1); keep[i].comm += HistoryDealGetDouble(d, DEAL_COMMISSION);
              keep[i].hasEntry = true; break;
             }
          }
     }
   // oldest exit first, at most MAX_DEALS per request
   for(int a = 0; a < n; a++) for(int b = a + 1; b < n; b++) if(keep[b].ct < keep[a].ct) { TradeRec t = keep[a]; keep[a] = keep[b]; keep[b] = t; }
   int m = MathMin(n, MAX_DEALS);
   ArrayResize(out, m);
   for(int i = 0; i < m; i++) out[i] = keep[i];
   return m;
  }

string BuildBody(datetime from, int &dealsSent)
  {
   string s = "{\"v\":" + J(AROM_VER) + ",\"account\":{";
   s += "\"platform\":\"mt5\",\"login\":" + J(I(AccountInfoInteger(ACCOUNT_LOGIN)));
   s += ",\"server\":" + J(AccountInfoString(ACCOUNT_SERVER)) + ",\"company\":" + J(AccountInfoString(ACCOUNT_COMPANY));
   s += ",\"currency\":" + J(AccountInfoString(ACCOUNT_CURRENCY)) + ",\"leverage\":" + I(AccountInfoInteger(ACCOUNT_LEVERAGE));
   s += ",\"balance\":" + N(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\"equity\":" + N(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   s += ",\"margin\":" + N(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",\"free_margin\":" + N(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   s += ",\"profit\":" + N(AccountInfoDouble(ACCOUNT_PROFIT), 2) + "},\"positions\":[";
   int np = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      long pt = PositionGetInteger(POSITION_TYPE);
      if(np++ > 0) s += ",";
      s += "{\"ticket\":" + I((long)PositionGetInteger(POSITION_IDENTIFIER)) + ",\"symbol\":" + J(PositionGetString(POSITION_SYMBOL));
      s += ",\"type\":" + J(pt == POSITION_TYPE_BUY ? "BUY" : "SELL") + ",\"volume\":" + N(PositionGetDouble(POSITION_VOLUME), 2);
      s += ",\"open_price\":" + N(PositionGetDouble(POSITION_PRICE_OPEN)) + ",\"open_time\":" + I((long)PositionGetInteger(POSITION_TIME));
      s += ",\"sl\":" + N(PositionGetDouble(POSITION_SL)) + ",\"tp\":" + N(PositionGetDouble(POSITION_TP));
      s += ",\"price\":" + N(PositionGetDouble(POSITION_PRICE_CURRENT)) + ",\"profit\":" + N(PositionGetDouble(POSITION_PROFIT), 2);
      s += ",\"swap\":" + N(PositionGetDouble(POSITION_SWAP), 2) + "}";
     }
   s += "],\"deals\":[";
   TradeRec tr[];
   dealsSent = CollectDeals(from, tr);
   for(int i = 0; i < dealsSent; i++)
     {
      if(i > 0) s += ",";
      double cp = tr[i].vol > 0 ? tr[i].cpw / tr[i].vol : 0;
      s += "{\"position_id\":" + I((long)tr[i].pid) + ",\"symbol\":" + J(tr[i].sym) + ",\"type\":" + J(tr[i].side == 1 ? "SELL" : "BUY");
      s += ",\"volume\":" + N(tr[i].vol, 2) + ",\"open_time\":" + I((long)tr[i].ot) + ",\"close_time\":" + I((long)tr[i].ct);
      s += ",\"open_price\":" + N(tr[i].op) + ",\"close_price\":" + N(cp) + ",\"sl\":" + N(tr[i].sl) + ",\"tp\":" + N(tr[i].tp);
      s += ",\"profit\":" + N(tr[i].profit, 2) + ",\"commission\":" + N(tr[i].comm, 2) + ",\"swap\":" + N(tr[i].swap, 2) + ",\"comment\":" + J(tr[i].comment) + "}";
     }
   s += "]}";
   return s;
  }

void SyncNow()
  {
   if(StringLen(SyncCode) < 10) { g_status = "Paste your AROM sync code in the EA inputs."; Comment("AROM Sync: " + g_status); return; }
   datetime ack = (datetime)(GlobalVariableCheck(AckKey()) ? (long)GlobalVariableGet(AckKey()) : 0);
   datetime from = ack > 0 ? ack : TimeCurrent() - HistoryDays * 86400;
   int sent = 0;
   string body = BuildBody(from, sent);
   char data[], result[];
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(data, len - 1);                               // drop the trailing zero
   string headers = "Content-Type: application/json\r\nX-AROM-Token: " + SyncCode + "\r\n", resHeaders;
   ResetLastError();
   int code = WebRequest("POST", AROM_URL, headers, 15000, data, result, resHeaders);
   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code == -1)
     {
      int err = GetLastError();
      g_status = (err == 4014 ? "Add https://sksvwikfyrdhgjngekqp.supabase.co in Tools > Options > Expert Advisors (Allow WebRequest)." : "No connection (error " + I(err) + "), retrying.");
     }
   else if(code == 200)
     {
      int p = StringFind(resp, "\"ack\":");
      if(p >= 0)
        {
         long newAck = StringToInteger(StringSubstr(resp, p + 6, 12));
         if(newAck > (long)ack) GlobalVariableSet(AckKey(), (double)newAck);
        }
      g_status = "Synced " + TimeToString(TimeLocal(), TIME_MINUTES) + " · " + I(PositionsTotal()) + " open · " + I(sent) + " closed sent";
     }
   else if(code == 401) g_status = "Sync code not recognised. Copy it again from aromx.trade.";
   else if(code == 403) g_status = "Broker sync needs an active Ultra plan.";
   else if(code == 409) g_status = "This sync code belongs to another MT account. Create a new code for this account.";
   else if(code == 429) g_status = "Waiting (synced recently).";
   else g_status = "Server answered " + I(code) + ", retrying.";
   Comment("AROM Sync (read-only): " + g_status);
  }

int OnInit()
  {
   EventSetTimer(MathMax(30, IntervalSec));
   SyncNow();
   return(INIT_SUCCEEDED);
  }
void OnTimer() { SyncNow(); }
void OnDeinit(const int reason) { EventKillTimer(); Comment(""); }
//+------------------------------------------------------------------+
