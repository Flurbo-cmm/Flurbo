"""One-shot, read-only arbitrage candidate scan. Never signs or sends transactions."""

import argparse
import json
import os
from pathlib import Path
import re
import time

from check_monad_readiness import CONFIG, CheckError, Rpc, quantity, rpc_endpoint
from check_kuru_readiness import words

ZERO = "0x" + "00" * 20
SELECTORS = {"pool": "16f0115b", "market": "80f55605", "receipt": "e1e6b898",
             "cash": "961be391", "operator": "570ca735", "scope": "6e62d0a8", "mask": "116134ee"}
EXECUTE = "ac02cbfd"
KURU_BUY, KURU_SELL = "7c51d6cf", "532c46db"
POOL_BUY, POOL_SELL = "a6a83dde", "f29d0ba9"


class ScanRpc(Rpc):
    allowed_methods = Rpc.allowed_methods | {"eth_estimateGas", "eth_gasPrice"}


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value) or int(value, 16) == 0:
        raise CheckError("Configure nonzero executor, pool, market, receipt, cash and operator addresses")
    return value.lower()


def uint(value, bits=256, positive=True):
    if type(value) is not int or not (int(positive) <= value < 2**bits):
        raise CheckError("Configuration or amount is outside its integer range")
    return value


def abi(selector, *values):
    return "0x" + selector + "".join(f"{uint(value, positive=False):064x}" for value in values)


def ceil_div(n, d):
    return (n + d - 1) // d


def validate(config, now):
    c = dict(config)
    if c.get("chain_id") != 10143:
        raise CheckError("Only Monad testnet is supported")
    for key in ("executor", *SELECTORS.keys()):
        if key not in ("scope", "mask"):
            c[key] = address(c.get(key))
    uint(c.get("scope"), 32)
    uint(c.get("mask"), 8)
    if c["scope"] & (c["scope"] - 1) or c.get("mask") not in (1, 2):
        raise CheckError("Expected a singleton base-event scope and YES/NO local mask")
    for key in ("mon_ausd_price_e6", "price_observed_at", "max_price_age_seconds", "max_block_age_seconds",
                "max_fee_per_gas_wei", "max_gas", "min_profit_atoms", "deadline_seconds", "max_head_advance"):
        uint(c.get(key), 64)
    if not 11000 <= uint(c.get("gas_headroom_bps"), 32) <= 30000:
        raise CheckError("Gas headroom must be between 11000 and 30000 bps")
    if not 0 <= now - c["price_observed_at"] <= c["max_price_age_seconds"]:
        raise CheckError("MON/AUSD conversion input is stale or future-dated")
    if not 1 <= c["deadline_seconds"] <= 120 or c["max_head_advance"] > 10:
        raise CheckError("Deadline/head freshness policy is too broad")
    for key in ("pool_buy_sizes", "kuru_buy_budgets"):
        values = c.get(key)
        if not isinstance(values, list) or not 1 <= len(values) <= 16 or len(set(values)) != len(values):
            raise CheckError("Provide 1–16 distinct candidate amounts for each direction")
        for value in values:
            uint(value, 96)
    return c


def block_info(block):
    if not isinstance(block, dict) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(block.get("hash", ""))):
        raise CheckError("Invalid block snapshot")
    return quantity(block.get("number")), quantity(block.get("timestamp")), block["hash"].lower()


def scan(config, rpc, now=None, comparison_only=False):
    clock = time.time if now is None else lambda: now
    c = validate(config, int(clock()))
    if quantity(rpc("eth_chainId", [])) != c["chain_id"]:
        raise CheckError("RPC chain differs from configured testnet")
    number, timestamp, block_hash = block_info(rpc("eth_getBlockByNumber", ["latest", False]))
    tag = hex(number)
    if not 0 <= int(clock()) - timestamp <= c["max_block_age_seconds"]:
        raise CheckError("Block snapshot is stale or future-dated")

    def call(target, data, count=1, sender=None):
        tx = {"to": target, "data": data}
        if sender is not None:
            tx["from"] = sender
        return words(rpc("eth_call", [tx, tag]), count)

    if hasattr(rpc, "prefetch"):
        # Batch independent deployment reads on hosted readers. Calls stay pinned
        # to the same block; this never batches signing or changes freshness gates.
        reads = [("eth_getCode", [c[key], tag]) for key in ("executor", "pool", "market", "receipt", "cash")]
        reads += [("eth_call", [{"to": c["executor"], "data": abi(selector)}, tag]) for selector in SELECTORS.values()]
        reads += [("eth_call", [{"to": c["pool"], "data": abi("7220c660", c["scope"], c["mask"])}, tag]),
                  ("eth_call", [{"to": c["market"], "data": abi("90c9427c")}, tag]),
                  ("eth_call", [{"to": c["pool"], "data": abi("39a3a99a")}, tag])]
        rpc.prefetch(reads)
    for key in ("executor", "pool", "market", "receipt", "cash"):
        code = rpc("eth_getCode", [c[key], tag])
        if not isinstance(code, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", code):
            raise CheckError("Configured contract has no readable deployed code")
    for key, selector in SELECTORS.items():
        expected = c[key] if key in ("scope", "mask") else int(c[key], 16)
        if call(c["executor"], abi(selector))[0] != expected:
            raise CheckError("Executor binding differs from reviewed configuration")
    if call(c["pool"], abi("7220c660", c["scope"], c["mask"]))[0] != int(c["receipt"], 16):
        raise CheckError("Receipt is not canonical for the configured pool claim")
    params = call(c["market"], abi("90c9427c"), 11)
    if params[:6] != [1_000_000, 1_000_000, int(c["receipt"], 16), 6, int(c["cash"], 16), 6]:
        raise CheckError("Unsupported or changed Kuru pair")
    if quantity(rpc("eth_gasPrice", [])) > c["max_fee_per_gas_wei"]:
        raise CheckError("Current gas price exceeds configured fee cap")
    close = call(c["pool"], abi("39a3a99a"))[0]
    deadline = min(timestamp + c["deadline_seconds"], close - 1)
    if deadline <= int(clock()):
        raise CheckError("No fresh execution window before pool close")

    results = []
    for pool_first, amounts in ((True, c["pool_buy_sizes"]), (False, c["kuru_buy_budgets"])):
        for amount in amounts:
            row = {"direction": "pool_to_kuru" if pool_first else "kuru_to_pool", "input_atoms": amount}
            try:
                if pool_first:
                    units = amount
                    spent = call(c["pool"], abi(POOL_BUY, c["scope"], c["mask"], units))[0]
                    received = call(c["market"], abi(KURU_SELL, units, 0, 0, 1), sender=ZERO)[0]
                else:
                    spent = amount
                    units = call(c["market"], abi(KURU_BUY, spent, 0, 0, 1), sender=ZERO)[0]
                    uint(units, 96)
                    received = call(c["pool"], abi(POOL_SELL, c["scope"], c["mask"], units))[0]
                uint(spent, 96)
                uint(received, 128)
                if received < spent + c["min_profit_atoms"] + 1:
                    raise CheckError("Insufficient spread after venue fees, before gas")

                def transaction(allowance):
                    data = abi(EXECUTE, int(pool_first), units, spent, received, allowance, c["min_profit_atoms"], deadline)
                    return {"from": c["operator"], "to": c["executor"], "data": data,
                            "gasPrice": hex(c["max_fee_per_gas_wei"])}

                # Estimate the full route, including funded balances, authorization and fill-or-kill.
                estimate = quantity(rpc("eth_estimateGas", [transaction(1), tag]))
                gas_limit = ceil_div(estimate * c["gas_headroom_bps"], 10000)
                if estimate == 0 or gas_limit > c["max_gas"]:
                    raise CheckError("Full-route gas estimate exceeds policy")
                allowance = max(1, ceil_div(gas_limit * c["max_fee_per_gas_wei"] * c["mon_ausd_price_e6"], 10**18))
                uint(allowance, 128)
                if received < spent + allowance + c["min_profit_atoms"]:
                    raise CheckError("Unprofitable after conservative gas conversion")
                tx = transaction(allowance)
                tx["gas"] = hex(gas_limit)
                final_estimate = quantity(rpc("eth_estimateGas", [tx, tag]))
                if not 0 < final_estimate <= gas_limit:
                    raise CheckError("Final calldata gas exceeds reserved allowance")
                actual = words(rpc("eth_call", [tx, tag]), 4)
                expected = [spent, received, received - spent, received - spent - allowance]
                if actual != expected:
                    raise CheckError("Full-route result differs from quoted candidate")
                row.update(status="simulated_candidate", receipt_atoms=units, spent_atoms=spent,
                           received_atoms=received, gas_estimate=final_estimate, gas_limit=gas_limit,
                           gas_allowance_atoms=allowance, net_after_allowance_atoms=actual[3],
                           deadline=deadline, unsigned_transaction=tx)
            except CheckError as error:
                row.update(status="rejected", reason=str(error))
            results.append(row)

    # Number-pinned reads are discarded on reorg or excessive head/time advance.
    if block_info(rpc("eth_getBlockByNumber", [tag, False])) != (number, timestamp, block_hash):
        raise CheckError("Snapshot changed; discard the entire scan")
    head, _, _ = block_info(rpc("eth_getBlockByNumber", ["latest", False]))
    expired = not number <= head <= number + c["max_head_advance"] or int(clock()) >= deadline
    if expired and not comparison_only:
        raise CheckError("Scan expired or head advanced; discard candidates")
    expired = expired or int(clock()) - timestamp > c["max_block_age_seconds"] or int(clock()) - c["price_observed_at"] > c["max_price_age_seconds"]
    if expired and not comparison_only:
        raise CheckError("Price or block freshness expired during scan")
    results.sort(key=lambda row: row.get("net_after_allowance_atoms", -1), reverse=True)
    if comparison_only:
        for row in results:
            row.pop("unsigned_transaction", None)
            if expired and row["status"] == "simulated_candidate":
                row["status"] = "expired_candidate"
    return {"read_only": True, "status": "expired" if expired else "complete", "chain_id": c["chain_id"],
            "block_number": number, "block_hash": block_hash, "candidates": results,
            "conversion": {"mon_ausd_price_e6": c["mon_ausd_price_e6"], "observed_at": c["price_observed_at"],
                           "source": "operator-supplied; freshness checked, not independently verified"},
            "scope": "Pinned-state simulations only. Re-scan before execution; nothing was broadcast."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--provider", choices=("public", "alchemy", "local"), default="public")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        validate(config, int(time.time()))
        network = json.loads(CONFIG.read_text())["networks"]["testnet"]
        report = scan(config, ScanRpc(rpc_endpoint(network, args.provider, os.environ)))
        report["environment"] = "local_fork" if args.provider == "local" else "public_testnet"
    except (CheckError, ValueError, OSError) as error:
        report = {"read_only": True, "status": "blocked", "error": str(error) if isinstance(error, CheckError) else "Invalid or unavailable local configuration"}
    except Exception:
        report = {"read_only": True, "status": "blocked", "error": "Unexpected response/configuration; details withheld"}
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
