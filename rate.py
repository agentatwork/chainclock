#!/usr/bin/env python3
"""Measure the ADVANCE RATE of block.number against the true local block height.

The skew alone is harmless -- a contract that only reports block.number shows a big
number and nothing breaks. What breaks a per-block reward schedule or a
`block.number + N` timeout is a difference in how fast the two clocks tick. So sample
both over a real window and divide.

  local head          eth_blockNumber                (true Degen height)
  block.number        eth_call getBlockNumber() to a deployed multicall
  ArbSys.arbBlockNumber  0xa3b1b31d on 0x...0064     (documented L2 height)
"""
import json, time, urllib.request

RPC = "https://rpc.degen.tips"
# The NUMBER opcode itself, injected at a dead address via state override. Chosen after
# ArbMulticall2.getBlockNumber() returned the LOCAL height: that contract is Arbitrum's
# fork of Multicall2 and deliberately routes through ArbSys.arbBlockNumber(). A contract
# whose source mentions block.number may still not expose it through the function you call.
PROBE = "0x00000000000000000000000000000000DeaDBeef"
CODE = "0x4360005260206000f3"   # NUMBER; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN
ARBSYS = "0x0000000000000000000000000000000000000064"


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1,
                       "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body,
                                 {"Content-Type": "application/json",
                                  "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    if "error" in d:
        raise RuntimeError(d["error"])
    return d["result"]


def sample():
    head = int(rpc("eth_blockNumber", []), 16)
    bn = int(rpc("eth_call", [{"to": PROBE, "data": "0x"}, "latest",
                              {PROBE: {"code": CODE}}]), 16)
    arb = int(rpc("eth_call", [{"to": ARBSYS, "data": "0xa3b1b31d"}, "latest"]), 16)
    return time.time(), head, bn, arb


rows = []
for i in range(25):
    try:
        rows.append(sample())
    except Exception as e:
        print("skip:", e, flush=True)
        time.sleep(15)
        continue
    t, h, b, a = rows[-1]
    print(f"{i:3d} head={h} block.number={b} arbBlockNumber={a} "
          f"skew={b-h}", flush=True)
    if len(rows) >= 2:
        dt = rows[-1][0] - rows[0][0]
        if dt > 0:
            print(f"      over {dt:6.1f}s: head {(h-rows[0][1])/dt:7.3f} blk/s   "
                  f"block.number {(b-rows[0][2])/dt:7.3f} blk/s   "
                  f"arbBlockNumber {(a-rows[0][3])/dt:7.3f} blk/s", flush=True)
    time.sleep(15)

json.dump([{"t": t, "head": h, "blockNumber": b, "arbBlockNumber": a}
           for t, h, b, a in rows], open("rate.json", "w"), indent=1)
dt = rows[-1][0] - rows[0][0]
print(f"\nWINDOW {dt:.1f}s")
print(f"  true local height   {(rows[-1][1]-rows[0][1])/dt:.4f} blocks/s")
print(f"  block.number        {(rows[-1][2]-rows[0][2])/dt:.4f} blocks/s")
print(f"  ArbSys.arbBlockNumber {(rows[-1][3]-rows[0][3])/dt:.4f} blocks/s")
print(f"  RATIO block.number : local = "
      f"{(rows[-1][2]-rows[0][2])/max(1,(rows[-1][1]-rows[0][1])):.3f}")
