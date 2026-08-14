#!/usr/bin/env node
'use strict';
/**
 * scan.js — ask every public chain what block it thinks it is on, twice.
 *
 * `eth_blockNumber` is what a node tells an off-chain process. `block.number` is what a
 * contract sees. On most chains those are the same number. On Arbitrum Nitro and every
 * Orbit L3 built on it they are not, and nothing warns you: a contract that stamps
 * block.number, compared against eth_blockNumber by an indexer, produces a confirmation
 * depth that is wrong by millions of blocks in either direction.
 *
 * Four probes per chain, in one JSON-RPC batch — one HTTP request per endpoint:
 *
 *   1. eth_blockNumber                        the node's own head
 *   2. eth_call with a 9-byte state override   block.number, needing no deployment
 *   3. Multicall3.getBlockNumber()             block.number again, where 2 is unsupported
 *   4. ArbSys(0x64).arbBlockNumber()           the chain's own height on Arbitrum family
 *
 * Nothing here writes to a chain, sends a transaction, or costs anyone anything beyond one
 * read. Endpoints come from ethereum-lists/chains, which publishes them for public use.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'results.json');
const CONCURRENCY = Number(process.env.CONCURRENCY || 24);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 12000);
const RPCS_PER_CHAIN = 4;

// NUMBER, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN. Nine bytes, no PUSH0, so it also
// runs on chains whose EVM predates Shanghai.
const PROBE_CODE = '0x4360005260206000f3';
const PROBE_ADDR = '0x00000000000000000000000000000000000b10c1';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ARBSYS = '0x0000000000000000000000000000000000000064';

const body = [
  { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: PROBE_ADDR, data: '0x' }, 'latest', { [PROBE_ADDR]: { code: PROBE_CODE } }] },
  { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x42cbb15c' }, 'latest'] },
  { jsonrpc: '2.0', id: 4, method: 'eth_call', params: [{ to: ARBSYS, data: '0xa3b1b31d' }, 'latest'] },
];

const num = (hex) => {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex) || hex === '0x') return null;
  try { const v = BigInt(hex); return v > 0n ? v : null; } catch { return null; }
};

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'chainclock/1.0 (+https://agentatwork.xyz/chainclock/)' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: 'http ' + res.status };
    const j = await res.json();
    if (!Array.isArray(j)) return { error: 'not a batch response' };
    const by = new Map(j.map((r) => [r.id, r]));
    const head = num(by.get(1)?.result);
    if (head === null) return { error: 'no eth_blockNumber' };
    return {
      head,
      override: num(by.get(2)?.result),   // block.number via state override
      multicall: num(by.get(3)?.result),  // block.number via Multicall3
      arbsys: num(by.get(4)?.result),     // the chain's own height, Arbitrum family only
    };
  } catch (e) {
    return { error: (e.name === 'AbortError' ? 'timeout' : String(e.message || e)).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

async function scanChain(c) {
  const urls = (c.rpc || [])
    .filter((u) => u.startsWith('https://') && !u.includes('${') && !u.includes('API_KEY'))
    .slice(0, RPCS_PER_CHAIN);
  const row = { chainId: c.chainId, name: c.name, shortName: c.shortName, parent: c.parent?.chain || null, rpcTried: urls.length };
  for (const url of urls) {
    const r = await probe(url);
    if (r.error) { row.error = r.error; continue; }
    // The state override is the probe that works everywhere; Multicall3 is the fallback
    // for nodes that reject overrides, and agrees with it wherever both answer.
    const contractBlock = r.override ?? r.multicall;
    delete row.error;
    Object.assign(row, {
      rpc: url.replace(/\/+$/, ''),
      head: r.head.toString(),
      contractBlock: contractBlock === null ? null : contractBlock.toString(),
      via: r.override !== null ? 'override' : (r.multicall !== null ? 'multicall3' : null),
      arbBlockNumber: r.arbsys === null ? null : r.arbsys.toString(),
      skew: contractBlock === null ? null : (contractBlock - r.head).toString(),
      // Both probes answered and disagreed: worth knowing about, since it would mean the
      // override is being simulated against a different state than the deployed call.
      probesDisagree: r.override !== null && r.multicall !== null && r.override !== r.multicall,
    });
    return row;
  }
  return row;
}

(async () => {
  const chains = JSON.parse(fs.readFileSync(path.join(__dirname, 'chains.json'), 'utf8'))
    .filter((c) => (c.rpc || []).some((u) => u.startsWith('https://') && !u.includes('${') && !u.includes('API_KEY')));
  console.log(`${chains.length} chains with a usable https RPC; concurrency ${CONCURRENCY}`);

  const results = [];
  let i = 0, done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < chains.length) {
      const c = chains[i++];
      results.push(await scanChain(c));
      if (++done % 100 === 0) process.stdout.write(`  ${done}/${chains.length}\n`);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.chainId - b.chainId);
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

  const live = results.filter((r) => r.head);
  const measured = live.filter((r) => r.skew !== null && r.skew !== undefined);
  const skewed = measured.filter((r) => r.skew !== '0');
  console.log(`\nreachable: ${live.length}/${chains.length}`);
  console.log(`block.number readable: ${measured.length}`);
  console.log(`block.number != eth_blockNumber: ${skewed.length}`);
  for (const r of skewed.slice(0, 40)) {
    console.log(`  ${String(r.chainId).padStart(12)} ${(r.name || '').slice(0, 34).padEnd(34)} skew ${r.skew}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
