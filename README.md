# chainclock

**On 55 live EVM chains, `block.number` inside a contract is not that chain's block number.**
It is the parent chain's height, off by a median of 23 million blocks and a maximum of 468
million. Nothing reverts. Code that compares it against `eth_blockNumber` to get a
confirmation depth just gets a wrong number, and code that waits on that depth waits forever.

```
node chainclock.js https://rpc.degen.tips
```
```
chain 666666666 via https://rpc.degen.tips
  eth_blockNumber        26961433   (what your indexer sees)
  block.number           49964976   (what a contract sees, read via state override)
  ArbSys.arbBlockNumber  26961433   (this chain's own height)

The clocks DISAGREE by 23,003,543 blocks, and it is the chain, not the RPC:
pinned 16 blocks back, block.number did not follow the tag.
...
This chain has ArbSys. Publish this from your contract and compare against THAT:

  address constant ARBSYS = 0x0000000000000000000000000000000000000064;
  function chainBlock() public view returns (uint256) {
      (bool ok, bytes memory d) = ARBSYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
      if (ok && d.length == 32) return abi.decode(d, (uint256));
      return block.number;   // not an Arbitrum-family chain
  }
```

No install, no key, no transaction, no deployment. Exit 0 if the clocks agree, 1 if they
don't, 2 if the chain couldn't be measured — so it drops into CI in front of a deploy.

## The survey

Every chain in [ethereum-lists/chains](https://github.com/ethereum-lists/chains) with a
public HTTPS RPC, measured 2026-08-14:

| | |
|---|---:|
| chains with a usable HTTPS endpoint | 2,491 |
| answered at all | 915 |
| `block.number` readable | 746 |
| **a genuinely different clock** | **55** |
| of those, have ArbSys | 52 |
| of those 52, `arbBlockNumber()` == `eth_blockNumber` | **52 — every one** |

That last row is the useful part. The fix isn't a heuristic: on all 52 Arbitrum-family
chains, without a single exception, `ArbSys.arbBlockNumber()` returned exactly the chain's
own head. One `staticcall` with a fallback is correct everywhere, and you don't need to know
what kind of chain you're on to use it.

Full data in [`chains.report.json`](chains.report.json), the 55 in [`TABLE.md`](TABLE.md).
Worst offenders:

| chain id | name | skew |
|---:|---|---:|
| 42161 | Arbitrum One | −468,733,834 |
| 421614 | Arbitrum Sepolia | −286,592,296 |
| 1829 | PlayBlock | −238,344,739 |
| 1729 | Reya Network | −181,225,391 |
| 44474237230 | Deriw Devnet | −131,557,513 |
| 660279 | Xai Mainnet | −109,238,277 |
| 1625 | Gravity Alpha Mainnet | −104,072,675 |
| 46630 | Robinhood Chain Testnet | −89,641,485 |
| 98866 | Plume Mainnet | −61,461,643 |
| … | | |
| 18896214 | Crynux on Base | +49,956,229 |
| 666666666 | Degen Chain | +23,003,543 |

The sign flips depending on whether the L3 or its parent has been running longer, which is
why "is it ahead or behind" is not a thing you can assume — only measure.

It really is the parent's height, not an offset: in the run above Degen's `block.number`
read 49,964,976 while Base — Degen's parent — answered `eth_blockNumber` 49,964,990 a few
seconds later. Same clock.

## How to not measure this

The first version of this survey reported **98** chains. That number was wrong three
separate ways, and every one of them inflates the result:

**Ask for `latest` twice and you race yourself.** Reading `eth_blockNumber` and evaluating
`block.number` are two different moments, even inside one JSON-RPC batch. On a fast chain the
head moves between them and you record a skew of ±1 that belongs to the clock on the wall.
**24 of the 98 were this** — they read exactly zero once the call was pinned to a fixed
block, which is what this tool now does.

**Some nodes execute `eth_call` in a block other than the one you name.** Pin the call at
block N and they build a pending block on top and run there, so `block.number` is N+1. It
looks identical to a one-block clock skew. It isn't: it's an RPC convention, a deployed
contract never sees it, and the test is to pin 16 blocks back and check whether the answer
moves by 16 too. **11 chains** do exactly that — Conflux eSpace, IoTeX, IOTA EVM, Etherlink,
ZKFair, ShimmerEVM, Jovay. Waterfall Network is the strange one: it tracks the tag faithfully
but offset by −252.

**Some nodes ignore the block tag entirely**, answering from the head whatever you ask for.
Then the two numbers can't be pinned to one moment, and a gap of one block proves nothing in
either direction. **7 chains** — six SKALE hubs and Velas — are unprovable this way, so
they're reported as inconclusive rather than counted. They may be fine; the measurement
can't say.

98 → 55. The three things look the same from one request and are only distinguishable from
two, which is the whole reason this is a tool and not a one-liner.

## Why it matters

You hit this the moment an off-chain process compares a number a contract wrote against a
number a node reported. That is most bridges, most indexers, most "wait for N
confirmations" loops, most subgraph handlers that stamp `block.number` into an entity, and
every dispute window measured in blocks.

The failure is silent and it is not a revert. On Degen a relayer computes a confirmation
depth of *minus 23 million*, waits for it to reach 12, and relays nothing, ever. Found by
deploying [a real bridge](https://github.com/agentatwork/degen-base-nft-bridge) to Degen and
watching it do exactly that.

Two things that follow, if you're writing this code:

- Stamp `chainBlock()`, not `block.number`, and have your off-chain side read the same
  function rather than `eth_blockNumber`. Then it never needs to know what chain it's on.
- Depth alone doesn't terminate on a quiet L3. Degen produces a block only when someone
  transacts — measured zero blocks in twenty seconds idle — so "wait 12 confirmations" means
  "wait for eleven strangers." Pair every depth rule with an age rule.

## How the probe works

`block.number` is only visible from inside the EVM, and deploying a contract on 2,491 chains
to find out is not an option. So: nine bytes of runtime code

```
0x43 60 00 52 60 20 60 00 f3     NUMBER, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN
```

installed at a throwaway address for the duration of a single `eth_call` via a **state
override**. Nothing is deployed, nothing is spent, no key is involved. No `PUSH0`, so it runs
on pre-Shanghai EVMs too. Where a node rejects state overrides, it falls back to
`Multicall3.getBlockNumber()` at `0xcA11bde05977b3631167028862bE2a173976CA11`, which returns
the same value where both answer.

## Files

```
chainclock.js   the tool: measure one chain, classify, print the fix
scan.js         sweep every chain in the registry -> results.json
confirm.js      re-probe the hits with the call pinned to a fixed block
pin2.js         pin 16 blocks back: an RPC convention, or a real second clock?
deep.js         pin 10,000 back: does this node honour the tag at all?
chains.report.json  the final classified dataset
TABLE.md        the 55, sorted by magnitude
```

Reproduce: `curl -o chains.json https://chainid.network/chains.json && node scan.js &&
node confirm.js && node pin2.js`. Endpoints come from a list published for public use, one
read each, and nothing writes to any chain.

MIT.
