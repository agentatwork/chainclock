#!/usr/bin/env python3
"""Is the LayerZero grace-period finding hypothetical, or is a timeout actually set?

DISCLOSURE.md lists EndpointV2 on Degen under DURATION because
`timeout.expiry = block.number + _gracePeriod` is later compared against `block.number`.
Both reads are the same clock, so the logic is self-consistent -- the deviation is that the
window is denominated in the PARENT chain's blocks. On Degen that is ~2s per block instead
of ~75s, so a grace period is ~40x shorter in wall-clock than a local-block reading implies.

That is worth reporting only if a timeout is ever actually set. So read the chain.
"""
import json, time, urllib.request

RPC = "https://rpc.degen.tips"
EP = "0x1a44076050125825900e736c501f859c50fE728c"
SUPPORTED = "0x6750cd4c"   # isSupportedEid(uint32)
TIMEOUT   = "0x6e83f5bb"   # defaultReceiveLibraryTimeout(uint32)
RECVLIB   = "0x6f50a803"   # defaultReceiveLibrary(uint32)

_id = [0]
def rpc(method, params):
    _id[0] += 1
    req = urllib.request.Request(
        RPC, json.dumps({"jsonrpc": "2.0", "id": _id[0],
                         "method": method, "params": params}).encode(),
        {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    for attempt in range(6):
        try:
            d = json.loads(urllib.request.urlopen(req, timeout=25).read())
            break
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503):
                raise
            time.sleep(1.5 * (attempt + 1))   # public endpoint, back off rather than hammer
    else:
        raise RuntimeError("rate limited after 6 attempts")
    time.sleep(0.12)
    if "error" in d:
        raise RuntimeError(d["error"])
    return d["result"]

def call(sel, eid):
    return rpc("eth_call", [{"to": EP, "data": sel + hex(eid)[2:].rjust(64, "0")}, "latest"])

head = int(rpc("eth_blockNumber", []), 16)
bn = int(rpc("eth_call", [{"to": "0x00000000000000000000000000000000DeaDBeef", "data": "0x"},
                          "latest",
                          {"0x00000000000000000000000000000000DeaDBeef":
                           {"code": "0x4360005260206000f3"}}]), 16)
print(f"Degen head {head:,}   block.number {bn:,}   skew {bn-head:,}\n")

found, supported = [], []
for eid in range(30101, 30400):
    try:
        if int(call(SUPPORTED, eid), 16) != 1:
            continue
    except Exception:
        continue
    supported.append(eid)
    raw = call(TIMEOUT, eid)[2:]
    lib = "0x" + raw[24:64]
    expiry = int(raw[64:128], 16)
    lib2 = "0x" + call(RECVLIB, eid)[26:]
    print(f"eid {eid}: recvLib {lib2}  timeout.lib {lib}  expiry {expiry:,}")
    if expiry:
        found.append((eid, lib, expiry))

print(f"\n{len(supported)} supported eids; {len(found)} with a non-zero timeout expiry")
for eid, lib, e in found:
    rem_parent = e - bn
    print(f"  eid {eid}: expiry {e:,} -> {rem_parent:,} parent blocks left "
          f"= {rem_parent*2/3600:.1f} h wall-clock, but {rem_parent/0.0162/86400:.0f} days "
          f"if read as local blocks")
json.dump({"head": head, "block_number": bn, "supported": supported,
           "timeouts": found}, open("lz.json", "w"), indent=1)
