# `block.number` on Degen Chain: what it actually breaks

Defensive write-up. No exploit code, no unpublished contract is named, and every contract
listed here is already public and verified on the Degen explorer. The point is to let
deployers check their own code, so the finding is stated as two properties you can test
rather than as a technique.

## Summary

On Degen Chain (id 666666666), `block.number` does not return Degen's block height. It
returns the parent chain's counter. `ArbSys.arbBlockNumber()` returns the real local
height.

That alone is well-known Arbitrum/Orbit behaviour and is not the finding. **Neither is the
non-uniqueness below — it is documented upstream**, and I want that stated before the
measurements rather than after. Arbitrum's own
[block numbers and time](https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time)
page carries a worked example in which `block.number` stays at 1000 while the chain's own
height advances 370000 → 370008, and it points you at `ArbSys.arbBlockNumber()` for a value
that increments once per block. What it does not do is state the consequence as a *safety*
property, and nothing connects it to code that is already deployed.

So the contribution here is not the behaviour. It is: measured on a specific live chain,
quantified, and mapped onto the contracts that actually depend on it. The two *properties*
Solidity code routinely assumes are both false here, they fail for different reasons, and
they break different contracts:

| property | what code assumes | measured on Degen |
|---|---|---|
| **LOCAL** | it counts this chain's blocks | false — it advanced **~40×** faster than Degen's own height (0.700 vs 0.017 blocks/s over 354 s), and keeps advancing while Degen produces no blocks at all |
| **UNIQUE** | one value per block | false — **twelve consecutive blocks** at height 5,000,000 all report `13048713` |

Of the 26 verified contracts the survey flagged, **11** carry a pattern that depends on one
of these, and **9** survive a check of the individual deployment. The other 15: seven
never used `block.number` at all (it was a comment), seven use it cosmetically, and one
uses `blockhash` for randomness, which is unsound on every chain and not specific to this
one.

## How to reproduce

The probe is the `NUMBER` opcode itself, injected at a dead address via `eth_call` state
override — nine bytes, no deployment, and nothing to misread:

```bash
curl -s -X POST https://rpc.degen.tips -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"eth_call","params":[
    {"to":"0x00000000000000000000000000000000DeaDBeef","data":"0x"},"latest",
    {"0x00000000000000000000000000000000DeaDBeef":{"code":"0x4360005260206000f3"}}]}'
```

`0x4360005260206000f3` is `NUMBER; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN`.

Compare against `eth_blockNumber` and against `ArbSys.arbBlockNumber()`
(`0x...0064`, selector `0xa3b1b31d`). Measured 2026-08-15:

```
local head (eth_blockNumber)   26,962,468
block.number (NUMBER opcode)   49,995,774      skew 23,033,306
ArbSys.arbBlockNumber()        26,962,468      == local head exactly
```

**Do not use a deployed multicall as the probe.** `ArbMulticall2`
(`0x5304b5DbBfCe2fb40AE11Ed51E70699FC1F25fC9`) mentions `block.number` in its source, but
`getBlockNumber()` returned the *local* height when called — that contract is Arbitrum's
fork of Multicall2 and deliberately routes through `ArbSys`. Grepping source tells you a
contract mentions `block.number`; it does not tell you what the function you call returns.
That mistake would have inverted this entire result.

### Rate, over a real window

Sampling all three clocks every 15 s (`rate.py`):

```
window 369.6 s, 25 samples
  local height           0.0162 blocks/s
  block.number           0.6710 blocks/s     ratio 41.3x
  ArbSys.arbBlockNumber  0.0162 blocks/s     tracks local exactly, as documented
```

Most 15 s samples show the local height unchanged and `block.number` up by tens. That is
the failure in one line: **the clock advances while the chain does not.**

The ratio is **not a constant**, which is the part that catches people. Reading
`block.number` at historical local heights:

| local height | `block.number` |
|---:|---:|
| 1 | 11,649,096 |
| 1,348,123 | 12,594,664 |
| 6,740,616 | 13,266,480 |
| 13,481,232 | 14,115,933 |
| 20,221,848 | 15,130,514 |
| 26,962,465 | 49,995,729 |

Degen produced ~20.2 M blocks in its first months and ~6.7 M in the two years since, while
the parent ticked steadily at ~0.5 /s. So the parent-to-local ratio was well **below 1**
at launch — many Degen blocks per `block.number` value — and is ~40 today. A contract
tuned when the chain was busy is running on a different clock now.

The parent is Base, confirmed directly in the earlier survey by reading both heads seconds
apart (Degen `block.number` 49,964,976 vs Base `eth_blockNumber` 49,964,990). Base's ~2 s
cadence and its height at Degen's genesis both match the table above.

## The 27 % over-count, and why it is worth stating

The survey's headline was "26 verified contracts use `block.number`". Seven of those have
**every** hit inside a doc comment, and all seven carry the same upstream line:

```solidity
*      Note that the validation code cannot use block.timestamp (or block.number) directly.
```

They are ERC-4337 contracts — both `EntryPoint` deployments, `CoinbaseSmartWallet` and its
factory, thirdweb's `Account`, and two paymasters — vendoring `IAccount.sol` /
`IPaymaster.sol`. The scanner counted the warning as the offence. **The single most
prominent "user" of `block.number` on this chain is a comment telling you not to use it.**

I am stating this because I published the 26 figure first, and because any grep-based
survey of Solidity has the same defect: account abstraction is widely deployed, the
comment is in every copy, and it inflates exactly the contracts that look most alarming in
a headline.

## What is actually affected

`classify.py` assigns each contract a category from its sampled line, and asserts the
comment calls against the source text so the table cannot silently rot.

```
26 verified contracts, 117 raw hits
  COMMENT   7   not code                                    not a finding
  COSMETIC  7   reported in an event or a view helper        not a finding
  ENTROPY   1   blockhash as randomness                      pre-existing on any chain
  DURATION  5   needs LOCAL                                  affected (2 cleared)
  IDENTITY  6   needs UNIQUE                                 affected
```

### DURATION — 5 contracts, rely on it counting local blocks; 3 affected

A block-denominated deadline or accrual rate. Because the parent keeps ticking while Degen
is idle, these advance on wall-clock time rather than on local activity.

- `0xe3584Ce2A3f7c2983B45eb3D37CD959c8587bd87` MasterChef (Cub fork) — reward accrual per
  `block.number` delta. **Already reported** in the original chainclock write-up and the
  /degen cast: 44,858 LP + 276,196 DSWAP staked, `lastRewardBlock` 48,240,221 against a
  Degen head of 26,961,445; minting per ~2 s parent block instead of per ~75 s local
  block, i.e. 47.5 DSWAP/day where the configuration implies 1.27 (1.64 %/yr vs 0.044 %).
  Repeated here only so the category has a worked example — it is not a new finding.
- `0x2f2aFaE1139Ce54feFC03593FeE8AB2aDF4a85A7`, `0xEb9FcFDC9EfDC17c1EC5E1dc085B98485da213D6`
  Hyperlane `ServiceManager` — `block.number >=` gate on unbonding

**Cleared, not affected.** Two, and both only because the *deployment* was checked rather
than the pattern. Listed rather than dropped, because "we checked and it was fine" is the
part surveys leave out.

- `0x3D4440F335060a0341C9E6C3bBeE85E552505FFF` IceCreamSwapBridge has the identical `uint40`
  block-delta expiry pattern, but `_expiry` is `1e9` blocks — the deadline is unreachable on
  any clock, so the pattern cannot hurt it.
- `0x1a44076050125825900e736c501f859c50fE728c` LayerZero `EndpointV2` sets
  `timeout.expiry = block.number + _gracePeriod` and later compares it against
  `block.number`, which is the shape that misdenominates a grace window — on this chain a
  period sized in local blocks would expire roughly 40× sooner in wall-clock than intended.
  **But the path is never entered here.** `lz.py` walks every endpoint id this deployment
  reports via `isSupportedEid`, and all **148** return `defaultReceiveLibraryTimeout` with
  `expiry = 0`. No receive-library timeout has ever been set on Degen, so there is no live
  grace window to misdenominate.

  I checked this specifically because I was about to report it upstream, and I want to be
  plain about the result: it would have been a false report to a busy security team. The
  same rule that produced the comment over-count produced this — **a pattern in the source
  is a hypothesis about the deployment, not a finding about it** — and it is now the second
  contract this document has had to withdraw on those grounds. Grep proposes; the chain
  disposes.

Note the direction is not uniformly "faster". A MasterChef forked from a chain whose block
time matched the parent's will emit at close to the intended *wall-clock* rate — arguably
more correct than counting local blocks. What changes is emission per unit of local
activity, and that has moved by more than two orders of magnitude over the chain's life.
Operators should check the constant they configured, not assume a direction.

### IDENTITY — 6 contracts, rely on it being unique per block

This is the sharper one, because "same block" stops meaning "same block".

- `0x9c0dF4b950ca19Db6fEC13ab79aD180a9C15a41E` `SwapRouter02` —
  `require(blockhash(block.number - 1) == previousBlockhash)`. This is a caller-supplied
  guard asserting the transaction lands in a specific block. Its granularity is now as
  coarse as the number of local blocks sharing one `block.number` — up to 12 in the window
  measured, so the guard covers a span of real blocks rather than one.
- `0x071B36BcE6A1e1693A864B933275Fc3775FC7cC9` `ERC20VotesUpgradeable` — checkpoint key,
  plus `require(clock() == block.number, "ERC20Votes: broken clock mode")`. When several
  local blocks share a key, only the last write in that span survives in history, so
  intermediate balances are not queryable.
- `0x77722fa8a43DFcC3E01C1dB0b150b9Db9d1e53dd` DegenDog — OpenZeppelin `Time.sol`
  `blockNumber` clock feeding the same checkpoint machinery
- `0x000000000066093407b6704B89793beFfD0D8F00`, `0x0000005aD606bcFEF9Ea6D0BbE5b79847054BcD7`,
  `0x3024D38EA2434BA6635003Dc1BDC0daB5882ED4F` LSP14 `Ownable2Step` — records
  `currentBlock` to gate a two-step ownership transfer

**What this is not.** I am not claiming novelty — Arbitrum documents the behaviour, as
noted at the top — and I am not claiming a live exploit against any of these. A same-key
span does not by itself defeat OpenZeppelin Governor, which requires the snapshot to be
strictly in the past and so rejects the naive flash-delegate. The claim is narrower and
testable: these contracts were written against a guarantee this chain does not provide,
and any code whose safety argument contains the phrase "in the same block" needs that
argument re-checked here. Whether a given deployment is exploitable depends on its
configuration, and the deployer is better placed than I am to answer that.

## For deployers

- Use `ArbSys.arbBlockNumber()` when you need this chain's height. It matched exactly, at
  every sample.
- Prefer `block.timestamp` for durations. It is monotonic and local.
- For OpenZeppelin `Votes`, override `clock()` / `CLOCK_MODE` to timestamp mode
  (`mode=timestamp`) rather than leaving the default block-number mode.
- If a safety property depends on "one action per block", key it on something that is
  actually unique per block.

## Reproducing everything here

```
python3 rate.py        # samples all three clocks, writes rate.json
python3 classify.py    # the 26 -> 19 -> 11 -> 9 funnel, with comment assertions
python3 lz.py          # reads every supported eid's receive-library timeout on EndpointV2
```

Survey data in `degen.usage.json`; the 98-chain scan that found Degen is in
`confirmed.json` and `README.md`.
