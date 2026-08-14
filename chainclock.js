#!/usr/bin/env node
'use strict';
/**
 * chainclock — does `block.number` mean what you think it means on this chain?
 *
 *   node chainclock.js https://rpc.degen.tips
 *   node chainclock.js https://mainnet.base.org --json
 *
 * A contract sees `block.number`. Your indexer sees `eth_blockNumber`. On most chains those
 * are the same value, so people write code that compares one against the other and it works
 * — until it is pointed at an Arbitrum Nitro chain or an Orbit L3, where `block.number` is
 * the PARENT chain's height and the two differ by millions of blocks in either direction.
 * Nothing reverts. The comparison just silently produces a confirmation depth that is
 * wrong, and code that waits for it waits forever.
 *
 * Read-only: three small JSON-RPC requests, no transaction, no deployment, no key.
 *
 * Exit 0 the clocks agree · 1 they do not · 2 the chain could not be measured.
 */

// NUMBER, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN — returns block.number. Nine bytes and
// no PUSH0, so it also runs on chains whose EVM predates Shanghai. Installed only for the
// duration of one eth_call via a state override: nothing is deployed and nothing is spent.
const PROBE_CODE = '0x4360005260206000f3';
const PROBE_ADDR = '0x00000000000000000000000000000000000b10c1';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ARBSYS = '0x0000000000000000000000000000000000000064';
const BACK = 16n;

const n = (hex) => {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex) || hex === '0x') return null;
  try { const v = BigInt(hex); return v > 0n ? v : null; } catch { return null; }
};

async function post(url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** block.number, eth_chainId, ArbSys and the block hash, all evaluated at one fixed block. */
const probesAt = (tag, base) => ([
  { jsonrpc: '2.0', id: base + 0, method: 'eth_call', params: [{ to: PROBE_ADDR, data: '0x' }, tag, { [PROBE_ADDR]: { code: PROBE_CODE } }] },
  { jsonrpc: '2.0', id: base + 1, method: 'eth_call', params: [{ to: MULTICALL3, data: '0x42cbb15c' }, tag] },
  { jsonrpc: '2.0', id: base + 2, method: 'eth_call', params: [{ to: ARBSYS, data: '0xa3b1b31d' }, tag] },
  { jsonrpc: '2.0', id: base + 3, method: 'eth_getBlockByNumber', params: [tag, false] },
]);

async function inspect(url, timeoutMs = 15000) {
  // Read the head first, then evaluate everything pinned to that exact block. Asking for
  // "latest" twice is two different moments: on a fast chain the head moves between them and
  // you get a phantom skew of one or two blocks that belongs to the clock on the wall, not
  // to the chain. Sixty per cent of a naive survey's hits are that artefact.
  const h = await post(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, timeoutMs);
  const head = n(h?.result);
  if (head === null) throw new Error(h?.error?.message || 'no eth_blockNumber');

  const back = head > BACK * 2n ? head - BACK : head;
  const j = await post(url, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    ...probesAt('0x' + head.toString(16), 10),
    ...probesAt('0x' + back.toString(16), 20),
  ], timeoutMs);
  if (!Array.isArray(j)) throw new Error('endpoint does not support JSON-RPC batches');
  const by = new Map(j.map((r) => [r.id, r]));
  const blockNumberAt = (base) => n(by.get(base)?.result) ?? n(by.get(base + 1)?.result);
  const hashAt = (base) => by.get(base + 3)?.result?.hash || null;

  const atHead = blockNumberAt(10);
  const atBack = blockNumberAt(20);
  const chainId = n(by.get(1)?.result);
  return {
    rpc: url,
    chainId: chainId === null ? null : Number(chainId),
    ethBlockNumber: head,
    blockNumber: atHead,
    via: n(by.get(10)?.result) !== null ? 'state override' : (n(by.get(11)?.result) !== null ? 'Multicall3' : null),
    arbBlockNumber: n(by.get(12)?.result),
    // Evidence for telling the three explanations apart, below.
    probeBack: back, blockNumberBack: atBack,
    nodeHasHistory: !!(hashAt(10) && hashAt(20) && (head === back || hashAt(10) !== hashAt(20))),
  };
}

/**
 * Three different things produce a non-zero skew, and only one of them is a chain property.
 * Separating them needs the second, older block: if block.number moves in lockstep with the
 * tag, the node is simply executing the call in a block other than the one you named, and a
 * deployed contract never sees it. If it does not move at all, the node is answering from
 * the head regardless of what you asked, and the measurement proves nothing either way.
 */
function classify(r) {
  const skew = r.blockNumber - r.ethBlockNumber;
  if (skew === 0n) return { kind: 'agree', skew };
  if (r.blockNumberBack !== null && r.ethBlockNumber !== r.probeBack) {
    const moved = r.blockNumber - r.blockNumberBack;
    const tagMoved = r.ethBlockNumber - r.probeBack;
    if (moved === tagMoved) return { kind: 'call-convention', skew };
    if (moved === 0n && !r.arbBlockNumber && (skew < 0n ? -skew : skew) < 1000n && r.nodeHasHistory) {
      return { kind: 'node-ignores-tag', skew };
    }
  }
  return { kind: 'two-clocks', skew };
}

const FIX = [
  '  address constant ARBSYS = 0x0000000000000000000000000000000000000064;',
  '  function chainBlock() public view returns (uint256) {',
  '      (bool ok, bytes memory d) = ARBSYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));',
  '      if (ok && d.length == 32) return abi.decode(d, (uint256));',
  '      return block.number;   // not an Arbitrum-family chain',
  '  }',
].join('\n');

async function main() {
  const url = process.argv.find((a) => a.startsWith('http'));
  if (!url) {
    console.error('usage: chainclock <rpc-url> [--json]\n\n' +
      'Reports whether block.number inside a contract equals eth_blockNumber on this chain.');
    process.exit(2);
  }

  let r;
  try { r = await inspect(url); }
  catch (e) { console.error('could not reach the chain: ' + (e.message || e)); process.exit(2); }

  if (r.blockNumber === null) {
    console.error('the node answered eth_blockNumber but neither probe could read block.number:\n' +
      '  it rejects eth_call state overrides, and has no Multicall3 at ' + MULTICALL3 + '.\n' +
      '  Deploy any contract returning block.number and compare by hand.');
    process.exit(2);
  }

  const { kind, skew } = classify(r);
  const mag = (skew < 0n ? -skew : skew).toLocaleString();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, skew, kind, agree: kind === 'agree' },
      (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    process.exit(kind === 'two-clocks' ? 1 : 0);
  }

  console.log(`chain ${r.chainId ?? '?'} via ${r.rpc}`);
  console.log(`  eth_blockNumber        ${r.ethBlockNumber}   (what your indexer sees)`);
  console.log(`  block.number           ${r.blockNumber}   (what a contract sees, read via ${r.via})`);
  if (r.arbBlockNumber !== null) {
    console.log(`  ArbSys.arbBlockNumber  ${r.arbBlockNumber}   (this chain's own height)`);
  }

  if (kind === 'agree') {
    console.log('\nThe clocks agree. block.number is this chain\'s own height, and comparing it');
    console.log('against eth_blockNumber is safe here.');
    process.exit(0);
  }

  if (kind === 'call-convention') {
    console.log(`\nOff by ${mag}, but this node executes eth_call in a block other than the one you`);
    console.log('name: pinned 16 blocks back, block.number moved by exactly 16 too. That is an');
    console.log('RPC convention, not a property of the chain. A deployed contract sees the block');
    console.log('it is actually mined in, and comparing block.number against eth_blockNumber is');
    console.log('safe here — but simulations and gas estimates are off by the same amount.');
    process.exit(0);
  }

  if (kind === 'node-ignores-tag') {
    console.log(`\nOff by ${mag}, but this node answers from the head no matter which block you ask`);
    console.log('for, so the two numbers cannot be pinned to one moment and a gap this small');
    console.log('proves nothing. Inconclusive: measure against an archive node before trusting it.');
    process.exit(0);
  }

  const ahead = skew > 0n;
  console.log(`\nThe clocks DISAGREE by ${mag} blocks, and it is the chain, not the RPC:`);
  console.log('pinned 16 blocks back, block.number did not follow the tag.');
  console.log(`block.number is ${ahead ? 'AHEAD OF' : 'BEHIND'} this chain's own head, because it reports the`);
  console.log('parent chain\'s height, not this one\'s.');
  console.log('\nSo a contract that stamps block.number, compared by an off-chain process against');
  console.log(`eth_blockNumber, yields a depth that is wrong by ${mag}. Nothing reverts; the`);
  console.log('comparison is just meaningless, and code waiting on it waits forever.');
  if (r.arbBlockNumber !== null) {
    console.log('\nThis chain has ArbSys. Publish this from your contract and compare against THAT:\n');
    console.log(FIX);
    console.log('\nThe fallback makes one contract correct on both kinds of chain.');
  } else {
    console.log('\nNo ArbSys here, so there is no in-contract way to read this chain\'s own height.');
    console.log('Stamp block.timestamp instead and compare against wall-clock time off-chain.');
  }
  process.exit(1);
}

if (require.main === module) main();
module.exports = { inspect, classify, PROBE_CODE };
