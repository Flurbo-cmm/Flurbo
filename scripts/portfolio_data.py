"""Bounded, restartable pool-event discovery with block-pinned balance verification.

The cache is an optimization, not an ownership ledger. A restart rescans from
deployment; incomplete scans never return an empty or complete portfolio.
"""
from collections import OrderedDict
import threading
from urllib.parse import urlsplit

from check_monad_readiness import CheckError, quantity
from dashboard_data import DashboardRpc, TRADED, REDEEMED, WRAPPED, UNWRAPPED, claim, hash32, wins
from scan_arbitrage import address, block_info

STARTS = {"0x162ca69cea4306e2e184dc9be8b226580970607b": 65122647,
          "0x094ed5f95188c222a61c27cae24b068120a52dd4": 65285614}
CREATIONS = {
    "0x162ca69cea4306e2e184dc9be8b226580970607b": "0x12ac19fb7d0bb4c6c94f351210e2e5a095cf1d953fa21af76310ba5f84f37cb9",
    "0x094ed5f95188c222a61c27cae24b068120a52dd4": "0xf3fe8a4c0c02cc01a31b6181c224423de823f33fc3e76aec09bdfc465b7d8000",
}
TOPICS = [TRADED, REDEEMED, WRAPPED, UNWRAPPED]
LOCK = threading.Lock()
CACHE = OrderedDict()
PAGE_SIZE = 20


def verify_creation(model, pool, start):
    # A creation receipt proves the scan boundary without archive-state reads.
    # begin() still checks the deployed runtime and manifest at the current head.
    tx = CREATIONS[pool]
    receipt = model.rpc("eth_getTransactionReceipt", [tx])
    if (not isinstance(receipt, dict) or hash32(receipt.get("transactionHash")) != tx
            or quantity(receipt.get("status")) != 1
            or receipt.get("to", "missing") is not None
            or address(receipt.get("contractAddress")) != pool
            or quantity(receipt.get("blockNumber")) != start or start > model.number):
        raise CheckError("Portfolio deployment boundary could not be verified")
    number, _, block_hash = block_info(model.rpc("eth_getBlockByNumber", [hex(start), False]))
    if number != start or block_hash != hash32(receipt.get("blockHash")):
        raise CheckError("Portfolio deployment receipt is no longer canonical. Retry.")


def portfolio(model, wallet, page=0, history_page=0):
    wallet = address(wallet)
    if any(type(n) is not int or not 0 <= n <= 1000 for n in (page, history_page)):
        raise ValueError("Invalid portfolio page")
    if model.m["environment"] != "public_testnet" or model.m["pool"] not in STARTS:
        raise CheckError("Portfolio indexing requires a supported public deployment")
    if not LOCK.acquire(blocking=False):
        raise CheckError("Portfolio reader is busy. Retry shortly.")
    try:
        return read(model, wallet, page, history_page)
    finally:
        LOCK.release()


def read(model, wallet, page, history_page):
    model.begin()
    pool = model.m["pool"]
    start = STARTS[pool]
    key = (pool, model.m["verified_block_hash"])
    cached = CACHE.get(key)
    if cached and (cached["end"] > model.number or block_info(model.rpc("eth_getBlockByNumber", [hex(cached["end"]), False]))[2] != cached["hash"]):
        del CACHE[key]  # A changed checkpoint invalidates all derived history.
        cached = None
    if cached is None:
        verify_creation(model, pool, start)
        public = isinstance(model.rpc, DashboardRpc) and urlsplit(model.rpc.url).hostname == 'testnet-rpc.monad.xyz'
        cached = {"end": start - 1, "hash": block_info(model.rpc("eth_getBlockByNumber", [hex(start - 1), False]))[2], "events": [], "span": 100 if public else 5000}
    first = cached["end"] + 1
    batched = isinstance(model.rpc, DashboardRpc)
    # At most ten RPCs per batch and 5,000 blocks per request. Small-range
    # providers can still advance without one HTTP round trip per block range.
    ranges = min(10, max(1, 5000 // cached["span"])) if batched else 1
    end = min(model.number, first + cached["span"] * ranges - 1)
    events = list(cached["events"])
    end_hash = cached["hash"]
    if first <= end:
        end_hash = block_info(model.rpc("eth_getBlockByNumber", [hex(end), False]))[2]
        try:
            def params(f, t): return [{"address": pool, "fromBlock": hex(f), "toBlock": hex(t), "topics": [TOPICS]}]
            if batched:
                payload = [{"jsonrpc": "2.0", "id": i + 1, "method": "eth_getLogs", "params": params(f, min(end, f + cached["span"] - 1))}
                           for i, f in enumerate(range(first, end + 1, cached["span"]))]
                model.rpc.pace(len(payload))
                values = model.rpc.read_batch(payload, {item['id']: item['id'] for item in payload})
                if any(not isinstance(value, list) or len(value) >= 10000 for value in values.values()):
                    raise CheckError('Invalid history batch')
                logs = [log for value in values.values() for log in value]
            else:
                logs = model.rpc("eth_getLogs", params(first, end))
        except CheckError:
            # Retry on the next explicit/poll request with a smaller range. Never
            # skip a rejected range, and never treat an RPC failure as no events.
            CACHE[key] = {**cached, "span": max(1, cached["span"] // 2)}
            raise CheckError("History scan unavailable. Retry to resume with a smaller block range.") from None
        if not isinstance(logs, list) or len(logs) >= 10000 or len(events) + len(logs) > 20000:
            raise CheckError("History exceeds this reader's capacity; no complete portfolio is available")
        seen, event_blocks = set(), {}
        for log in logs:
            if not isinstance(log, dict) or address(log.get("address")) != pool or log.get("removed"):
                raise CheckError("Invalid pool history event")
            number = quantity(log.get("blockNumber"))
            index = quantity(log.get("logIndex"))
            tx_index = quantity(log.get("transactionIndex"))
            tx = hash32(log.get("transactionHash"))
            block_hash = hash32(log.get("blockHash"))
            if not first <= number <= end or (number, index) in seen or not log.get("topics") or log["topics"][0] not in TOPICS:
                raise CheckError("History range or event identity mismatch")
            seen.add((number, index))
            if number in event_blocks and event_blocks[number] != block_hash:
                raise CheckError("History contains conflicting block hashes")
            event_blocks[number] = block_hash
            decoded = model.receipt_events({"logs": [log], "blockHash": block_hash}, tx)
            if len(decoded) != 1:
                raise CheckError("Unsupported pool history event")
            event = decoded[0]
            claim(event["scope"], int(event["mask"]))
            events.append({**event, "block_number": number, "transaction_index": tx_index,
                           "log_index": index, "transaction_hash": tx, "block_hash": block_hash})
        # A provider can serve a stale log index even when its head is current.
        # Check each event-bearing block, not only the range's end checkpoint.
        if len(event_blocks) > 100:
            CACHE[key] = {**cached, "span": max(1, cached["span"] // 2)}
            raise CheckError("Dense history range. Retry to resume with a smaller range.")
        for offset in range(0, len(event_blocks), 10):
            selected = list(event_blocks)[offset:offset + 10]
            if batched:
                payload = [{"jsonrpc": "2.0", "id": i + 1, "method": "eth_getBlockByNumber", "params": [hex(n), False]} for i, n in enumerate(selected)]
                model.rpc.pace(len(payload))
                blocks = model.rpc.read_batch(payload, {i + 1: n for i, n in enumerate(selected)})
            else:
                blocks = {n: model.rpc("eth_getBlockByNumber", [hex(n), False]) for n in selected}
            if any(block_info(blocks[n])[0] != n or block_info(blocks[n])[2] != event_blocks[n] for n in selected):
                raise CheckError("History event is no longer canonical. Retry.")
        if block_info(model.rpc("eth_getBlockByNumber", [hex(end), False]))[2] != end_hash:
            raise CheckError("History reorganized during scan. Retry.")
    complete = end == model.number
    result = {"market_id": "learning" if "updater" in model.m else "original", "contracts": {"pool": pool, "cash": model.m["cash"]},
              "wallet_address": wallet, "index": {"complete": complete, "from_block": start, "through_block": end,
              "target_block": model.number}, "positions": None, "history": None}
    if complete:
        owned = sorted((e for e in events if e.get("owner", e.get("trader")) == wallet),
                       key=lambda e: (e["block_number"], e["transaction_index"], e["log_index"]), reverse=True)
        discovered = sorted({(e["scope"], int(e["mask"])) for e in owned})
        if len(discovered) > 512:
            raise CheckError("Too many claim balances for this reader; portfolio unavailable")
        reads = [model.read_call("pool", "90fc2c7b", int(wallet, 16), s, p) for s, p in discovered]
        for offset in range(0, len(reads), 32):
            model.prefetch(reads[offset:offset + 32])
        state = model.state()
        positions = []
        for scope, mask in discovered:
            balance = model.call("pool", "90fc2c7b", int(wallet, 16), scope, mask)[0]
            if balance:
                winning = wins(scope, mask, state["resolved_state"]) if state["resolved"] else None
                positions.append({"scope": scope, "mask": mask, "quantity_atoms": str(balance),
                                  "settlement": "pending" if winning is None else "winning" if winning else "losing",
                                  "redeemable_atoms": None if winning is None else str(balance if winning else 0)})
        result.update(pool=state, positions=positions[page * PAGE_SIZE:(page + 1) * PAGE_SIZE],
                      position_count=len(positions), page=page, history_page=history_page, page_size=PAGE_SIZE,
                      history=owned[history_page * PAGE_SIZE:(history_page + 1) * PAGE_SIZE], history_count=len(owned),
                      ausd_atoms=str(model.balance("cash", wallet)),
                      receipt_atoms=str(model.balance("receipt", wallet)) if "receipt" in model.m else None)
    result = model.finish(result)  # Commit the cache only after the snapshot reorg check.
    CACHE[key] = {"end": end, "hash": end_hash, "events": events, "span": cached["span"]}
    CACHE.move_to_end(key)
    while len(CACHE) > 8:
        CACHE.popitem(last=False)
    return result
