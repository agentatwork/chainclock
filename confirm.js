#!/usr/bin/env node
'use strict';
/**
 * confirm.js — second pass over the chains the first pass flagged.
 *
 * The first pass asks for eth_blockNumber and evaluates block.number in the same JSON-RPC
 * batch, both against "latest". Those are two different moments: on a fast chain the head
 * advances between them, and the result is a skew of ±1 or ±2 that is a race, not a
 * property of the chain. Sixty-odd of the first pass's ninety-eight hits look exactly like
 * that.
 *
 * This pass removes the race. It reads the head, then evaluates block.number pinned to that
 * exact block rather than to "latest", so both numbers describe one moment. A chain whose
 * clocks really do differ still differs; a chain that was merely racing now reads zero.
 *
 * Every candidate is probed three times and must be consistent to count.
 */
const fs = require('fs');
const path = require('path');

const PROBE_CODE = '0x4360005260206000f3';
const PROBE_ADDR = '0x00000000000000000000000000000000000b10c1';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ARBSYS = '0x0000000000000000000000000000000000000064';
const TIMEOUT_MS = 15000;
const ROUNDS = 3;

const n = (hex) => {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex) || hex === '0x') return null;
  try { const v = BigInt(hex); return v > 0n ? v : null; } catch { return null; }
};

async function post(url, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'chainclock/1.0 (+https://agentatwork.xyz/chainclock/)' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** One race-free measurement: read the head, then evaluate block.number pinned to it. */
async function measure(url) {
  const h = await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  const head = n(h?.result);
  if (head === null) throw new Error('no eth_blockNumber');
  const tag = '0x' + head.toString(16);
  const j = await post(url, [
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PROBE_ADDR, data: '0x' }, tag, { [PROBE_ADDR]: { code: PROBE_CODE } }] },
    { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x42cbb15c' }, tag] },
    { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: ARBSYS, data: '0xa3b1b31d' }, tag] },
  ]);
  if (!Array.isArray(j)) throw new Error('not a batch response');
  const by = new Map(j.map((r) => [r.id, r]));
  const contract = n(by.get(1)?.result) ?? n(by.get(2)?.result);
  if (contract === null) throw new Error('block.number unreadable at a pinned block');
  return { head, contract, arbsys: n(by.get(3)?.result), skew: contract - head };
}

(async () => {
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));
  const candidates = all.filter((r) => r.skew !== undefined && r.skew !== null && r.skew !== '0');
  console.log(`re-probing ${candidates.length} candidates, ${ROUNDS} rounds each, pinned to a fixed block\n`);

  const out = [];
  let i = 0;
  const workers = Array.from({ length: 12 }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      const rounds = [];
      let err = null;
      for (let k = 0; k < ROUNDS; k++) {
        try { rounds.push(await measure(c.rpc)); }
        catch (e) { err = String(e.message || e).slice(0, 60); break; }
      }
      if (rounds.length < ROUNDS) { out.push({ ...c, confirmed: null, confirmError: err }); continue; }
      const skews = rounds.map((r) => r.skew);
      const stable = skews.every((s) => s === skews[0]);
      out.push({
        ...c,
        pinnedSkew: skews[0].toString(),
        pinnedSkews: skews.map(String),
        stable,
        // A real clock difference is large and identical across rounds. A racing chain
        // showed ±1 in pass one and reads exactly zero once the call is pinned.
        confirmed: stable && skews[0] !== 0n,
        arbBlockNumberPinned: rounds[0].arbsys === null ? null : rounds[0].arbsys.toString(),
        arbMatchesHead: rounds[0].arbsys !== null ? rounds[0].arbsys === rounds[0].head : null,
      });
    }
  });
  await Promise.all(workers);

  out.sort((a, b) => a.chainId - b.chainId);
  fs.writeFileSync(path.join(__dirname, 'confirmed.json'), JSON.stringify(out, null, 1));

  const real = out.filter((r) => r.confirmed);
  const race = out.filter((r) => r.confirmed === false && r.pinnedSkew === '0');
  const unstable = out.filter((r) => r.confirmed === false && r.pinnedSkew !== '0');
  const failed = out.filter((r) => r.confirmed === null);
  console.log(`confirmed real skew:  ${real.length}`);
  console.log(`race in pass one (pinned skew is 0): ${race.length}`);
  console.log(`unstable across rounds: ${unstable.length}`);
  console.log(`could not re-probe: ${failed.length}\n`);
  for (const r of real.sort((a, b) => Math.abs(Number(b.pinnedSkew)) - Math.abs(Number(a.pinnedSkew)))) {
    console.log(`  ${String(r.chainId).padStart(12)}  ${(r.name || '').slice(0, 32).padEnd(32)} ` +
      `${String(r.pinnedSkew).padStart(13)}  ${r.arbBlockNumberPinned ? 'ArbSys' : '—'}`);
  }
})();
