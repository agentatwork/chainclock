#!/usr/bin/env python3
"""Turn the Degen block.number survey into something disclosable.

The survey (degen.usage.json) answers "which verified contracts mention block.number".
That is not the question a disclosure has to answer, which is "which ones does it
actually break, and how". Two corrections separate the two:

  1. COMMENTS. 7 of the 26 contracts have every sampled hit inside a doc comment, and
     all 7 are ERC-4337 account-abstraction contracts carrying the same upstream line:
         * Note that the validation code cannot use block.timestamp (or block.number)
     The scanner counted the warning as the offence. A naive grep over-counts by 27%
     here, and the entire over-count is one comment that says "do not use this".

  2. WHAT THE USE IS FOR. block.number being a different number is harmless when it is
     only reported. It matters when the contract relies on one of two properties that
     do not hold on Degen:
         UNIQUE   -- one block.number value per block. Measured false: twelve
                     consecutive local blocks at height 5,000,000 all read 13,048,713.
         LOCAL    -- it counts this chain's blocks. Measured false: it tracks a parent
                     counter that advances while Degen produces no blocks at all.

Categories, and whether each is a finding:

  comment      not code                                            not a finding
  cosmetic     reported in an event or a view helper               not a finding
  entropy      blockhash used as randomness                        pre-existing, any chain
  duration     block-denominated timeout / reward accrual          needs LOCAL
  identity     used as a key or a same-block guard                 needs UNIQUE

Only `duration` and `identity` are disclosable, and they are disclosable for different
reasons. Run after chainclock's scan:

  python3 classify.py
"""
import json
from collections import Counter

# Assigned by reading the sampled line, not by pattern-matching the contract name.
# Keyed by address so the mapping is auditable against degen.usage.json line by line.
CATEGORY = {
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032": ("comment",  "ERC-4337 EntryPoint: both hits are the upstream 'cannot use block.number' warning"),
    "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789": ("comment",  "ERC-4337 EntryPoint v0.6: same upstream warning"),
    "0x000100abaad02f1cfC8Bbe32bD5a564817339E72": ("comment",  "CoinbaseSmartWallet: vendored IAccount.sol comment"),
    "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a": ("comment",  "CoinbaseSmartWalletFactory: vendored IAccount.sol comment"),
    "0x72eeFC6dDa79f2D79A5B46BC1BBa5c7b4bc80C0a": ("comment",  "thirdweb Account: vendored IAccount.sol comment"),
    "0x777777777777AeC03fd955926DbF81597e66834C": ("comment",  "SingletonPaymasterV7: vendored IPaymaster.sol comment"),
    "0xBD0334AC7FADA28CcD27Fa09838e9EA4c39117Db": ("comment",  "VerifyingPaymasterV7: vendored IPaymaster.sol comment"),

    "0x4D19de9408Ec93BC50b87d185365e52771Edf714": ("cosmetic", "Multicall3: returns blockNumber/blockHash to the caller"),
    "0x5304b5DbBfCe2fb40AE11Ed51E70699FC1F25fC9": ("cosmetic", "ArbMulticall2: source mentions it, but getBlockNumber() routes via ArbSys and returned the LOCAL height when called"),
    "0xF058Eb3C946F0eaeCa3e6662300cb01165c64edE": ("cosmetic", "ClonableBeaconProxy -> MulticallV2 rpc-utils"),
    "0xc38292bebBbF691FC3d2733f17E529e6405Bd9d6": ("cosmetic", "ClonableBeaconProxy -> MulticallV2 rpc-utils"),
    "0xECF3365559FfE5fdBE1953df0A01244e234e4453": ("cosmetic", "OnChainCounter: block.number only inside emitted events"),
    "0x4Ed7d626f1E96cD1C0401607Bf70D95243E3dEd1": ("cosmetic", "Hyperlane Mailbox: deployedBlock marker + indexing hint"),
    "0x644f250d0890F8c6986aDbCC3f9E7D925903529b": ("cosmetic", "RockPaperScissors: single hit, packed into an event argument list"),
    "0x0000000000Bf54A35f528D67c62145161B25C55C": ("entropy",  "N2MERC721NS: blockhash(block.number-1) mixed into mint randomness"),

    "0x1a44076050125825900e736c501f859c50fE728c": ("duration", "LayerZero EndpointV2: timeout.expiry = block.number + gracePeriod, then compared"),
    "0x3D4440F335060a0341C9E6C3bBeE85E552505FFF": ("duration", "IceCreamSwapBridge: proposal expiry as uint40 block delta"),
    "0xe3584Ce2A3f7c2983B45eb3D37CD959c8587bd87": ("duration", "MasterChef (Cub fork): reward accrual per block.number delta"),
    "0x2f2aFaE1139Ce54feFC03593FeE8AB2aDF4a85A7": ("duration", "Hyperlane ServiceManager: block.number >= comparison for unbonding"),
    "0xEb9FcFDC9EfDC17c1EC5E1dc085B98485da213D6": ("duration", "StaticAggregationHookFactory: same ServiceManager code"),

    "0x071B36BcE6A1e1693A864B933275Fc3775FC7cC9": ("identity", "ERC20VotesUpgradeable: checkpoint key, and require(clock() == block.number)"),
    "0x77722fa8a43DFcC3E01C1dB0b150b9Db9d1e53dd": ("identity", "DegenDog: OZ Time.sol blockNumber clock -> checkpoint key"),
    "0x9c0dF4b950ca19Db6fEC13ab79aD180a9C15a41E": ("identity", "SwapRouter02: require(blockhash(block.number-1) == previousBlockhash) same-block guard"),

    "0x000000000066093407b6704B89793beFfD0D8F00": ("identity", "LSP14Ownable2Step: currentBlock recorded to gate a two-step transfer"),
    "0x0000005aD606bcFEF9Ea6D0BbE5b79847054BcD7": ("identity", "LSP14Ownable2Step: same"),
    "0x3024D38EA2434BA6635003Dc1BDC0daB5882ED4F": ("identity", "LSP14Ownable2Step: same"),
}

NEEDS = {"comment": "-", "cosmetic": "-", "entropy": "-",
         "duration": "LOCAL", "identity": "UNIQUE"}
DISCLOSABLE = {"duration", "identity"}

# Category says the pattern is present; it does not say the deployment can be hurt by it.
# Checked individually and cleared, with the reason. Kept in the table rather than
# quietly dropped, because "we looked and it was fine" is the part surveys omit.
NOT_MATERIAL = {
    "0x3D4440F335060a0341C9E6C3bBeE85E552505FFF":
        "_expiry is 1e9 blocks -- the deadline cannot be reached on any clock",
}


def is_comment(line):
    s = line.strip()
    return s.startswith("*") or s.startswith("//") or s.startswith("/*")


def main():
    survey = json.load(open("degen.usage.json"))
    by_addr = {c["address"]: c for c in survey}

    missing = set(by_addr) - set(CATEGORY)
    extra = set(CATEGORY) - set(by_addr)
    if missing:
        raise SystemExit(f"unclassified: {sorted(missing)}")
    if extra:
        raise SystemExit(f"classified but not in survey: {sorted(extra)}")

    # Cross-check the comment calls against the actual sampled text rather than
    # trusting the table: a hand-made mapping is exactly the kind of thing that rots.
    for addr, (cat, _) in CATEGORY.items():
        sample = by_addr[addr]["sample"]
        allc = sample and all(is_comment(s[2]) for s in sample)
        if allc and cat != "comment":
            raise SystemExit(f"{addr} is all-comment but classified {cat}")
        if cat == "comment" and not allc:
            raise SystemExit(f"{addr} classified comment but has code hits")

    counts = Counter(c for c, _ in CATEGORY.values())
    total_hits = sum(c["hits"] for c in survey)
    print(f"{len(survey)} verified Degen contracts, {total_hits} raw hits\n")

    for cat in ("comment", "cosmetic", "entropy", "duration", "identity"):
        rows = [(a, w) for a, (c, w) in CATEGORY.items() if c == cat]
        cleared = sum(1 for a, _ in rows if a in NOT_MATERIAL)
        mark = "  <= DISCLOSABLE" if cat in DISCLOSABLE else ""
        note = f", {cleared} cleared" if cleared else ""
        print(f"{cat.upper():9s} {counts[cat]:2d} contracts{note}   "
              f"needs {NEEDS[cat]}{mark}")
        for a, w in sorted(rows):
            print(f"    {a}  {w}")
            if a in NOT_MATERIAL:
                print(f"        CLEARED: {NOT_MATERIAL[a]}")
        print()

    real = len(survey) - counts["comment"]
    disc = sum(counts[c] for c in DISCLOSABLE) - len(NOT_MATERIAL)
    print(f"survey headline           {len(survey)} contracts use block.number")
    print(f"after removing comments   {real} ({counts['comment']} were the "
          f"'do not use block.number' warning itself, "
          f"{counts['comment']/len(survey)*100:.0f}% over-count)")
    cl = Counter(CATEGORY[a][0] for a in NOT_MATERIAL)
    print(f"pattern present           {sum(counts[c] for c in DISCLOSABLE)} "
          f"({counts['duration']} rely on it counting local blocks, "
          f"{counts['identity']} rely on it being unique per block)")
    print(f"actually load-bearing     {disc} after clearing "
          f"{len(NOT_MATERIAL)} on configuration "
          f"({counts['duration'] - cl['duration']} duration, "
          f"{counts['identity'] - cl['identity']} identity)")


if __name__ == "__main__":
    main()
