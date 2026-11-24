// PressureWave — a deterministic pump.fun paper-trading bot for the
// pumpfun-replay/v2 harness (make.fun "Pump.fun Paper Sprint").
//
// Wire protocol (line-delimited JSON on stdin/stdout):
//   harness -> bot : {"type":"hello", ...} once, then one
//                    {"type":"batch", seq, slot, events, marks, fills, account}
//                    per slot, and finally {"type":"done", ...}.
//   bot -> harness : exactly one {"type":"reply", seq, orders} line per batch.
//                    A buy order is  {side:"buy",  client_id, mint,
//                                     quote_lamports, max_slippage_bps}
//                    and a sell is   {side:"sell", client_id, mint,
//                                     token_amount,  max_slippage_bps}.
//                    All lamport/token amounts are u64 decimal strings.
//
// Strategy: confirmed buy-pressure momentum. For every mint we keep the
// recent trade flow (from the batch events) and the latest mark (bonding
// curve reserves). We enter only when recent flow is dominated by buys,
// total flow is meaningful, the mark price is rising, and the curve already
// holds real reserves. Orders decided at a slot fill a few slots later
// (hello.latency_slots), so sizing respects the harness caps from hello:
// max_open_positions, max_orders_per_batch and the per-mint per-reply cap
// max_order_bps_of_real_reserve of the mint's real quote reserve.
//
// The bot is a pure function of the lines it has read: no network, no
// wall clock, no randomness. Two runs on the same replay emit the same
// orders byte for byte.

import { readSync, writeSync } from "node:fs";

// ---------------------------------------------------------------------------
// Small helpers. All money math is BigInt; prices are kept as scaled ratios.
// ---------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1000000000n;

function u64(value) {
  // Parse a u64 decimal string defensively; anything odd becomes 0n.
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}

function bpsOf(part, whole) {
  // Integer basis points of part/whole, 0 when whole is 0.
  if (whole <= 0n) return 0;
  return Number((part * 10000n) / whole);
}

// ---------------------------------------------------------------------------
// Line reader: synchronous, so the bot answers each batch before reading on.
// ---------------------------------------------------------------------------

class LineReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.eof = false;
    this.chunk = Buffer.alloc(1 << 16);
  }

  readLine() {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl >= 0) {
        const line = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.eof) {
        if (this.buf.length === 0) return null;
        const line = this.buf.toString("utf8");
        this.buf = Buffer.alloc(0);
        return line;
      }
      let n = 0;
      try {
        n = readSync(0, this.chunk, 0, this.chunk.length, null);
      } catch {
        n = 0;
      }
      if (n === 0) {
        this.eof = true;
      } else {
        this.buf = Buffer.concat([this.buf, this.chunk.subarray(0, n)]);
      }
    }
  }
}

function emit(obj) {
  writeSync(1, JSON.stringify(obj) + "\n");
}

// ---------------------------------------------------------------------------
// Strategy constants (fractions are of the hello capital unless noted).
// ---------------------------------------------------------------------------

const FLOW_BATCHES = 24; // batches of flow kept per mint
const MIN_REAL_RESERVE = 4n * LAMPORTS_PER_SOL; // curve must hold >= 4 SOL
const MIN_WINDOW_FLOW = 3n * LAMPORTS_PER_SOL / 2n; // >= 1.5 SOL recent flow
const MIN_BUY_SHARE_BPS = 6200; // >= 62% of recent flow is buys
const MIN_WINDOW_TRADES = 6;
const MOMENTUM_MIN_BPS = 250; // price +2.5% across the momentum lookback
const MOMENTUM_LOOKBACK = 8; // marks
const SIZE_FRACTION_BPS = 700; // 7% of starting capital per entry
const SIZE_CASH_BPS = 2500; // never more than 25% of current cash
const MIN_ORDER = LAMPORTS_PER_SOL / 20n; // skip dust (< 0.05 SOL)
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 2500;
const EXIT_COOLDOWN_SLOTS = 240; // per-mint rest after an exit

// ---------------------------------------------------------------------------
// Per-mint state.
// ---------------------------------------------------------------------------

function newMintState(slot) {
  return {
    firstSlot: slot,
    lastSeenSlot: slot,
    complete: false,
    // Latest mark (bonding-curve reserves) and a short price history.
    vQuote: 0n,
    vToken: 0n,
    realQuote: 0n,
    priceHistory: [], // scaled prices: vQuote * 1e12 / vToken, as BigInt
    // Flow ring: one aggregate per batch that touched the mint.
    flow: [], // {buy, sell, trades} BigInt lamports / count
    flowBuy: 0n,
    flowSell: 0n,
    flowTrades: 0,
    // Position bookkeeping mirrored from the account in each batch.
    heldTokens: 0n,
    heldCost: 0n,
    entrySlot: 0,
    peakPrice: 0n,
    pendingBuy: false,
    cooldownUntil: -1,
  };
}

function priceOf(st) {
  if (st.vToken <= 0n) return 0n;
  return (st.vQuote * 1000000000000n) / st.vToken;
}

function pushFlow(st, buy, sell, trades) {
  st.flow.push({ buy, sell, trades });
  st.flowBuy += buy;
  st.flowSell += sell;
  st.flowTrades += trades;
  if (st.flow.length > FLOW_BATCHES) {
    const old = st.flow.shift();
    st.flowBuy -= old.buy;
    st.flowSell -= old.sell;
    st.flowTrades -= old.trades;
  }
}

// ---------------------------------------------------------------------------
// Bot state.
// ---------------------------------------------------------------------------

const bot = {
  caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16 },
  capital: 0n,
  cash: 0n,
  orderSeq: 0,
  mints: new Map(),
  openCount: 0,
  equityPeak: 0n,
  entriesHalted: false,
  pruneCursor: 0,
};

function mintState(mint, slot) {
  let st = bot.mints.get(mint);
  if (st === undefined) {
    st = newMintState(slot);
    bot.mints.set(mint, st);
  }
  return st;
}

function nextClientId(prefix) {
  bot.orderSeq += 1;
  return prefix + bot.orderSeq;
}

// Largest buy the harness accepts for this mint in one reply: the cap is a
// share of the mint's real quote reserve at decision time. Stay under it.
function reserveCapFor(st) {
  const bps = BigInt(bot.caps.max_order_bps_of_real_reserve);
  return (st.realQuote * bps * 85n) / 1000000n; // 85% of the cap, in lamports
}

function entryQuote(st) {
  let quote = (bot.capital * BigInt(SIZE_FRACTION_BPS)) / 10000n;
  const cashCap = (bot.cash * BigInt(SIZE_CASH_BPS)) / 10000n;
  if (cashCap < quote) quote = cashCap;
  const reserveCap = reserveCapFor(st);
  if (reserveCap < quote) quote = reserveCap;
  return quote;
}

// ---------------------------------------------------------------------------
// Batch processing: fold events, marks, fills and the account into state.
// ---------------------------------------------------------------------------

function applyBatch(batch) {
  const slot = batch.slot >>> 0;
  const touched = new Map(); // mint -> {buy, sell, trades} for this batch

  for (const ev of batch.events || []) {
    if (!ev || typeof ev.mint !== "string") continue;
    const st = mintState(ev.mint, slot);
    st.lastSeenSlot = slot;
    if (ev.event === "CompleteEvent") {
      st.complete = true;
    } else if (ev.event === "TradeEvent") {
      // For SOL-quoted coins sol_amount and quote_amount agree.
      const amount = u64(ev.quote_amount || ev.sol_amount);
      let agg = touched.get(ev.mint);
      if (agg === undefined) {
        agg = { buy: 0n, sell: 0n, trades: 0 };
        touched.set(ev.mint, agg);
      }
      if (ev.is_buy) agg.buy += amount;
      else agg.sell += amount;
      agg.trades += 1;
      // A trade event carries the curve reserves right after the trade.
      if (u64(ev.virtual_token_reserves) > 0n) {
        st.vQuote = u64(ev.virtual_quote_reserves);
        st.vToken = u64(ev.virtual_token_reserves);
        st.realQuote = u64(ev.real_quote_reserves);
      }
    }
  }
  for (const [mint, agg] of touched) {
    pushFlow(bot.mints.get(mint), agg.buy, agg.sell, agg.trades);
  }

  for (const mark of batch.marks || []) {
    if (!mark || typeof mark.mint !== "string") continue;
    const st = mintState(mark.mint, slot);
    st.lastSeenSlot = slot;
    if (u64(mark.virtual_token_reserves) > 0n) {
      st.vQuote = u64(mark.virtual_quote_reserves);
      st.vToken = u64(mark.virtual_token_reserves);
      st.realQuote = u64(mark.real_quote_reserves);
      const price = priceOf(st);
      if (price > 0n) {
        st.priceHistory.push(price);
        if (st.priceHistory.length > 64) st.priceHistory.shift();
        if (st.heldTokens > 0n && price > st.peakPrice) st.peakPrice = price;
      }
    }
  }

  for (const fill of batch.fills || []) {
    // Fills resolve our pending orders; the account below is authoritative,
    // so here we only clear the pending flag on the mint we ordered.
    if (!fill || typeof fill.mint !== "string") continue;
    const st = bot.mints.get(fill.mint);
    if (st !== undefined && fill.side === "buy") st.pendingBuy = false;
  }

  const account = batch.account || { cash_lamports: "0", positions: [] };
  bot.cash = u64(account.cash_lamports);
  const heldNow = new Set();
  let open = 0;
  for (const pos of account.positions || []) {
    if (!pos || typeof pos.mint !== "string") continue;
    const st = mintState(pos.mint, slot);
    const tokens = u64(pos.token_amount);
    if (tokens > 0n) {
      heldNow.add(pos.mint);
      open += 1;
      if (st.heldTokens === 0n) {
        st.entrySlot = slot;
        st.peakPrice = priceOf(st);
      }
      st.heldTokens = tokens;
      st.heldCost = u64(pos.cost_lamports);
    }
  }
  for (const [mint, st] of bot.mints) {
    if (st.heldTokens > 0n && !heldNow.has(mint)) {
      st.heldTokens = 0n;
      st.heldCost = 0n;
      st.peakPrice = 0n;
      st.cooldownUntil = slot + EXIT_COOLDOWN_SLOTS;
    }
  }
  bot.openCount = open;
}

// ---------------------------------------------------------------------------
// Entry scan: confirmed buy pressure plus rising price, caps respected.
// ---------------------------------------------------------------------------

function scanEntries(batch, orders) {
  const slot = batch.slot >>> 0;
  const maxOrders = bot.caps.max_orders_per_batch;
  // Deterministic candidate order: the order mints first appear in state.
  for (const [mint, st] of bot.mints) {
    if (orders.length >= maxOrders) break;
    if (bot.openCount + pendingCount() >= bot.caps.max_open_positions) break;
    if (st.heldTokens > 0n || st.pendingBuy || st.complete) continue;
    if (slot <= st.cooldownUntil) continue;
    if (st.realQuote < MIN_REAL_RESERVE) continue;
    if (st.flowTrades < MIN_WINDOW_TRADES) continue;
    const flowTotal = st.flowBuy + st.flowSell;
    if (flowTotal < MIN_WINDOW_FLOW) continue;
    if (bpsOf(st.flowBuy, flowTotal) < MIN_BUY_SHARE_BPS) continue;
    const hist = st.priceHistory;
    if (hist.length <= MOMENTUM_LOOKBACK) continue;
    const then = hist[hist.length - 1 - MOMENTUM_LOOKBACK];
    const now = hist[hist.length - 1];
    if (then <= 0n) continue;
    if (bpsOf(now - then, then) < MOMENTUM_MIN_BPS) continue;
    const quote = entryQuote(st);
    if (quote < MIN_ORDER) continue;
    orders.push({
      side: "buy",
      client_id: nextClientId("pw-buy-"),
      mint,
      quote_lamports: quote.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    st.pendingBuy = true;
  }
}

function pendingCount() {
  let n = 0;
  for (const st of bot.mints.values()) if (st.pendingBuy) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Exit engine and risk brake.
// ---------------------------------------------------------------------------

const TAKE_PROFIT_BPS = 5500; // +55% over average cost: sell everything
const STOP_LOSS_BPS = -2200; // -22%: sell everything
const TRAIL_ARM_BPS = 2800; // trailing stop arms at +28%
const TRAIL_DROP_BPS = 1600; // then a 16% fall from the peak sells
const MAX_HOLD_SLOTS = 3600; // time stop, whatever the tape says
const PRESSURE_EXIT_BPS = 3000; // buy share under 30% while flat: leave
const BRAKE_FREEZE_BPS = 1800; // equity -18% from peak: stop new entries
const BRAKE_RESUME_BPS = 800; // entries resume once back within -8%
const BRAKE_LIQUIDATE_BPS = 3000; // equity -30%: sell all, halt for the run

// Mark-to-market value of one position at the latest mark, in lamports.
function positionValue(st) {
  if (st.heldTokens <= 0n || st.vToken <= 0n) return 0n;
  return (st.heldTokens * st.vQuote) / st.vToken;
}

// Unrealised PnL of a position in bps of its remaining cost basis.
function pnlBps(st) {
  if (st.heldTokens <= 0n || st.heldCost <= 0n) return 0;
  const value = positionValue(st);
  const diff = value - st.heldCost;
  const scaled = (diff < 0n ? -diff : diff) * 10000n / st.heldCost;
  return diff < 0n ? -Number(scaled) : Number(scaled);
}

function equityNow() {
  let total = bot.cash;
  for (const st of bot.mints.values()) total += positionValue(st);
  return total;
}

function sellAll(st, mint, orders) {
  orders.push({
    side: "sell",
    client_id: nextClientId("pw-sell-"),
    mint,
    token_amount: st.heldTokens.toString(),
    max_slippage_bps: SELL_SLIPPAGE_BPS,
  });
}

function decideExits(batch, orders) {
  const slot = batch.slot >>> 0;
  const maxOrders = bot.caps.max_orders_per_batch;

  // Drawdown brake first: it can force a full liquidation on its own.
  const equity = equityNow();
  if (equity > bot.equityPeak) bot.equityPeak = equity;
  let drawdownBps = 0;
  if (bot.equityPeak > 0n) drawdownBps = bpsOf(bot.equityPeak - equity, bot.equityPeak);
  if (drawdownBps >= BRAKE_LIQUIDATE_BPS && !bot.entriesHalted) {
    bot.entriesHalted = true;
    for (const [mint, st] of bot.mints) {
      if (orders.length >= maxOrders) break;
      if (st.heldTokens > 0n) sellAll(st, mint, orders);
    }
    return true;
  }
  if (bot.frozenUntil === undefined) bot.frozenUntil = -1;
  if (drawdownBps >= BRAKE_FREEZE_BPS) bot.frozenUntil = slot + 600;
  const frozen = bot.entriesHalted || slot <= bot.frozenUntil;

  for (const [mint, st] of bot.mints) {
    if (orders.length >= maxOrders) break;
    if (st.heldTokens <= 0n) continue;
    const pnl = pnlBps(st);
    let exit = false;
    if (st.complete) exit = true; // curve finished: leave while we can
    else if (pnl >= TAKE_PROFIT_BPS) exit = true;
    else if (pnl <= STOP_LOSS_BPS) exit = true;
    else if (slot - st.entrySlot >= MAX_HOLD_SLOTS) exit = true;
    else if (st.peakPrice > 0n && st.heldCost > 0n) {
      // Trailing stop: armed once the peak value clears the arm threshold.
      const peakValue = (st.heldTokens * st.peakPrice) / 1000000000000n;
      const peakPnl = bpsOf(peakValue - st.heldCost, st.heldCost);
      if (peakValue > st.heldCost && peakPnl >= TRAIL_ARM_BPS) {
        const price = priceOf(st);
        if (price > 0n && bpsOf(st.peakPrice - price, st.peakPrice) >= TRAIL_DROP_BPS) exit = true;
      }
    }
    if (!exit && pnl < 500) {
      // Momentum died: recent flow flipped to sellers while we are flat.
      const flowTotal = st.flowBuy + st.flowSell;
      if (flowTotal > 0n && bpsOf(st.flowBuy, flowTotal) < PRESSURE_EXIT_BPS) exit = true;
    }
    if (exit) sellAll(st, mint, orders);
  }

  // Prune cold mints so a long replay stays within memory: anything not
  // held, not pending and untouched for a long stretch can be forgotten.
  bot.pruneCursor += 1;
  if (bot.pruneCursor >= 512) {
    bot.pruneCursor = 0;
    for (const [mint, st] of bot.mints) {
      if (st.heldTokens === 0n && !st.pendingBuy && slot - st.lastSeenSlot > 3000) {
        bot.mints.delete(mint);
      }
    }
  }
  return frozen;
}

// ---------------------------------------------------------------------------
// Main loop: hello, then one reply per batch, exit on done / EOF.
// ---------------------------------------------------------------------------

function main() {
  const reader = new LineReader();
  const first = reader.readLine();
  if (first === null) return;
  let hello;
  try {
    hello = JSON.parse(first);
  } catch {
    return;
  }
  if (hello && hello.type === "hello") {
    if (hello.caps) bot.caps = hello.caps;
    if (hello.capital) bot.capital = u64(hello.capital.lamports);
    bot.cash = bot.capital;
  }

  for (;;) {
    const line = reader.readLine();
    if (line === null) return;
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "done") return;
    if (msg.type !== "batch") continue;
    applyBatch(msg);
    const orders = [];
    const frozen = decideExits(msg, orders);
    if (!frozen) scanEntries(msg, orders);
    emit({ type: "reply", seq: msg.seq, orders });
  }
}

main();
