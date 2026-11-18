// Two-leg cbBTC swing bot for make.fun btc-race-24h-20261118-1444.
//
// Leg A — crash bounce: after a sharp drop (close >= 3% below the 120-bar
// high, 60-minute return <= -1.5%) buy once the price bounces >= 0.3% off
// its 10-bar low. Take profit +4.5%, trail 1.5%, stop -2%, hold at most
// 360 bars.
// Leg B — flat-day dip: on a quiet drift (close >= 1% below the 240-bar
// high) buy once the price bounces >= 0.2% off its 10-bar low. Take profit
// +1.5%, trail 2%, stop -1%, hold at most 240 bars, at most 2 B-trades
// per run. No new entries in the last 120 bars of the window, so a
// position always has time to reach an exit.
//
// Full equity, long only. Deterministic: no clock, no environment, no
// randomness; every decision comes from the bars the harness sends.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const PRICE = 100000; // price_scale 5: raw price / 1e5 = USDC per cbBTC
const SLIP_BPS = 100;
const WINDOW_BARS = 1440;
const NO_ENTRY_TAIL = 120;

// Leg A: crash bounce.
const A_DIP = 0.03;
const A_R60 = -0.015;
const A_BOUNCE = 0.003;
const A_TP = 0.045;
const A_TRAIL = 0.015;
const A_STOP = 0.02;
const A_HOLD = 360;

// Leg B: flat-day dip.
const B_DIP = 0.01;
const B_BOUNCE = 0.002;
const B_MAX = 2;
const B_TP = 0.015;
const B_TRAIL = 0.02;
const B_STOP = 0.01;
const B_HOLD = 240;

type Leg = 'A' | 'B';

const closes: number[] = [];
let pendingLeg: Leg | null = null;
let leg: Leg | null = null;
let entryPrice = 0;
let entrySeq = -1;
let trailPeak = 0;
let bTrades = 0;

function high(n: number): number {
  let h = 0;
  for (let i = Math.max(0, closes.length - n); i < closes.length; i++) {
    if (closes[i]! > h) h = closes[i]!;
  }
  return h;
}

function low(n: number): number {
  let l = Infinity;
  for (let i = Math.max(0, closes.length - n); i < closes.length; i++) {
    if (closes[i]! < l) l = closes[i]!;
  }
  return l;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(Number(bar.c) / PRICE);

    // Fold in the fills of the orders decided on the previous batch.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL) continue;
      if (f.side === 'buy' && f.status === 'filled' && pendingLeg !== null) {
        leg = pendingLeg;
        entryPrice = Number(f.price) / PRICE;
        entrySeq = state.seq;
        trailPeak = entryPrice;
        if (pendingLeg === 'B') bTrades += 1;
        pendingLeg = null;
      } else if (f.side === 'buy' && f.status === 'rejected') {
        pendingLeg = null;
      }
    }

    const pos = state.positions.get(SYMBOL);
    const held = pos !== undefined && pos.qty > 0n;
    const c = closes[closes.length - 1]!;

    if (!held) {
      leg = null;
      if (pendingLeg !== null) return [];
      if (state.seq >= WINDOW_BARS - NO_ENTRY_TAIL) return [];
      if (state.cash < 1000000n) return [];

      // Leg A first: a crash bounce outranks a flat-day dip.
      if (closes.length >= 120) {
        const r60 = closes.length >= 61 ? c / closes[closes.length - 61]! - 1 : 0;
        if (c <= high(120) * (1 - A_DIP) && r60 <= A_R60 && c >= low(10) * (1 + A_BOUNCE)) {
          pendingLeg = 'A';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: SLIP_BPS }];
        }
      }
      if (closes.length >= 240 && bTrades < B_MAX) {
        if (c <= high(240) * (1 - B_DIP) && c >= low(10) * (1 + B_BOUNCE)) {
          pendingLeg = 'B';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: SLIP_BPS }];
        }
      }
      return [];
    }

    // Holding: take profit, trailing stop, stop loss, or hold expiry.
    trailPeak = Math.max(trailPeak, c);
    const tp = leg === 'A' ? A_TP : B_TP;
    const trail = leg === 'A' ? A_TRAIL : B_TRAIL;
    const stop = leg === 'A' ? A_STOP : B_STOP;
    const hold = leg === 'A' ? A_HOLD : B_HOLD;
    if (
      c >= entryPrice * (1 + tp) ||
      c <= trailPeak * (1 - trail) ||
      c <= entryPrice * (1 - stop) ||
      state.seq - entrySeq >= hold
    ) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: SLIP_BPS }];
    }
    return [];
  },
});
