"""Explicit disposable-chain rehearsal: Rust learner -> unsigned proposal -> funded EVM update."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid

from build_learning_proposal import build, digest

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:18547"
CHAIN = 31338
UPDATE_SIG = "updateBias((uint256,address,uint256,uint256,uint128,(uint32,uint128[])[]))"


class RpcError(RuntimeError):
    def __init__(self, payload):
        self.payload = payload
        super().__init__(str(payload))


class Rpc:
    def __init__(self):
        self.counter = 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def __call__(self, method, params=None):
        self.counter += 1
        request = urllib.request.Request(URL, json.dumps({"jsonrpc": "2.0", "id": self.counter,
            "method": method, "params": params or []}).encode(), {"Content-Type": "application/json"})
        with self.opener.open(request, timeout=20) as response:
            data = json.load(response)
        if data.get("id") != self.counter:
            raise RuntimeError("RPC response mismatch")
        if "error" in data:
            raise RpcError(data["error"])
        return data["result"]


def run(args):
    result = subprocess.run(list(map(str, args)), cwd=ROOT, capture_output=True, text=True,
                            timeout=180, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(f"Command failed: {args[0]}\n{result.stderr}\n{result.stdout}")
    return result.stdout.strip()


def abi_value(value):
    if isinstance(value, tuple):
        return "(" + ",".join(map(abi_value, value)) + ")"
    if isinstance(value, list):
        return "[" + ",".join(map(abi_value, value)) + "]"
    return str(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-local", action="store_true", required=True)
    for tool in ["anvil", "cast", "forge"]:
        parser.add_argument("--" + tool, default=shutil.which(tool) or tool)
    parser.add_argument("--solc", default=str(ROOT / "target/tools/solc-0.8.28.exe"))
    args = parser.parse_args()
    # Refuse occupied ports. Never attach to a pre-existing node or accept an RPC override.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 18547))
    print("Compiling fresh contract artifacts and exporting the synthetic Rust learner...", flush=True)
    run([args.forge, "test", "--use", args.solc, "--offline", "--match-contract", "FundedFactoredPoolTest",
         "--match-test", "testRuntimeAndConstructorStayWithinDeploymentLimits"])
    model = json.loads(run(["cargo", "run", "--quiet", "--offline", "-p", "flurbo-core", "--example", "parlay_model"]))
    output = ROOT / "target/learning-rehearsal" / uuid.uuid4().hex
    output.mkdir(parents=True)
    # Unique genesis timestamp ties the RPC to this run even if a port race occurs.
    genesis_timestamp = 1_700_000_000 + int(output.name, 16) % 1_000_000_000
    process = subprocess.Popen([args.anvil, "--host", "127.0.0.1", "--port", "18547", "--chain-id", str(CHAIN),
                                "--timestamp", str(genesis_timestamp), "--accounts", "3", "--silent"], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    rpc = Rpc()
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("Owned Anvil process exited; refusing other nodes")
            try:
                client = rpc("web3_clientVersion")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Anvil did not start")
        assert "anvil" in client.lower() and int(rpc("eth_chainId"), 16) == CHAIN
        assert int(rpc("eth_blockNumber"), 16) == 0
        assert int(rpc("eth_getBlockByNumber", ["0x0", False])["timestamp"], 16) == genesis_timestamp
        operator, trader, _ = rpc("eth_accounts")
        transactions = []

        def calldata(signature, *values):
            return run([args.cast, "calldata", signature, *map(abi_value, values)])

        def send(label, sender, data, to=None):
            if process.poll() is not None:
                raise RuntimeError("Owned Anvil exited")
            request = {"from": sender, "data": data}
            if to:
                request["to"] = to
            request["gas"] = hex(int(rpc("eth_estimateGas", [request]), 16) * 12 // 10)
            tx_hash = rpc("eth_sendTransaction", [request])
            for _ in range(100):
                receipt = rpc("eth_getTransactionReceipt", [tx_hash])
                if receipt:
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("Receipt timeout")
            assert receipt["status"] == "0x1"
            transactions.append({"label": label, "hash": tx_hash, "gasUsed": str(int(receipt["gasUsed"], 16))})
            return receipt

        def transact(label, sender, to, signature, *values):
            return send(label, sender, calldata(signature, *values), to)

        def read(to, signature, *values, block="latest"):
            raw = rpc("eth_call", [{"to": to, "data": calldata(signature.split(")(")[0] + ")", *values)}, block])
            return json.loads(run([args.cast, "abi-decode", signature, raw, "--json"]))[0]

        artifacts = {}

        def deploy(name, constructor_signature, *values):
            path = ROOT / f"target/foundry/out/{name}.sol/{name}.json"
            artifacts[name] = hashlib.sha256(path.read_bytes()).hexdigest()
            artifact = json.loads(path.read_text())
            encoded = run([args.cast, "abi-encode", constructor_signature, *map(abi_value, values)])
            return send("deploy " + name, operator, artifact["bytecode"]["object"] + encoded[2:])["contractAddress"]

        print("Deploying mock collateral and funded pool on disposable chain 31338...", flush=True)
        token = deploy("MockCollateral", "f(uint8)", 6)
        timestamp = int(rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
        close = timestamp + 3600
        pool = deploy("FundedFactoredPool", "f((address,uint8,uint128,uint64,uint8[],address,bytes32),(address,uint128,uint128,uint64,uint64))",
                      (token, 2, 10_000_000, close, [0, 1], operator, "0x" + "33" * 32),
                      (operator, 2_000_000, 10_000_000, 60, 1))
        for owner in [operator, trader]:
            transact("mint mock collateral", operator, token, "mint(address,uint256)", owner, 100_000_000)
            transact("approve local pool", owner, token, "approve(address,uint256)", pool, 100_000_000)
        transact("fund pool", operator, pool, "fund()")
        initial_cash = read(token, "balanceOf(address)(uint256)", pool)
        initial_trader = read(token, "balanceOf(address)(uint256)", trader)
        transact("buy A AND B", trader, pool, "buy(uint32,uint256,uint128,uint128,uint256)", 3, 8, 1_000_000, 1_000_000, close - 1)
        before_cash = read(token, "balanceOf(address)(uint256)", pool)
        old_quote = read(pool, "quoteBuy(uint32,uint256,uint128)(uint128)", 3, 8, 1_000_000)
        block = rpc("eth_getBlockByNumber", ["latest", False])
        tag = block["number"]
        actual = read(pool, "factors()((uint32,uint128[])[])", block=tag)
        old_bias = read(pool, "biasFactors()((uint32,uint128[])[])", block=tag)
        def encode_factors(rows):
            return [{"scope": str(scope), "values": list(map(str, values))} for scope, values in rows]
        snapshot = {"schema": "flurbo.funded-snapshot.v1", "chainId": str(CHAIN), "pool": pool,
                    "blockNumber": str(int(tag, 16)), "blockHash": block["hash"], "timestamp": str(int(block["timestamp"], 16)),
                    "events": read(pool, "eventCount()(uint8)", block=tag), "order": read(pool, "eliminationOrder()(uint8[])", block=tag),
                    "decimals": read(pool, "collateralDecimals()(uint8)", block=tag),
                    "liquidity": str(read(pool, "liquidity()(uint128)", block=tag)), "closesAt": str(close),
                    "revision": str(read(pool, "revision()(uint256)", block=tag)),
                    "maxBiasMovement": str(read(pool, "maxBiasMovement()(uint128)", block=tag)),
                    "factors": encode_factors(actual), "biasFactors": encode_factors(old_bias)}
        unsigned = build(model, snapshot, max_funding="1000000", deadline=str(int(snapshot["timestamp"]) + 300))
        p = unsigned["proposal"]
        fields = (p["chainId"], p["pool"], p["expectedRevision"], p["deadline"], p["maxFunding"],
                  [(row["scope"], row["values"]) for row in p["bias"]])
        encoded_update = calldata(UPDATE_SIG, fields)
        assert rpc("eth_getBlockByNumber", [tag, False])["hash"] == snapshot["blockHash"]
        assert str(read(pool, "revision()(uint256)")) == p["expectedRevision"]
        required_funding = int(rpc("eth_call", [{"from": operator, "to": pool, "data": encoded_update}, "latest"]), 16)
        assert 0 < required_funding <= int(p["maxFunding"])
        print("Unsigned proposal simulated; executing exact funding and checking the event/ledger...", flush=True)
        receipt = send("funded learned update", operator, encoded_update, pool)
        event = run([args.cast, "keccak", "BiasUpdated(uint256,bytes32,uint128,uint128)"])
        logs = [log for log in receipt["logs"] if log["address"].lower() == pool.lower() and log["topics"][0] == event]
        assert len(logs) == 1
        assert logs[0]["topics"][2] == run([args.cast, "keccak", "0x" + encoded_update[10:]])
        added, reserve = json.loads(run([args.cast, "abi-decode", "f()(uint128,uint128)", logs[0]["data"], "--json"]))
        assert added == required_funding
        assert int(logs[0]["topics"][1], 16) == int(p["expectedRevision"]) + 1
        assert read(pool, "revision()(uint256)") == int(p["expectedRevision"]) + 1
        assert read(token, "balanceOf(address)(uint256)", pool) == before_cash + added
        assert read(pool, "pricingReserve()(uint128)") == reserve
        assert read(pool, "factors()((uint32,uint128[])[])") == actual
        assert encode_factors(read(pool, "biasFactors()((uint32,uint128[])[])")) == p["bias"]
        assert read(pool, "holdings(address,uint32,uint256)(uint128)", trader, 3, 8) == 1_000_000
        assert read(pool, "actualRequiredCollateral()(uint128)") == 1_000_000
        new_quote = read(pool, "quoteBuy(uint32,uint256,uint128)(uint128)", 3, 8, 1_000_000)
        assert new_quote > old_quote
        try:
            rpc("eth_call", [{"from": operator, "to": pool, "data": encoded_update}, "latest"])
        except RpcError as error:
            selector = run([args.cast, "sig", "StaleUpdate()"])
            assert selector in json.dumps(error.payload)
        else:
            raise AssertionError("Stale update unexpectedly accepted")
        transact("sell A AND B", trader, pool, "sell(uint32,uint256,uint128,uint128,uint256)", 3, 8, 1_000_000, 0, close - 1)
        final_cash = read(token, "balanceOf(address)(uint256)", pool)
        final_reserve = read(pool, "pricingReserve()(uint128)")
        profit = read(token, "balanceOf(address)(uint256)", trader) - initial_trader
        assert 0 < profit < added and final_cash >= final_reserve
        assert final_cash == initial_cash + added - profit
        assert read(pool, "actualRequiredCollateral()(uint128)") == 0
        report = {"environment": "disposable_standalone_anvil", "chainId": CHAIN, "genesisTimestamp": genesis_timestamp,
                  "collateral": "mintable mock, not partner AUSD",
                  "pool": pool, "token": token, "modelSha256": digest(model), "snapshotSha256": digest(snapshot),
                  "proposalSha256": digest(unsigned), "artifactSha256": artifacts, "transactions": transactions,
                  "requiredFundingAtoms": str(added), "traderRoundTripProfitAtoms": str(profit),
                  "buyQuoteBeforeAtoms": str(old_quote), "buyQuoteAfterAtoms": str(new_quote),
                  "finalCashAtoms": str(final_cash), "finalReserveAtoms": str(final_reserve),
                  "checks": ["on-chain simulation", "exact proposal hash event", "unchanged holdings/payouts on update",
                             "exact funding delta", "canonical bias", "stale replay rejected", "round-trip cash reconciliation"],
                  "persistentDemoContacted": False, "historicalDataUsed": False, "statisticalGuaranteesClaimed": False,
                  "sourceSha256": {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in [Path(__file__), ROOT / "scripts/build_learning_proposal.py", ROOT / "crates/flurbo-core/examples/parlay_model.rs",
                                   ROOT / "crates/flurbo-core/src/parlay_learning.rs"]}}
        for name, data in [("model", model), ("snapshot", snapshot), ("proposal", unsigned), ("report", report)]:
            (output / f"{name}.json").write_text(json.dumps(data, indent=2) + "\n")
        print(json.dumps({"report": str(output / "report.json"), "fundingAtoms": str(added), "roundTripProfitAtoms": str(profit)}, indent=2))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    main()
