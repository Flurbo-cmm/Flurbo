"""Verify a demo address manifest against one RPC snapshot. Read-only; no deployment/signing."""

import argparse
import hashlib
import json
from pathlib import Path

from check_monad_readiness import CONFIG, CheckError, Rpc, quantity, rpc_endpoint
from scan_arbitrage import abi, address, block_info, SELECTORS
from check_kuru_readiness import words
import os

RULES_HASH = "0xd33b9c4b1bc5b33fb0551ade458586ba51f1df5fceeedc62098515635da23354"
RULES = "Flurbo synthetic demo v1: eight independent binary test fixtures; event i is bit i; immutable deployer resolves once after close; no cancellation; no real-world outcome source."


def verify(manifest, network, rpc):
    m = dict(manifest)
    if m.get("chain_id") != 10143 or quantity(rpc("eth_chainId", [])) != 10143:
        raise CheckError("Demo verification requires Monad testnet chain ID")
    for key in ("pool", "receipt", "market", "executor", "cash", "margin", "operator", "resolver"):
        m[key] = address(m.get(key))
    if m["cash"] != address(network["contracts"]["ausd"]) or m["margin"] != address(network["contracts"]["kuru_margin"]):
        raise CheckError("Manifest collateral/margin differs from reviewed network")
    if m["resolver"] != m["operator"] or m.get("rules_hash", "").lower() != RULES_HASH or m.get("rules") != RULES:
        raise CheckError("Unexpected synthetic resolver or settlement rules")
    if (m.get("scope"), m.get("mask"), m.get("event_count"), m.get("liquidity_atoms")) != (128, 2, 8, 10000000):
        raise CheckError("Unsupported demo cluster")
    number, timestamp, block_hash = block_info(rpc("eth_getBlockByNumber", ["latest", False]))
    tag = hex(number)

    def call(key, selector, *args, count=1):
        return words(rpc("eth_call", [{"to": m[key], "data": abi(selector, *args)}, tag]), count)

    code_hashes = {}
    for key in ("pool", "receipt", "market", "executor", "cash", "margin"):
        code = rpc("eth_getCode", [m[key], tag])
        try:
            raw = bytes.fromhex(code.removeprefix("0x")) if code.startswith("0x") else b""
        except (AttributeError, ValueError):
            raw = b""
        if not raw:
            raise CheckError("Manifest includes an undeployed contract")
        code_hashes[key] = hashlib.sha256(raw).hexdigest()
    expected = {"71be2e4a": 8, "1a686502": 10000000, "04f3bcec": int(m["resolver"], 16),
                "03a79426": int(RULES_HASH, 16), "d8dfeb45": int(m["cash"], 16), "ec9c6c30": 6,
                "39a3a99a": m["closes_at"], "35add209": m["initial_funding_atoms"], "f3a504f2": 1, "3f6fa655": 0}
    for selector, value in expected.items():
        if call("pool", selector)[0] != value:
            raise CheckError("Pool configuration/state differs from the demo manifest")
    if m["closes_at"] <= timestamp:
        raise CheckError("Demo trading window has closed")
    if call("pool", "7220c660", 128, 2)[0] != int(m["receipt"], 16):
        raise CheckError("Noncanonical demo receipt")
    for key, selector in SELECTORS.items():
        value = m[key] if key in ("scope", "mask") else int(m[key], 16)
        if call("executor", selector)[0] != value:
            raise CheckError("Executor identity mismatch")
    for selector, expected_value in (("16f0115b", int(m["pool"], 16)), ("6e62d0a8", 128), ("116134ee", 2), ("313ce567", 6)):
        if call("receipt", selector)[0] != expected_value:
            raise CheckError("Receipt identity mismatch")
    if call("cash", "313ce567")[0] != 6:
        raise CheckError("Unsupported collateral precision")
    if call("margin", "5f71a07c", int(m["market"], 16))[0] != 1:
        raise CheckError("Kuru market is not registered")
    pair = call("market", "90c9427c", count=11)
    if pair != [1000000, 1000000, int(m["receipt"], 16), 6, int(m["cash"], 16), 6, 100, 10000, 100000000, 30, 10]:
        raise CheckError("Kuru pair parameters differ from the reviewed draft")
    supply = call("receipt", "18160ddd")[0]
    escrow = call("pool", "90fc2c7b", int(m["receipt"], 16), 128, 2)[0]
    balance = call("cash", "70a08231", int(m["pool"], 16))[0]
    required = call("pool", "b53105a3")[0]
    executor_balance = call("cash", "70a08231", int(m["executor"], 16))[0]
    if supply != escrow or balance < required or executor_balance < 20_000_000:
        raise CheckError("Receipt backing, coverage or initial executor funding is insufficient")
    if block_info(rpc("eth_getBlockByNumber", [tag, False])) != (number, timestamp, block_hash):
        raise CheckError("Snapshot changed during manifest verification")
    m.update(status="verified_snapshot", verified_block=number, verified_block_hash=block_hash,
             manifest_version=1, events=[{"index": i, "label": f"Synthetic event {chr(65 + i)}"} for i in range(8)],
             verified_timestamp=timestamp, code_sha256=code_hashes,
             balances={"pool_collateral_atoms": balance, "required_collateral_atoms": required,
                       "receipt_supply_atoms": supply, "executor_collateral_atoms": executor_balance})
    return m


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provider", choices=("public", "alchemy", "local"), default="public")
    args = parser.parse_args()
    try:
        network = json.loads(CONFIG.read_text())["networks"]["testnet"]
        report = verify(json.loads(args.manifest.read_text()), network, Rpc(rpc_endpoint(network, args.provider, os.environ)))
        report["environment"] = "local_fork" if args.provider == "local" else "public_testnet"
        report["verification_scope"] = "Observed getters, code presence and accounting at one block; not explorer source verification"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "environment": report["environment"],
                          "verified_block": report["verified_block"], "output": str(args.output)}, indent=2))
        return 0
    except Exception as error:
        # Invalidate any previous output so a failed rerun cannot leave a stale ready manifest.
        failure = {"status": "blocked", "error": str(error) if isinstance(error, CheckError) else "Invalid configuration or RPC response"}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(failure, indent=2) + "\n")
        print(json.dumps(failure, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
