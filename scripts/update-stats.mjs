// Solana Summer $SUMMER — live on-chain stats builder.
// Runs in GitHub Actions on a cron. Writes ../data/stats.json.
//
// Tracks:
//   burned   = INITIAL_SUPPLY - current mint supply
//   buyback  = SUMMER bought (SOL spent) by the dev wallet via swaps
//   ansem    = SUMMER (and SOL) sent from dev wallet -> Ansem wallet
//
// Data source: Helius (needs HELIUS_API_KEY secret). Falls back to a public
// RPC for supply only, so the burn number still works without a key.

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "stats.json");

const MINT = "3AtR8x9UCzDYneRSx93pQLK5uFsr57iLbopMtHPEpump";
const DEV = "BXrU6jcjtZnar27jfWCXXhr9EqQGcFvyfnpC9cRjYLmC";
const ANSEM = "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52";
const INITIAL_SUPPLY = 1_000_000_000;

const KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const HELIUS_TX = (addr, before) =>
  `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${KEY}&limit=100${before ? `&before=${before}` : ""}`;

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`${method} ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function getSupply() {
  const url = HELIUS_RPC || PUBLIC_RPC;
  const res = await rpc(url, "getTokenSupply", [MINT]);
  return res.value.uiAmount;
}

async function getPrice() {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${MINT}`,
      { headers: { accept: "application/json" } }
    );
    const j = await r.json();
    const p = j.pairs && j.pairs[0];
    return p ? Number(p.priceUsd) : 0;
  } catch {
    return 0;
  }
}

// Walk the dev wallet's FULL parsed history via Helius enhanced-tx API.
// Aggregates all-time totals AND collects an itemized event feed.
async function scanDevWallet() {
  const out = {
    buybackSummer: 0, buybackSol: 0, buybackCount: 0,
    burnSummer: 0, burnCount: 0,
    ansemSummer: 0, ansemSol: 0, ansemCount: 0,
    feed: [],           // every individual event, newest first
  };
  if (!KEY) return out; // no key -> can't read parsed history; burns still work

  let before = undefined;
  let pages = 0;
  const MAX_PAGES = 100; // 100 * 100 = 10,000 txns cap (full history)

  while (pages < MAX_PAGES) {
    const r = await fetch(HELIUS_TX(DEV, before));
    if (!r.ok) throw new Error(`helius tx ${r.status}`);
    const txns = await r.json();
    if (!Array.isArray(txns) || txns.length === 0) break;

    for (const tx of txns) {
      const tt = tx.tokenTransfers || [];
      const nt = tx.nativeTransfers || [];
      const sig = tx.signature;
      const time = tx.timestamp; // unix seconds

      // Burn: SUMMER leaving the dev wallet via a burn instruction.
      const burned = tt
        .filter((t) => t.mint === MINT && t.fromUserAccount === DEV &&
          (t.toUserAccount == null || t.toUserAccount === "" || tx.type === "BURN"))
        .reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
      if (tx.type === "BURN" && burned > 0) {
        out.burnSummer += burned; out.burnCount += 1;
        out.feed.push({ type: "burn", time, summer: Math.round(burned), sig });
      }

      // Buyback: a SWAP where SUMMER lands in the dev wallet.
      if (tx.type === "SWAP") {
        const bought = tt
          .filter((t) => t.mint === MINT && t.toUserAccount === DEV)
          .reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
        if (bought > 0) {
          const solIn = Number(tx.events?.swap?.nativeInput?.amount || 0) / 1e9;
          out.buybackSummer += bought; out.buybackCount += 1; out.buybackSol += solIn;
          out.feed.push({ type: "buyback", time, summer: Math.round(bought), sol: Number(solIn.toFixed(4)), sig });
        }
      }

      // Ansem: SUMMER or SOL sent from dev wallet -> Ansem wallet.
      const toAnsemSummer = tt
        .filter((t) => t.mint === MINT && t.fromUserAccount === DEV && t.toUserAccount === ANSEM)
        .reduce((s, t) => s + Number(t.tokenAmount || 0), 0);
      const toAnsemSol = nt
        .filter((t) => t.fromUserAccount === DEV && t.toUserAccount === ANSEM)
        .reduce((s, t) => s + Number(t.amount || 0) / 1e9, 0);
      if (toAnsemSummer > 0 || toAnsemSol > 0) {
        if (toAnsemSummer > 0) { out.ansemSummer += toAnsemSummer; out.ansemCount += 1; }
        if (toAnsemSol > 0) out.ansemSol += toAnsemSol;
        out.feed.push({ type: "ansem", time, summer: Math.round(toAnsemSummer), sol: Number(toAnsemSol.toFixed(4)), sig });
      }
    }

    before = txns[txns.length - 1].signature;
    pages += 1;
    if (txns.length < 100) break;
  }

  out.feed.sort((a, b) => (b.time || 0) - (a.time || 0));
  return out;
}

async function main() {
  const [supply, price, dev] = await Promise.all([
    getSupply().catch(() => null),
    getPrice(),
    scanDevWallet().catch((e) => { console.error("dev scan failed:", e.message); return null; }),
  ]);

  // Preserve prior values if a source failed this run.
  let prev = {};
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

  const currentSupply = supply ?? prev.supply ?? null;
  const burned = currentSupply != null ? INITIAL_SUPPLY - currentSupply : (prev.burned?.amount ?? 0);

  const buyback = dev && dev.buybackCount > 0 ? {
    summer: Math.round(dev.buybackSummer),
    sol: Number(dev.buybackSol.toFixed(4)),
    usd: Number((dev.buybackSummer * price).toFixed(2)),
    count: dev.buybackCount,
  } : (prev.buyback ?? { summer: 0, sol: 0, usd: 0, count: 0 });

  const ansem = dev && (dev.ansemCount > 0 || dev.ansemSol > 0) ? {
    summer: Math.round(dev.ansemSummer),
    sol: Number(dev.ansemSol.toFixed(4)),
    usd: Number((dev.ansemSummer * price).toFixed(2)),
    count: dev.ansemCount,
  } : (prev.ansem ?? { summer: 0, sol: 0, usd: 0, count: 0 });

  // Keep the newest 40 events for the on-site activity feed.
  const feed = dev && dev.feed.length ? dev.feed.slice(0, 40) : (prev.feed ?? []);

  const stats = {
    updatedAt: process.env.BUILD_TIME || new Date().toISOString(),
    price,
    supply: currentSupply,
    burned: {
      amount: Math.round(burned),
      pct: Number(((burned / INITIAL_SUPPLY) * 100).toFixed(3)),
      usd: Number((burned * price).toFixed(2)),
      count: dev && dev.burnCount ? dev.burnCount : (prev.burned?.count ?? 0),
    },
    buyback,
    ansem,
    feed,
  };

  await writeFile(OUT, JSON.stringify(stats, null, 2) + "\n");
  console.log("wrote stats.json:", JSON.stringify(stats));
}

main().catch((e) => { console.error(e); process.exit(1); });
