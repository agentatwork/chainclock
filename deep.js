'use strict';
/**
 * deep.js — does this node honour the block tag at all?
 *
 * The lockstep test moves the tag by 16 blocks. If a node has no historical state it will
 * answer from the live head no matter what you ask for, and the answer will not move — which
 * looks exactly like "an independent second clock" but is only a node without an archive.
 * Ten chains landed there with a skew too small to settle by magnitude. Moving the tag by
 * 10,000 blocks tells them apart: a node that honours the tag must move; one that ignores it
 * cannot.
 */
const PROBE_CODE = '0x4360005260206000f3';
const PROBE_ADDR = '0x00000000000000000000000000000000000b10c1';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const n = (h) => (typeof h === 'string' && /^0x[0-9a-fA-F]+$/.test(h) && h !== '0x' ? BigInt(h) : null);
async function post(url, p) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), signal: c.signal });
        if (!r.ok) throw new Error('http ' + r.status); return await r.json(); } finally { clearTimeout(t); }
}
const targets = require('./lockstep.json').filter((r) => !r.error && !r.tracksTag && !r.arbsys);
const byId = new Map(require('./results.json').map((r) => [r.chainId, r]));
(async () => {
  for (const c of targets) {
    const url = byId.get(c.chainId).rpc;
    try {
      const head = n((await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).result);
      const back = head > 20000n ? head - 10000n : head / 2n;
      const mk = (tag, base) => ([
        { jsonrpc: '2.0', id: base, method: 'eth_call', params: [{ to: PROBE_ADDR, data: '0x' }, tag, { [PROBE_ADDR]: { code: PROBE_CODE } }] },
        { jsonrpc: '2.0', id: base + 1, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x42cbb15c' }, tag] },
        // A value that must change with the tag if the node has the history: the block hash.
        { jsonrpc: '2.0', id: base + 2, method: 'eth_getBlockByNumber', params: [tag, false] },
      ]);
      const j = await post(url, [...mk('0x' + head.toString(16), 10), ...mk('0x' + back.toString(16), 20)]);
      const by = new Map(j.map((r) => [r.id, r]));
      const bn = (b) => n(by.get(b)?.result) ?? n(by.get(b + 1)?.result);
      const hash = (b) => by.get(b + 2)?.result?.hash || null;
      const moved = bn(10) !== null && bn(20) !== null && bn(10) !== bn(20);
      const hasHistory = hash(10) && hash(20) && hash(10) !== hash(20);
      console.log(`${String(c.chainId).padStart(11)}  ${(c.name || '').slice(0, 28).padEnd(28)}  ` +
        `block.number@head ${String(bn(10)).padStart(11)}  @head-10000 ${String(bn(20)).padStart(11)}  ` +
        `moved=${moved ? 'yes' : 'NO '}  node-has-that-block=${hasHistory ? 'yes' : 'NO '}  ` +
        `=> ${!hasHistory ? 'inconclusive (no history)' : moved ? 'honours the tag; skew is real' : 'IGNORES the tag; skew unproven'}`);
    } catch (e) { console.log(`${String(c.chainId).padStart(11)}  ${(c.name || '').slice(0, 28).padEnd(28)}  error: ${String(e.message).slice(0, 40)}`); }
  }
})();
