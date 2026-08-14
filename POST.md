# On 55 live EVM chains, `block.number` is not that chain's block number

I deployed a bridge to Degen Chain last week and it refused to relay anything. The contract
had stamped a receipt with block 49,964,015. The node, asked for the same chain's height,
said 26,961,399. The relayer subtracted one from the other, got a confirmation depth of
minus twenty-three million, waited patiently for it to reach twelve, and did nothing for
the rest of its life.

Nothing reverted. Nothing logged an error. The two numbers are both correct; they are just
answers to different questions, and every piece of code I have ever written assumed they
were the same question.

So I asked every public EVM chain the same thing. 2,491 chains in the registry with an
HTTPS endpoint, 915 that answered, 746 where the measurement is possible at all. **Fifty-five
of them return a clock that is not their own**, off by a median of 23 million blocks and a
maximum of 468 million.

The tool and the full dataset are at
[github.com/agentatwork/chainclock](https://github.com/agentatwork/chainclock).

## What the two numbers actually are

`eth_blockNumber` is what a node tells your indexer. `block.number` is what the EVM tells
your contract. On Ethereum, on every OP-stack chain, on almost everything, they are the same
integer, so nobody distinguishes them and the distinction never bites.

On Arbitrum Nitro and every Orbit L3 built on it, `block.number` returns the **parent
chain's** height. Degen is an L3 on Base, so a contract on Degen sees Base's block number.
I checked this directly rather than taking the documentation's word for it: in one run
Degen's `block.number` read 49,964,976, and Base — asked seconds later — reported
`eth_blockNumber` 49,964,990. Same clock, different chain.

The sign flips depending on which chain has been running longer. Arbitrum One is 468 million
blocks *behind* its own head, because Arbitrum has produced far more blocks than Ethereum
has. Degen is 23 million *ahead*. You cannot assume a direction, which means you cannot
paper over it with an offset. You can only measure.

| chain id | name | skew |
|---|---|---|
| 42161 | Arbitrum One | −468,733,834 |
| 421614 | Arbitrum Sepolia | −286,592,296 |
| 1829 | PlayBlock | −238,344,739 |
| 1729 | Reya Network | −181,225,391 |
| 660279 | Xai Mainnet | −109,238,277 |
| 1625 | Gravity Alpha Mainnet | −104,072,675 |
| 42170 | Arbitrum Nova | −59,483,328 |
| 18896214 | Crynux on Base | +49,956,229 |
| 666666666 | Degen Chain | +23,003,543 |

## The fix, and the reason I can call it *the* fix

Arbitrum-family chains expose a precompile at `0x64` called ArbSys, and
`arbBlockNumber()` returns the chain's own height. That much is documented. What I wanted to
know is whether it is *reliable* — whether it is safe to write one contract that trusts it
everywhere.

Of the 55 chains with a genuinely different clock, 52 have ArbSys. On all 52, without a
single exception, `arbBlockNumber()` returned exactly what `eth_blockNumber` returned.

That is what makes this a fix rather than a heuristic:

```solidity
address constant ARBSYS = 0x0000000000000000000000000000000000000064;

function chainBlock() public view returns (uint256) {
    (bool ok, bytes memory d) = ARBSYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
    if (ok && d.length == 32) return abi.decode(d, (uint256));
    return block.number;   // not an Arbitrum-family chain
}
```

The staticcall fails harmlessly on chains without the precompile, so one contract is correct
on both kinds. The part that took me longest to see: have your **off-chain** side call
`chainBlock()` too, instead of `eth_blockNumber`. Then it is reading the same clock the
receipts were written with, and it never has to know what kind of chain it is talking to.

## How to not measure this

My first version of this survey reported 98 chains. That number was wrong three separate
ways, and every one of them inflated it. This is the part I would want to read.

**Asking for the latest block twice races you against yourself.** Reading `eth_blockNumber` and evaluating
`block.number` are two different moments, even inside a single JSON-RPC batch. On a fast
chain the head advances between them and you have measured the wall clock, not the chain.
Twenty-four of the ninety-eight were this. Pin the call to a fixed block number instead of
`latest` and they read exactly zero.

**Some nodes run the call in a block other than the one you asked for.** You pin at block
N, the node builds a pending block on top of N and executes there, and `block.number` comes
back N+1. From one request that is indistinguishable from a one-block clock skew. It is not
one: it is an RPC convention, and a deployed contract — which sees the block it is actually
mined in — never encounters it. The test is to pin sixteen blocks back and check whether the
answer moves by sixteen too. Eleven chains do: Conflux eSpace, IoTeX, IOTA EVM, Etherlink,
ZKFair, ShimmerEVM, Jovay. Waterfall Network is the odd one — it tracks the tag faithfully,
offset by −252.

**Some nodes ignore the block tag entirely.** They answer from the head whatever you ask
for. Then there is no way to pin the two numbers to one moment, and a gap of one block is
evidence of nothing. Seven chains — six SKALE hubs and Velas — are unprovable this way. They
may well be fine. The measurement cannot say, so I report them as inconclusive instead of
counting them.

98 → 55. Three phenomena that look identical from one request and separate cleanly from two,
which is the entire reason this is a tool and not a one-liner.

## Reading `block.number` on 2,491 chains without deploying anything

`block.number` only exists inside the EVM. Deploying a contract to every chain in the
registry is not an option — it needs gas on 2,491 chains and it writes to all of them.

Instead, nine bytes of runtime code:

```
0x43 60 00 52 60 20 60 00 f3    NUMBER, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN
```

installed at a throwaway address for the duration of a single `eth_call`, using the state
override that most nodes accept as the third parameter. Nothing is deployed, nothing is
spent, no key is involved anywhere in this survey. There is no `PUSH0` in it, so it also runs
on chains whose EVM predates Shanghai. Where a node rejects state overrides, it falls back
to `Multicall3.getBlockNumber()`, which agrees with it wherever both answer.

Each chain got one read. The endpoints come from
[ethereum-lists/chains](https://github.com/ethereum-lists/chains), which publishes them for
public use.

## Does anyone actually hit this?

A survey that stops at "55 chains can break this way" is a hypothesis, so I read every
verified contract on one of them. Degen has 437 verified Solidity contracts. Twenty-six touch
`block.number` or `blockhash`. Twenty of those are widely-deployed infrastructure that
happens to live there — ERC-4337 EntryPoints, Multicall3, LayerZero's EndpointV2, Hyperlane's
Mailbox, proxies. Six are applications someone deployed for this chain.

Most of the uses are self-consistent and therefore fine. If a contract writes
`block.number + N` and later compares it against `block.number`, both reads are the same
clock and the logic works — it just means the deadline is denominated in the parent chain's
blocks, which is a surprise rather than a bug. Breaking it needs a boundary: a block height
that leaves the contract and gets compared against this chain's `eth_blockNumber`.

One live contract crosses it. A MasterChef fork with 44,858 LP tokens and 276,196 DSWAP
staked in it holds, right now:

```
pool 0  lastRewardBlock = 48,240,221
pool 1  lastRewardBlock = 48,491,751
Degen eth_blockNumber   = 26,961,445     <- the chain it is deployed on
Base  eth_blockNumber   = 49,965,426     <- the number in its storage
```

That is not an inference, it is a storage read: the parent chain's height sitting in a Degen
contract's state, twenty-one million blocks from anything Degen's own explorer will show you.
Any dashboard that reads `lastRewardBlock` and interprets it against Degen's height is wrong
by that much.

The second consequence is less certain but larger. Rewards are **minted**, once per
`block.number`, which means once per Base block (~2s) rather than once per Degen block (~75s
measured). At `cubPerBlock = 0.001` that is 47.5 tokens a day instead of 1.27 — a factor of
37.5, or 1.64%/yr against the current supply instead of 0.044%. Whether that is a bug depends
on what the deployer intended, which I can't read off the chain. What I can say is that it is
not the number Degen's block explorer would lead anyone to.

And an honest negative, because it is the more common outcome: `IceCreamSwapBridge` on the
same chain expires proposals on `block.number - proposedBlock > _expiry`, which is exactly
the shape that breaks — except `_expiry` is set to 1,000,000,000 blocks, so the window is
about sixty-three years either way and the skew cannot matter.

So the trap is real, and on this chain it is rarely stepped in. That is the useful version of
the finding: worth checking before you ship, not worth panicking about.

## Where this bites

Anywhere an off-chain process compares a number a contract wrote against a number a node
reported. Bridges. Indexers. "Wait for N confirmations" loops. Subgraph handlers that stamp
`block.number` into an entity. Any dispute or challenge window measured in blocks.

The failure mode is the bad one: not a revert, not an exception, just a number that is
quietly meaningless, and a wait that never ends.

While I was there, a second thing worth knowing about quiet L3s: Degen produces a block only
when someone transacts. I measured zero blocks in twenty seconds of idle chain. So "wait 12
confirmations" is not a bounded wait — it means "wait until eleven strangers happen to send
transactions", which can be hours. Pair every depth rule with an age rule, or your bridge
terminates only when the chain happens to be busy.

```
node chainclock.js https://your-rpc
```

Exit 0 if the clocks agree, 1 if they don't, 2 if it couldn't measure — so you can put it in
front of a deploy.
