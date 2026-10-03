"""Local-only model and constrained setup for the browser learning laboratory."""
from decimal import Decimal, localcontext
import json
import re
import threading
import urllib.request

from build_learning_proposal import build, digest, distribution, value_at
from rehearse_learning_update import ROOT, UPDATE_SIG, abi_value, run, RpcError

CHAIN = 31339
RPC_URL = "http://127.0.0.1:18548"


class LocalRpc:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def __call__(self, method, params=None):
        request = urllib.request.Request(RPC_URL, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
            "params": params or []}).encode(), {"Content-Type": "application/json"})
        with self.opener.open(request, timeout=15) as response:
            result = json.load(response)
        if result.get("id") != 1 or "error" in result:
            raise RpcError(result.get("error", "response mismatch"))
        return result["result"]


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value) or int(value, 16) == 0:
        raise ValueError("Use a valid public test-wallet address")
    return value.lower()


class LearningLab:
    def __init__(self, cast, model, rpc=None):
        self.cast, self.model, self.rpc = cast, model, rpc or LocalRpc()
        self.lock = threading.Lock()
        self.owner = self.pool = self.token = None
        self.operator = self.rpc("eth_accounts")[0]
        boot = self.rpc("eth_getBlockByNumber", ["latest", False])
        self.checkpoint = {"number": boot["number"], "hash": boot["hash"]}

    def encode(self, signature, *values):
        return run([self.cast, "calldata", signature, *map(abi_value, values)])

    def read(self, to, signature, *values, tag="latest"):
        raw = self.rpc("eth_call", [{"to": to, "data": self.encode(signature.split(")(")[0] + ")", *values)}, tag])
        return json.loads(run([self.cast, "abi-decode", signature, raw, "--json"]))[0]

    def identity(self):
        if "anvil" not in self.rpc("web3_clientVersion").lower() or int(self.rpc("eth_chainId"), 16) != CHAIN:
            raise ValueError("Learning lab node identity changed")
        if self.rpc("eth_getBlockByNumber", [self.checkpoint["number"], False])["hash"] != self.checkpoint["hash"]:
            raise ValueError("Learning lab checkpoint changed; restart the lab")

    def send_setup(self, data, to=None):
        # Only setup code calls this: no route accepts arbitrary calldata or destinations.
        tx = {"from": self.operator, "data": data}
        if to:
            tx["to"] = to
        tx["gas"] = hex(int(self.rpc("eth_estimateGas", [tx]), 16) * 12 // 10)
        tx_hash = self.rpc("eth_sendTransaction", [tx])
        self.rpc("evm_mine")
        receipt = self.rpc("eth_getTransactionReceipt", [tx_hash])
        if not receipt or receipt["status"] != "0x1":
            raise ValueError("Local setup transaction failed")
        return receipt

    def deploy(self, name, signature, *values):
        artifact = json.loads((ROOT / f"target/foundry/out/{name}.sol/{name}.json").read_text())
        args = run([self.cast, "abi-encode", signature, *map(abi_value, values)])
        return self.send_setup(artifact["bytecode"]["object"] + args[2:])["contractAddress"]

    def setup(self, owner):
        owner = address(owner)
        self.identity()
        if self.owner and self.owner != owner:
            raise ValueError("This lab belongs to another test account; select that account or restart the lab")
        if self.pool is None:
            self.owner = owner
            if self.token is None:
                self.token = self.deploy("MockCollateral", "f(uint8)", 6)
            timestamp = int(self.rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
            self.pool = self.deploy("FundedFactoredPool", "f((address,uint8,uint128,uint64,uint8[],address,bytes32),(address,uint128,uint128,uint64,uint64))",
                (self.token, 2, 10_000_000, timestamp + 7 * 86400, [0, 1], self.operator, "0x" + "44" * 32),
                (owner, 5_000_000, 20_000_000, 3600, 5))
        if not self.read(self.pool, "funded()(bool)"):
            self.send_setup(self.encode("mint(address,uint256)", self.operator, 20_000_000), self.token)
            self.send_setup(self.encode("approve(address,uint256)", self.pool, 20_000_000), self.token)
            self.send_setup(self.encode("fund()"), self.pool)
        balance = self.read(self.token, "balanceOf(address)(uint256)", owner)
        if balance < 100_000_000:
            self.send_setup(self.encode("mint(address,uint256)", owner, 100_000_000 - balance), self.token)
        if int(self.rpc("eth_getBalance", [owner, "latest"]), 16) < 10**19:
            self.rpc("anvil_setBalance", [owner, hex(10**19)])
        return self.state()

    def snapshot(self):
        block = self.rpc("eth_getBlockByNumber", ["latest", False])
        tag = block["number"]
        def read(signature, *values):
            return self.read(self.pool, signature, *values, tag=tag)
        def factors(rows):
            return [{"scope": str(s), "values": list(map(str, v))} for s, v in rows]
        return {"schema": "flurbo.funded-snapshot.v1", "chainId": str(CHAIN), "pool": self.pool,
            "blockNumber": str(int(tag, 16)), "blockHash": block["hash"], "timestamp": str(int(block["timestamp"], 16)),
            "closesAt": str(read("closesAt()(uint64)")), "revision": str(read("revision()(uint256)")),
            "liquidity": str(read("liquidity()(uint128)")), "maxBiasMovement": str(read("maxBiasMovement()(uint128)")),
            "events": 2, "decimals": 6, "order": [0, 1], "factors": factors(read("factors()((uint32,uint128[])[])")),
            "biasFactors": factors(read("biasFactors()((uint32,uint128[])[])"))}

    def state(self):
        self.identity()
        result = {"chainId": CHAIN, "rpcUrl": RPC_URL, "checkpoint": self.checkpoint,
                  "owner": self.owner, "pool": self.pool, "token": self.token, "collateralLabel": "Mock collateral",
                  "modelSource": self.model["source"], "modelSha256": digest(self.model)}
        if self.pool is None:
            return result
        snap = self.snapshot()
        tag = hex(int(snap["blockNumber"]))
        result["snapshot"] = snap
        for key, signature in [("reserveAtoms", "requiredCollateral()(uint128)"), ("payoutAtoms", "actualRequiredCollateral()(uint128)"),
                               ("epochSpentAtoms", "epochFundingSpent()(uint128)"), ("epochLimitAtoms", "epochFundingLimit()(uint128)")]:
            result[key] = str(self.read(self.pool, signature, tag=tag))
        result["balanceAtoms"] = str(self.read(self.token, "balanceOf(address)(uint256)", self.owner, tag=tag))
        result["poolBalanceAtoms"] = str(self.read(self.token, "balanceOf(address)(uint256)", self.pool, tag=tag))
        result["allowanceAtoms"] = str(self.read(self.token, "allowance(address,address)(uint256)", self.owner, self.pool, tag=tag))
        result["holdingsAtoms"] = str(self.read(self.pool, "holdings(address,uint32,uint256)(uint128)", self.owner, 3, 8, tag=tag))
        if self.rpc("eth_getBlockByNumber", [tag, False])["hash"] != snap["blockHash"]:
            raise ValueError("Snapshot was reorganized")
        return result

    def prepare(self, kind):
        if kind not in ("buy", "sell", "learn") or not self.pool:
            raise ValueError("Set up the test account before reviewing an action")
        state = self.state()
        snap = state["snapshot"]
        timestamp, close = int(snap["timestamp"]), int(snap["closesAt"])
        deadline = min(timestamp + 120, close - 1)
        if deadline <= timestamp:
            raise ValueError("This synthetic market has closed; restart the lab")
        tag = hex(int(snap["blockNumber"]))
        plan = {"kind": kind, "owner": self.owner, "pool": self.pool, "token": self.token,
                "chainId": CHAIN, "snapshot": snap, "deadline": str(deadline), "quantityAtoms": "1000000",
                "value": "0x0", "details": {}}
        if kind == "learn":
            unsigned = build(self.model, snap, max_funding="5000000", deadline=str(deadline))
            p = unsigned["proposal"]
            if p["bias"] == snap["biasFactors"]:
                raise ValueError("This model is already applied. Trade a claim first to test another update")
            market = (2, snap["liquidity"], 6, [(r["scope"], r["values"]) for r in snap["factors"]], [0, 1])
            bias = [(r["scope"], r["values"]) for r in p["bias"]]
            engine = self.read(self.pool, "pricingEngine()(address)", tag=tag)
            reserve = self.read(engine, "reserve((uint8,uint128,uint8,(uint32,uint128[])[],uint8[]),(uint32,uint128[])[])(uint128)", market, bias, tag=tag)
            needed = max(0, reserve - int(state["poolBalanceAtoms"]))
            if needed > 5_000_000:
                raise ValueError("Update exceeds this lab's 5-token funding cap")
            p["maxFunding"] = str(needed)
            plan["proposal"] = p
            with localcontext() as context:
                context.prec = 80
                q = {int(r["scope"]): list(map(int, r["values"])) for r in snap["factors"]}
                a = {int(r["scope"]): list(map(int, r["values"])) for r in snap["biasFactors"]}
                before = distribution([Decimal(value_at(q, x) + value_at(a, x)) / int(snap["liquidity"]) for x in range(4)])[3]
            plan["details"] = {"probabilityBefore": str(before), "probabilityAfter": unsigned["diagnostics"]["impliedDistribution"][3],
                "quantizationBound": unsigned["diagnostics"]["totalVariationUpperBound"], "modelSha256": unsigned["modelSha256"],
                "snapshotSha256": unsigned["snapshotSha256"], "reserveAfterAtoms": str(reserve), "fundingAtoms": str(needed)}
            call = self.encode(UPDATE_SIG, (p["chainId"], p["pool"], p["expectedRevision"], p["deadline"], p["maxFunding"], bias))
            plan["limitAtoms"] = str(needed)
        else:
            if kind == "sell" and int(state["holdingsAtoms"]) < 1_000_000:
                raise ValueError("You need one A AND B unit to sell")
            quote = self.read(self.pool, "quoteBuy(uint32,uint256,uint128)(uint128)" if kind == "buy" else "quoteSell(uint32,uint256,uint128)(uint128)", 3, 8, 1_000_000, tag=tag)
            limit = min(1_000_000, (quote * 10050 + 9999) // 10000) if kind == "buy" else quote * 9950 // 10000
            needed = limit if kind == "buy" else 0
            plan["limitAtoms"], plan["details"] = str(limit), {"quoteAtoms": str(quote)}
            call = self.encode(f"{kind}(uint32,uint256,uint128,uint128,uint256)", 3, 8, 1_000_000, limit, deadline)
        if int(state["balanceAtoms"]) < needed:
            raise ValueError("Not enough mock collateral. Use Set up test account to top up")
        plan["action"] = "approve" if int(state["allowanceAtoms"]) < needed else kind
        plan["to"] = self.token if plan["action"] == "approve" else self.pool
        plan["data"] = self.encode("approve(address,uint256)", self.pool, needed) if plan["action"] == "approve" else call
        # The exact contract call is simulated when allowance suffices. An approval plan is
        # only permission to approve; it must be followed by a fresh, simulated action review.
        self.rpc("eth_call", [{"from": self.owner, "to": plan["to"], "data": plan["data"]}, tag])
        return plan
