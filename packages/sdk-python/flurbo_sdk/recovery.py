"""One recovery step for a journal entry (protocol/specs/transactions.md). Pure: the caller supplies what
the chain shows. nonceLatest is eth_getTransactionCount(wallet, "latest"); the nonce is used once
nonceLatest > nonce. The contract rejects a trade only when block.timestamp > deadline."""

FINAL = ("confirmed", "reverted", "mismatch", "replaced", "expired", "abandoned")


def recovery_step(entry: dict, chain: dict, now: int) -> dict:
    if entry["status"] in FINAL:
        return {"status": entry["status"], "action": "none"}
    if entry["status"] == "planned":
        return {"status": "abandoned", "action": "release"}  # nothing was signed
    if chain.get("receiptStatus") == 1:
        return {"status": "broadcast", "action": "verify"}
    if chain.get("receiptStatus") == 0:
        return {"status": "reverted", "action": "release"}
    if chain.get("txFound"):
        return {"status": "broadcast", "action": "poll"}
    if entry.get("nonce") is not None and chain["nonceLatest"] > entry["nonce"]:
        return {"status": "replaced", "action": "release"}
    if entry.get("deadline") is not None and now > entry["deadline"]:
        return {"status": "expired", "action": "release"}
    # Same signed bytes, same hash: sending again cannot create a second transaction.
    return {"status": entry["status"], "action": "rebroadcast"}
