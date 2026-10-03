"""Whether a mined receipt shows exactly the reported intent (protocol/specs/transactions.md)."""
import re

from .abi import decode_pool_log


def verify_effect(intent: dict, receipt: dict, allowance_after_atoms: str | None) -> dict:
    """intent: {action, wallet, pool, claim, quantityAtoms, limitAtoms}; receipt: {status, logs}."""
    if receipt.get("status") != 1:
        return {"status": "mismatch"}
    wallet, pool, limit = intent["wallet"].lower(), intent["pool"].lower(), int(intent["limitAtoms"])
    if intent["action"] == "approve":
        ok = allowance_after_atoms is not None and re.match(r"^(0|[1-9][0-9]*)$", allowance_after_atoms) and int(allowance_after_atoms) >= limit
        return {"status": "confirmed", "collateralAtoms": None} if ok else {"status": "mismatch"}
    claim = intent.get("claim")
    if not claim:
        return {"status": "mismatch"}
    scope, mask, quantity = claim["scope"], int(claim["mask"]), int(intent["quantityAtoms"])
    for log in receipt.get("logs") or []:
        if str(log.get("address", "")).lower() != pool:
            continue
        e = decode_pool_log(log)
        if not e or e["scope"] != scope or e["mask"] != mask or e["quantity"] != quantity:
            continue
        if e["event"] == "Traded" and e["trader"] == wallet:
            if intent["action"] == "buy" and e["isBuy"] and e["collateralAmount"] <= limit:
                return {"status": "confirmed", "collateralAtoms": str(e["collateralAmount"])}
            if intent["action"] == "sell" and not e["isBuy"] and e["collateralAmount"] >= limit:
                return {"status": "confirmed", "collateralAtoms": str(e["collateralAmount"])}
        if e["event"] == "Redeemed" and intent["action"] == "redeem" and e["owner"] == wallet:
            return {"status": "confirmed", "collateralAtoms": str(e["collateralAmount"])}
    return {"status": "mismatch"}
