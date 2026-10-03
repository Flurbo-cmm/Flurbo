"""Read-only acceptance of a fresh synthetic learning deployment, separate from the trading manifest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time

from check_monad_readiness import CONFIG, CheckError, Rpc, quantity, rpc_endpoint
from check_kuru_readiness import words
from scan_arbitrage import abi, address, block_info, uint

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "target/foundry/out"
OPERATOR = "0xf1fea08ebba92ed342acc5639db312c3694bc391"
AUSD = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc"
RULES = "Flurbo synthetic learning v1: eight binary test fixtures; event i is bit i; immutable deployer resolves once after close; no cancellation; no real-world outcome source; authorized funded bias updates change prices, not payouts."
RULES_HASH = "0x89ccd66da707a465b629659659ed31c9e084f3a87e295bcbfa3033039dccc362"
PLAN = {"event_count": 8, "liquidity_atoms": 10_000_000, "initial_funding_atoms": 55_451_775,
        "max_bias_movement_atoms": 2_000_000, "epoch_funding_limit_atoms": 10_000_000,
        "epoch_seconds": 3600, "min_update_interval_seconds": 60}
CONTRACTS = {"pool": "FundedFactoredPool", "pricing_engine": "FundedPricingEngine",
             "base_token_factory": "FactoredBaseTokenFactory"}


def bytecode(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", value):
        raise CheckError("Missing or malformed deployed bytecode")
    return bytes.fromhex(value[2:])


def match_runtime(code, artifact, immutable_count):
    """Match compiler runtime including metadata; check all copies of each immutable agree.

    The caller must check every immutable's public getter against reviewed values.
    Stateless helpers require an exact byte-for-byte match, without masking.
    """
    actual = bytearray(bytecode(code))
    compiled = artifact["deployedBytecode"]
    expected = bytearray(bytecode(compiled["object"]))
    references = compiled.get("immutableReferences", {})
    if len(actual) != len(expected) or len(references) != immutable_count:
        raise CheckError("Runtime length or immutable layout differs from compiled artifact")
    covered = set()
    for entries in references.values():
        if not entries:
            raise CheckError("Empty immutable layout")
        first = None
        for entry in entries:
            start, length = entry["start"], entry["length"]
            if type(start) is not int or length != 32 or start < 0 or start + length > len(actual):
                raise CheckError("Invalid immutable layout")
            indexes = set(range(start, start + length))
            if indexes & covered:
                raise CheckError("Overlapping immutable layout")
            covered |= indexes
            value = bytes(actual[start:start + length])
            if first is not None and value != first:
                raise CheckError("Inconsistent immutable values inside deployed runtime")
            first = value
            actual[start:start + length] = bytes(length)
            expected[start:start + length] = bytes(length)
    if actual != expected:
        raise CheckError("Deployed runtime differs from compiled artifact")
    return {"runtime_sha256": hashlib.sha256(bytecode(code)).hexdigest(),
            "normalized_runtime_sha256": hashlib.sha256(expected).hexdigest(),
            "immutable_groups_checked": len(references)}


def load_artifacts():
    return {key: json.loads((ARTIFACTS / f"{name}.sol" / f"{name}.json").read_text())
            for key, name in CONTRACTS.items()}


def verify(manifest, rpc, artifacts, now=None):
    # Build a fresh allowlisted report; never carry untrusted input fields into an accepted manifest.
    m = {key: manifest.get(key) for key in ("deployment_kind", "chain_id", "rules", "rules_hash", "closes_at", *PLAN)}
    if m["deployment_kind"] != "synthetic_funded_learning_v1" or m["chain_id"] != 10143:
        raise CheckError("Expected separate synthetic Monad testnet learning deployment")
    if quantity(rpc("eth_chainId", [])) != 10143:
        raise CheckError("RPC is not Monad testnet")
    for key in ("operator", "resolver", "updater", "pool", "pricing_engine", "base_token_factory", "cash"):
        m[key] = address(manifest.get(key))
    if any(m[key] != OPERATOR for key in ("operator", "resolver", "updater")) or m["cash"] != AUSD:
        raise CheckError("Unreviewed authority or collateral address")
    if len({m[key] for key in (*CONTRACTS, "cash", "operator")}) != 5:
        raise CheckError("Deployment addresses must be distinct")
    if m["rules"] != RULES or m["rules_hash"] != RULES_HASH:
        raise CheckError("Unreviewed settlement rules")
    if any(type(m[key]) is not int or m[key] != value for key, value in PLAN.items()):
        raise CheckError("Deployment policy differs from reviewed testnet plan")
    uint(m["closes_at"], 64)
    number, timestamp, block_hash = block_info(rpc("eth_getBlockByNumber", ["latest", False]))
    clock = int(time.time()) if now is None else now
    if not -15 <= clock - timestamp <= 180:
        raise CheckError("RPC snapshot is stale or future-dated")
    if not timestamp < m["closes_at"] < timestamp + 30 * 86400:
        raise CheckError("Learning trading window is closed or outside reviewed range")
    tag = hex(number)

    def call(key, selector, *args, count=1):
        return words(rpc("eth_call", [{"to": m[key], "data": abi(selector, *args)}, tag]), count)

    evidence = {key: match_runtime(rpc("eth_getCode", [m[key], tag]), artifacts[key], 15 if key == "pool" else 0)
                for key in CONTRACTS}
    # AUSD is an external proxy, not one of our compiled implementations.
    cash_code = bytecode(rpc("eth_getCode", [m["cash"], tag]))
    expected = {
        "71be2e4a": 8, "1a686502": PLAN["liquidity_atoms"], "04f3bcec": int(OPERATOR, 16),
        "03a79426": int(RULES_HASH, 16), "d8dfeb45": int(AUSD, 16), "ec9c6c30": 6,
        "39a3a99a": m["closes_at"], "35add209": PLAN["initial_funding_atoms"],
        "94483919": int(m["base_token_factory"], 16), "2f04002b": int(m["pricing_engine"], 16),
        "df034cd0": int(OPERATOR, 16), "d13daab8": PLAN["max_bias_movement_atoms"],
        "ea777612": PLAN["epoch_funding_limit_atoms"], "fb5bb0c3": 3600, "0964ff26": 60,
        "f3a504f2": 1, "3f6fa655": 0, "7cc96380": 0, "69b4ecc9": 0, "199733be": 0,
        "e43830e9": 0, "d0530fd0": 0, "0019984b": 0,
        "a88db792": PLAN["initial_funding_atoms"], "b53105a3": PLAN["initial_funding_atoms"],
    }
    for selector, value in expected.items():
        if call("pool", selector)[0] != value:
            raise CheckError("Pool configuration or initial state differs from reviewed plan")
    if call("pool", "a154e571", count=10) != [32, 8, *range(8)]:
        raise CheckError("Unexpected elimination order")
    for selector in ("a5b5433b", "c1fe13e9"):
        if call("pool", selector, count=2) != [32, 0]:
            raise CheckError("New pool already has positions or pricing bias")
    if call("cash", "313ce567")[0] != 6:
        raise CheckError("Unexpected AUSD precision")
    cash = call("cash", "70a08231", int(m["pool"], 16))[0]
    operator_cash = call("cash", "70a08231", int(OPERATOR, 16))[0]
    if cash < PLAN["initial_funding_atoms"] or operator_cash < PLAN["epoch_funding_limit_atoms"]:
        raise CheckError("Initial collateral or operator update reserve is insufficient")
    if call("cash", "dd62ed3e", int(OPERATOR, 16), int(m["pool"], 16))[0] != 0:
        raise CheckError("Deployment approval was not reset to zero")
    if block_info(rpc("eth_getBlockByNumber", [tag, False])) != (number, timestamp, block_hash):
        raise CheckError("Snapshot changed during verification")
    m.update(status="verified_learning_snapshot", manifest_version=1, environment="public_testnet",
             verified_block=number, verified_block_hash=block_hash, verified_timestamp=timestamp,
             runtime_evidence=evidence, cash_proxy_sha256=hashlib.sha256(cash_code).hexdigest(),
             balances={"pool_collateral_atoms": cash, "operator_collateral_atoms": operator_cash},
             verification_scope="Fresh deployment acceptance at one block; compiled runtime and all immutable getters checked. Not an audit, explorer verification or future readiness guarantee.")
    return m


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "target/deployments/learning-unverified.json")
    parser.add_argument("--output", type=Path, default=ROOT / "target/deployments/learning-testnet.json")
    parser.add_argument("--provider", choices=("public", "alchemy"), default="public")
    args = parser.parse_args(argv)
    # Never destroy the broadcast/dry-run input file on a failed verification.
    if args.manifest.resolve() == args.output.resolve():
        parser.error("Input and output must be different files")
    try:
        network = json.loads(CONFIG.read_text())["networks"]["testnet"]
        result = verify(json.loads(args.manifest.read_text()),
                        Rpc(rpc_endpoint(network, args.provider, os.environ)), load_artifacts())
    except Exception as error:
        result = {"status": "blocked", "error": str(error) if isinstance(error, CheckError)
                  else "Invalid configuration, missing build artifact or malformed RPC response"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # A failure replaces any prior verified output, so it cannot leave stale success behind.
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("status", "verified_block", "error") if key in result}, indent=2))
    return 0 if result["status"] == "verified_learning_snapshot" else 1


if __name__ == "__main__":
    raise SystemExit(main())
