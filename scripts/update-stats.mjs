// Builds data/stats.json (+ data/events.json) for the live Summer Engine.
// Public-RPC only, no API key. Incremental: only new txns are scanned each run.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scan } from "./scan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const STATS = join(DATA, "stats.json");
const EVENTS = join(DATA, "events.json");

const MINT = "3AtR8x9UCzDYneRSx93pQLK5uFsr57iLbopMtHPEpump";
const INITIAL_SUPPLY = 1_000_000_000;
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
// Count only dev-wallet burns from the start of the burn campaign (Jul 12, 2026 UTC).
// Excludes older/unrelated burns by random holders.
const BURN_SINCE = Math.floor(Date.parse("2026-07-12T00:00:00Z") / 1000);

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}
async function getSupply() {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [MINT] }) });
  const j = await r.json();
  return j.result?.value?.uiAmount ?? null;
}
async function getPrice() {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`);
    const j = await r.json();
    return Number(j.pairs?.[0]?.priceUsd) || 0;
  } catch { return 0; }
}

async function main() {
  const prevEvents = await readJson(EVENTS, []);
  const sinceTime = prevEvents.reduce((m, e) => Math.max(m, e.time || 0), 0);

  // Only scan transactions newer than what we already have.
  const fresh = await scan(sinceTime).catch((e) => { console.error("scan failed:", e.message); return null; });

  // Merge, dedupe by signature, keep newest first.
  const bySig = new Map();
  for (const e of prevEvents) bySig.set(e.sig, e);
  if (fresh) for (const e of fresh.feed) bySig.set(e.sig, e);
  const events = [...bySig.values()].sort((a, b) => (b.time || 0) - (a.time || 0));

  // Totals derived from the full event log (never double-counted).
  const sum = (t, f) => events.filter((e) => e.type === t).reduce((s, e) => s + (e[f] || 0), 0);
  const count = (t) => events.filter((e) => e.type === t).length;

  const [supply, price] = await Promise.all([getSupply().catch(() => null), getPrice()]);
  const prevStats = await readJson(STATS, {});
  const curSupply = supply ?? prevStats.supply ?? null;

  // Burned = dev-wallet burns since the campaign cutoff (not the raw supply delta).
  const devBurns = events.filter((e) => e.type === "burn" && (e.time || 0) >= BURN_SINCE);
  const burnedTotal = devBurns.reduce((s, e) => s + (e.summer || 0), 0);

  const buybackSummer = sum("buyback", "summer");
  const ansemSummer = sum("ansem", "summer");

  // Feed always includes every burn + every Ansem transfer, plus the newest buybacks,
  // so no burn is ever hidden below the cap.
  const burnsE = events.filter((e) => e.type === "burn");
  const ansemE = events.filter((e) => e.type === "ansem");
  const buyE = events.filter((e) => e.type === "buyback").slice(0, 40);
  const feed = [...burnsE, ...ansemE, ...buyE].sort((a, b) => (b.time || 0) - (a.time || 0));

  const stats = {
    updatedAt: process.env.BUILD_TIME || new Date().toISOString(),
    price,
    supply: curSupply,
    burnedSince: BURN_SINCE,
    burned: {
      amount: Math.round(burnedTotal),
      pct: Number(((burnedTotal / INITIAL_SUPPLY) * 100).toFixed(3)),
      usd: Number((burnedTotal * price).toFixed(2)),
      count: devBurns.length,
    },
    buyback: {
      summer: Math.round(buybackSummer),
      sol: Number(sum("buyback", "sol").toFixed(4)),
      usd: Number((buybackSummer * price).toFixed(2)),
      count: count("buyback"),
    },
    ansem: {
      summer: Math.round(ansemSummer),
      usd: Number((ansemSummer * price).toFixed(2)),
      count: count("ansem"),
    },
    feed,
  };

  await writeFile(EVENTS, JSON.stringify(events) + "\n");
  await writeFile(STATS, JSON.stringify(stats, null, 2) + "\n");
  console.log(`events:${events.length} buyback:${stats.buyback.summer}(${stats.buyback.count}) ` +
    `burned:${stats.burned.amount} ansem:${stats.ansem.summer}(${stats.ansem.count})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
