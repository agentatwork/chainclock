#!/usr/bin/env node
'use strict';
/**
 * pin2.js — tell a second clock apart from an eth_call convention.
 *
 * Twelve chains report block.number exactly one ahead of the head even when the call is
 * pinned to a fixed block. There are two very different explanations:
 *
 *   (a) the chain really has a second clock, one block off  — implausible, but testable
 *   (b) the node executes eth_call in the block AFTER the one you pinned, i.e. it builds
 *       a pending block on top of N and runs there, so block.number is N+1
 *
 * They are distinguishable in one shot: pin the same call at N and at N-16. Under (b) the
 * answers are N+1 and N-15 — the result tracks the tag exactly, offset by one. Under (a),
 * or on an Orbit chain where block.number is the parent's height, the two answers do not
 * move in lockstep with the tag.
 *
 * Run against the whole confirmed set, not just the +1 chains: the Arbitrum family is the
 * control group, and it should fail the lockstep test loudly.
 */
const fs = require('fs');
const path = require('path');

const PROBE_CODE = '0x4360005260206000f3';
const PROBE_ADDR = '0x00000000000000000000000000000000000b10c1';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BACK = 16n;

const n = (hex) => {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex) || hex === '0x') return null;
  try { const v = BigInt(hex); return v > 0n ? v : null; } catch { return null; }
};

async function post(url, payload, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'chainclock/1.0 (+https://agentatwork.xyz/chainclock/)' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

const callAt = (tag) => ([
  { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PROBE_ADDR, data: '0x' }, tag, { [PROBE_ADDR]: { code: PROBE_CODE } }] },
  { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x42cbb15c' }, tag] },
]);

async function lockstep(url) {
  const h = n((await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }))?.result);
  if (h === null) throw new Error('no head');
  const a = h, b = h - BACK;
  // Both tags in one request, so a moving head cannot influence the comparison.
  const j = await post(url, [...callAt('0x' + a.toString(16)).map((r, i) => ({ ...r, id: 10 + i })),
                             ...callAt('0x' + b.toString(16)).map((r, i) => ({ ...r, id: 20 + i }))]);
  const by = new Map(j.map((r) => [r.id, r]));
  const at = (base) => n(by.get(base)?.result) ?? n(by.get(base + 1)?.result);
  const [va, vb] = [at(10), at(20)];
  if (va === null || vb === null) throw new Error('block.number unreadable at one of the tags');
  return {
    head: a, atHead: va, atHeadMinus16: vb,
    delta: va - vb,                       // BACK if the answer tracks the tag, ~0 if it does not
    offsetHead: va - a, offsetBack: vb - b,
    tracksTag: va - vb === BACK && va - a === vb - b,
  };
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'confirmed.json'), 'utf8'))
    .filter((r) => r.pinnedSkew !== undefined && r.pinnedSkew !== '0');
  console.log(`lockstep test on ${rows.length} chains: does block.number follow the block tag?\n`);
  console.log('  chainId       name                            skew@head   Δ(tag−16→tag)   verdict');

  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < rows.length) {
      const c = rows[i++];
      try {
        const r = await lockstep(c.rpc);
        out.push({ chainId: c.chainId, name: c.name, arbsys: !!c.arbBlockNumberPinned, ...r,
          head: r.head.toString(), atHead: r.atHead.toString(), atHeadMinus16: r.atHeadMinus16.toString(),
          delta: r.delta.toString(), offsetHead: r.offsetHead.toString(), offsetBack: r.offsetBack.toString() });
      } catch (e) { out.push({ chainId: c.chainId, name: c.name, arbsys: !!c.arbBlockNumberPinned, error: String(e.message || e).slice(0, 50) }); }
    }
  }));

  out.sort((a, b) => (Math.abs(Number(a.offsetHead || 0)) - Math.abs(Number(b.offsetHead || 0))));
  for (const r of out) {
    if (r.error) { console.log(`  ${String(r.chainId).padStart(11)}  ${(r.name || '').slice(0, 30).padEnd(30)}  ${r.error}`); continue; }
    const verdict = r.tracksTag ? `eth_call runs in block tag${Number(r.offsetHead) >= 0 ? '+' : ''}${r.offsetHead}` : 'independent of the tag → second clock';
    console.log(`  ${String(r.chainId).padStart(11)}  ${(r.name || '').slice(0, 30).padEnd(30)}  ${String(r.offsetHead).padStart(12)}  ${String(r.delta).padStart(12)}   ${verdict}`);
  }
  fs.writeFileSync(path.join(__dirname, 'lockstep.json'), JSON.stringify(out, null, 1));
  const ok = out.filter((r) => !r.error);
  console.log(`\ntracks the tag (an eth_call convention, not a chain property): ${ok.filter((r) => r.tracksTag).length}`);
  console.log(`independent of the tag (a real second clock):                  ${ok.filter((r) => !r.tracksTag).length}`);
})();
