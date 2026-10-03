"""Read-only deployment verification and stale-manifest rejection tests."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from check_monad_readiness import CONFIG, CheckError, rpc_endpoint
from scan_arbitrage import abi, SELECTORS
from verify_demo import verify, main, RULES, RULES_HASH

NETWORK = json.loads(CONFIG.read_text())["networks"]["testnet"]


def fixture():
    m = {key: f"0x{i:040x}" for i, key in enumerate(("pool", "receipt", "market", "executor", "operator"), 1)}
    m.update(status="unverified", chain_id=10143, resolver=m["operator"], scope=128, mask=2,
             event_count=8, liquidity_atoms=10000000, closes_at=2000, initial_funding_atoms=55451775,
             rules=RULES, rules_hash=RULES_HASH, cash=NETWORK["contracts"]["ausd"].lower(),
             margin=NETWORK["contracts"]["kuru_margin"].lower())
    return m


class FakeRpc:
    def __init__(self, m):
        self.calls = []
        self.empty_code = False
        self.reorg = False
        self.chain = 10143
        self.values = {}
        def put(key, selector, *values):
            self.values[(m[key], selector)] = list(values)
        for sig, value in {"71be2e4a":8, "1a686502":10000000, "04f3bcec":int(m["resolver"],16),
            "03a79426":int(RULES_HASH,16), "d8dfeb45":int(m["cash"],16), "ec9c6c30":6,
            "39a3a99a":2000, "35add209":55451775, "f3a504f2":1, "3f6fa655":0,
            "7220c660":int(m["receipt"],16), "90fc2c7b":10000000, "b53105a3":10000000}.items():
            put("pool", sig, value)
        for key, sig in SELECTORS.items():
            put("executor", sig, m[key] if key in ("scope", "mask") else int(m[key],16))
        for sig, value in {"16f0115b":int(m["pool"],16), "6e62d0a8":128, "116134ee":2, "313ce567":6, "18160ddd":10000000}.items():
            put("receipt", sig, value)
        put("cash", "313ce567", 6)
        put("margin", "5f71a07c", 1)
        put("market", "90c9427c", 1000000,1000000,int(m["receipt"],16),6,int(m["cash"],16),6,100,10000,100000000,30,10)

    def __call__(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == "eth_chainId": return hex(self.chain)
        if method == "eth_getBlockByNumber":
            return {"number":"0x64", "timestamp":"0x3e8", "hash":"0x"+("bb" if self.reorg and params[0] != "latest" else "aa")*32}
        if method == "eth_getCode": return "0x" if self.empty_code else "0x6000"
        if method != "eth_call": raise AssertionError("unexpected RPC method")
        tx=params[0]
        sig=tx["data"][2:10]
        if sig == "70a08231":
            return abi("", 61652921)
        return abi("", *self.values[(tx["to"],sig)])


class ManifestTests(unittest.TestCase):
    def test_verified_snapshot_has_accounting_and_labels(self):
        m=fixture()
        rpc=FakeRpc(m)
        result=verify(m, NETWORK, rpc)
        self.assertEqual(result["status"],"verified_snapshot")
        self.assertEqual(result["verified_block"],100)
        self.assertEqual(len(result["code_sha256"]),6)
        self.assertEqual(result["events"][7]["label"],"Synthetic event H")
        self.assertEqual(m["status"],"unverified")
        for method,params in rpc.calls:
            if method in ("eth_call","eth_getCode"): self.assertEqual(params[-1],"0x64")

    def test_dry_run_addresses_without_code_and_reorg_fail(self):
        for attr in ("empty_code","reorg"):
            m=fixture(); rpc=FakeRpc(m); setattr(rpc,attr,True)
            with self.subTest(attr=attr), self.assertRaises(CheckError): verify(m,NETWORK,rpc)

    def test_wrong_network_and_rules_fail(self):
        for key,value in (("chain_id",143),("rules","Real election result"),("rules_hash","0x"+"00"*32),("resolver","0x"+"ff"*20)):
            m=fixture(); rpc=FakeRpc(m); m[key]=value
            with self.subTest(key=key), self.assertRaises(CheckError): verify(m,NETWORK,rpc)

    def test_pool_pair_backing_and_executor_mismatches_fail(self):
        for key,sig,value in (("pool","f3a504f2",0),("pool","3f6fa655",1),("pool","7220c660",99),
                              ("pool","90fc2c7b",1),("pool","b53105a3",999999999),
                              ("receipt","313ce567",18),("executor","570ca735",99),("margin","5f71a07c",0)):
            m=fixture(); rpc=FakeRpc(m); rpc.values[(m[key],sig)]=[value]
            with self.subTest(key=key,sig=sig), self.assertRaises(CheckError): verify(m,NETWORK,rpc)
        m=fixture(); rpc=FakeRpc(m); rpc.values[(m["market"],"90c9427c")][-1]=0
        with self.assertRaises(CheckError): verify(m,NETWORK,rpc)

    def test_failed_cli_verification_invalidates_old_output(self):
        with tempfile.TemporaryDirectory() as root:
            manifest=Path(root)/"input.json"; output=Path(root)/"verified.json"
            manifest.write_text(json.dumps(fixture())); output.write_text('{"status":"verified_snapshot"}')
            argv=["verify_demo.py","--manifest",str(manifest),"--output",str(output),"--provider","local"]
            with patch("sys.argv",argv), patch("verify_demo.verify",side_effect=CheckError("failed")), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(),1)
            self.assertEqual(json.loads(output.read_text())["status"],"blocked")

    def test_local_provider_is_fixed_loopback(self):
        self.assertEqual(rpc_endpoint(NETWORK,"local",{}),"http://127.0.0.1:18545")
        self.assertEqual(rpc_endpoint(NETWORK,"public",{}),NETWORK["public_rpc"])


if __name__ == "__main__": unittest.main()
