//+------------------------------------------------------------------+
//| AROM_Sync.mq4                                                    |
//| Sends this MT4 account's balance, open trades and closed trades  |
//| to your AROM TRADE journal (Ultra · Broker sync).                |
//| READ-ONLY: it never opens, changes or closes a trade.            |
//|                                                                  |
//| Setup                                                            |
//| 1. Tools > Options > Expert Advisors: tick "Allow WebRequest for |
//|    listed URL" and add  https://sksvwikfyrdhgjngekqp.supabase.co |
//| 2. Drag AROM_Sync onto any one chart, paste your sync code from  |
//|    aromx.trade (Journal > Broker sync), click OK.                |
//| 3. Keep MT4 running (PC or VPS). The chart shows the last sync.  |
//| In the History tab choose "All History" so older trades load.    |
//+------------------------------------------------------------------+
#property copyright "AROM TRADE"
#property link      "https://aromx.trade"
#property version   "1.00"
#property description "Read-only sync of balance, open trades and closed trades to your AROM TRADE journal."
#property strict

input string SyncCode    = "";   // AROM sync code (Journal > Broker sync)
input int    IntervalSec = 60;   // Sync every N seconds (30 or more)
input int    HistoryDays = 30;   // Closed trades to send on the first sync (days)

const string AROM_URL = "https://sksvwikfyrdhgjngekqp.supabase.co/functions/v1/broker-sync";
const string AROM_VER = "mt4-1.00";
const int    MAX_DEALS = 300;

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
string AckKey() { return "AROM_ack_" + I(AccountNumber()); }

string BuildBody(datetime from, int &dealsSent)
  {
   string s = "{\"v\":" + J(AROM_VER) + ",\"account\":{";
   s += "\"platform\":\"mt4\",\"login\":" + J(I(AccountNumber())) + ",\"server\":" + J(AccountServer()) + ",\"company\":" + J(AccountCompany());
   s += ",\"currency\":" + J(AccountCurrency()) + ",\"leverage\":" + I(AccountLeverage());
   s += ",\"balance\":" + N(AccountBalance(), 2) + ",\"equity\":" + N(AccountEquity(), 2) + ",\"margin\":" + N(AccountMargin(), 2);
   s += ",\"free_margin\":" + N(AccountFreeMargin(), 2) + ",\"profit\":" + N(AccountProfit(), 2) + "},\"positions\":[";
   int np = 0;
   for(int i = 0; i < OrdersTotal(); i++)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderType() != OP_BUY && OrderType() != OP_SELL) continue;      // pending orders are not positions
      if(np++ > 0) s += ",";
      s += "{\"ticket\":" + I(OrderTicket()) + ",\"symbol\":" + J(OrderSymbol()) + ",\"type\":" + J(OrderType() == OP_BUY ? "BUY" : "SELL");
      s += ",\"volume\":" + N(OrderLots(), 2) + ",\"open_price\":" + N(OrderOpenPrice()) + ",\"open_time\":" + I((long)OrderOpenTime());
      s += ",\"sl\":" + N(OrderStopLoss()) + ",\"tp\":" + N(OrderTakeProfit()) + ",\"price\":" + N(OrderClosePrice());   // for an open order OrderClosePrice() = current price
      s += ",\"profit\":" + N(OrderProfit(), 2) + ",\"swap\":" + N(OrderSwap(), 2) + "}";
     }
   s += "],\"deals\":[";
   // closed trades with a close time after `from`, oldest first, at most MAX_DEALS
   int idx[], n = 0, total = OrdersHistoryTotal();
   for(int i = 0; i < total; i++)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      if(OrderType() != OP_BUY && OrderType() != OP_SELL) continue;      // skip balance / credit rows
      if(OrderCloseTime() < from) continue;
      ArrayResize(idx, n + 1); idx[n] = OrderTicket(); n++;
     }
   datetime ct[]; ArrayResize(ct, n);
   for(int i = 0; i < n; i++) { if(OrderSelect(idx[i], SELECT_BY_TICKET, MODE_HISTORY)) ct[i] = OrderCloseTime(); else ct[i] = 0; }
   for(int a = 0; a < n; a++) for(int b = a + 1; b < n; b++) if(ct[b] < ct[a]) { datetime t = ct[a]; ct[a] = ct[b]; ct[b] = t; int k = idx[a]; idx[a] = idx[b]; idx[b] = k; }
   dealsSent = 0;
   for(int i = 0; i < n && dealsSent < MAX_DEALS; i++)
     {
      if(!OrderSelect(idx[i], SELECT_BY_TICKET, MODE_HISTORY)) continue;
      if(dealsSent++ > 0) s += ",";
      s += "{\"position_id\":" + I(OrderTicket()) + ",\"symbol\":" + J(OrderSymbol()) + ",\"type\":" + J(OrderType() == OP_BUY ? "BUY" : "SELL");
      s += ",\"volume\":" + N(OrderLots(), 2) + ",\"open_time\":" + I((long)OrderOpenTime()) + ",\"close_time\":" + I((long)OrderCloseTime());
      s += ",\"open_price\":" + N(OrderOpenPrice()) + ",\"close_price\":" + N(OrderClosePrice()) + ",\"sl\":" + N(OrderStopLoss()) + ",\"tp\":" + N(OrderTakeProfit());
      s += ",\"profit\":" + N(OrderProfit(), 2) + ",\"commission\":" + N(OrderCommission(), 2) + ",\"swap\":" + N(OrderSwap(), 2) + ",\"comment\":" + J(OrderComment()) + "}";
     }
   s += "]}";
   return s;
  }

void SyncNow()
  {
   string status;
   if(StringLen(SyncCode) < 10) { Comment("AROM Sync: paste your AROM sync code in the EA inputs."); return; }
   datetime ack = (datetime)(GlobalVariableCheck(AckKey()) ? (long)GlobalVariableGet(AckKey()) : 0);
   datetime from = ack > 0 ? ack : TimeCurrent() - HistoryDays * 86400;
   int sent = 0;
   string body = BuildBody(from, sent);
   char data[], result[];
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(data, len - 1);
   string headers = "Content-Type: application/json\r\nX-AROM-Token: " + SyncCode + "\r\n", resHeaders;
   ResetLastError();
   int code = WebRequest("POST", AROM_URL, headers, 15000, data, result, resHeaders);
   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code == -1)
     {
      int err = GetLastError();
      status = (err == 4060 || err == 4014 ? "Add https://sksvwikfyrdhgjngekqp.supabase.co in Tools > Options > Expert Advisors (Allow WebRequest)." : "No connection (error " + I(err) + "), retrying.");
     }
   else if(code == 200)
     {
      int p = StringFind(resp, "\"ack\":");
      if(p >= 0)
        {
         long newAck = StringToInteger(StringSubstr(resp, p + 6, 12));
         if(newAck > (long)ack) GlobalVariableSet(AckKey(), (double)newAck);
        }
      status = "Synced " + TimeToString(TimeLocal(), TIME_MINUTES) + " · " + I(OrdersTotal()) + " open · " + I(sent) + " closed sent";
     }
   else if(code == 401) status = "Sync code not recognised. Copy it again from aromx.trade.";
   else if(code == 403) status = "Broker sync needs an active Ultra plan.";
   else if(code == 409) status = "This sync code belongs to another MT account. Create a new code for this account.";
   else if(code == 429) status = "Waiting (synced recently).";
   else status = "Server answered " + I(code) + ", retrying.";
   Comment("AROM Sync (read-only): " + status);
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
