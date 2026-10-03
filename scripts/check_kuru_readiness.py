"""Read-only Kuru testnet interface probe. Does not establish source/bytecode equivalence."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import re

from check_monad_readiness import CONFIG, CheckError, Rpc, quantity, rpc_endpoint
from kuru_order_plan import CONFIG as PLAN, validate


def words(value, count):
    if not isinstance(value, str) or not re.fullmatch("0x" + "[0-9a-fA-F]{64}" * count, value):
        raise CheckError("Unexpected ABI return shape; stop and recheck the deployed interface")
    return [int(value[2 + index * 64:2 + (index + 1) * 64], 16) for index in range(count)]


def address(value):
    if not 0 < value < 2**160:
        raise CheckError("Invalid address returned by Kuru")
    return f"0x{value:040x}"


def inspect(network, plan, rpc):
    validate(plan)
    if quantity(rpc("eth_chainId", [])) != 10143 or network["chain_id"] != 10143:
        raise CheckError("Expected Monad testnet; stopped before contract reads")
    block = rpc("eth_getBlockByNumber", ["latest", False])
    tag = hex(quantity(block["number"]))
    block_hash = block.get("hash")
    if not isinstance(block_hash, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", block_hash):
        raise CheckError("Missing snapshot hash")
    router = network["contracts"]["kuru_router"]

    def call(target, selector, count=1):
        return words(rpc("eth_call", [{"to": target, "data": selector}, tag]), count)

    def code(target):
        raw = rpc("eth_getCode", [target, tag])
        if not isinstance(raw, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", raw):
            raise CheckError("Expected deployed contract code")
        data = bytes.fromhex(raw[2:])
        return {"address": target, "code_bytes": len(data), "code_sha256": hashlib.sha256(data).hexdigest()}

    contracts = {"router": code(router)}
    for name, selector in (("orderbook_implementation", "0xa0416499"),
                           ("margin_account", "0x483100bd"), ("vault_implementation", "0xa574b091")):
        contracts[name] = code(address(call(router, selector)[0]))
    if contracts["margin_account"]["address"].lower() != network["contracts"]["kuru_margin"].lower():
        raise CheckError("Router margin account differs from the reviewed network configuration")
    ausd = network["contracts"]["ausd"]
    contracts["ausd"] = code(ausd)
    if call(ausd, "0x313ce567")[0] != plan["quote_decimals"]:
        raise CheckError("AUSD decimals do not match the draft")
    reference = plan["reference_market"]
    contracts["reference_market"] = code(reference)
    values = call(reference, "0x90c9427c", 11)
    labels = ("price_precision", "size_precision", "base_asset", "base_decimals", "quote_asset",
              "quote_decimals", "tick_size", "min_size", "max_size", "taker_fee_bps", "maker_fee_bps")
    params = dict(zip(labels, values))
    params["base_asset"] = f"0x{values[2]:040x}"  # zero is valid for the reference MON base
    params["quote_asset"] = address(values[4])
    if values[2] >= 2**160 or not 0 < values[0] < 2**32 or not 0 < values[1] < 2**96:
        raise CheckError("Reference market returned invalid asset/precision fields")
    if not (0 <= values[3] <= 18 and 0 <= values[5] <= 18 and 0 < values[6] < 2**32
            and 0 < values[7] < values[8] < 2**96 and 0 <= values[10] <= values[9] < 10000):
        raise CheckError("Reference market returned invalid decimals, tick, sizes or fees")
    if rpc("eth_getBlockByNumber", [tag, False]).get("hash") != block_hash:
        raise CheckError("Snapshot changed during checks; rerun")
    return {"status": "pass", "chain_id": 10143, "block_number": int(tag, 16), "block_hash": block_hash,
            "source_revision": plan["source_revision"], "contracts": contracts, "reference_market_params": params,
            "scope": "Read getters/code only; no source equivalence, new pair simulation or trading readiness proven"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("public", "alchemy"), default="public")
    args = parser.parse_args()
    report = {"read_only": True, "provider": args.provider, "observed_at": datetime.now(timezone.utc).isoformat()}
    try:
        network = json.loads(CONFIG.read_text())["networks"]["testnet"]
        report.update(inspect(network, json.loads(PLAN.read_text()), Rpc(rpc_endpoint(network, args.provider, os.environ))))
    except (CheckError, ValueError) as error:
        report.update(status="fail", error=str(error))
    except Exception:
        report.update(status="fail", error="Unexpected response/configuration; remote details withheld")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
