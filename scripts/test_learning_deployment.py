"""Fresh learning-deployment acceptance, bytecode integrity and fail-closed output tests."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from check_monad_readiness import CheckError
from scan_arbitrage import abi
from verify_learning_deployment import AUSD, OPERATOR, PLAN, RULES, RULES_HASH, main, match_runtime, verify


def fixture():
    manifest = dict(PLAN, deployment_kind="synthetic_funded_learning_v1", chain_id=10143,
                    rules=RULES, rules_hash=RULES_HASH, closes_at=1_800_604_800, cash=AUSD,
                    operator=OPERATOR, resolver=OPERATOR, updater=OPERATOR,
                    pool="0x" + "11" * 20, pricing_engine="0x" + "22" * 20, base_token_factory="0x" + "33" * 20)
    # Deliberately small synthetic compiler templates, independent of local Forge output.
    # Two copies of each immutable let the test distinguish a modified use from its getter.
    layout = {str(i): [{"start": 1 + i * 64, "length": 32}, {"start": 33 + i * 64, "length": 32}]
              for i in range(15)}
    artifacts = {"pool": {"deployedBytecode": {"object": "0x60" + "00" * 960 + "61", "immutableReferences": layout}},
                 "pricing_engine": {"deployedBytecode": {"object": "0x600161"}},
                 "base_token_factory": {"deployedBytecode": {"object": "0x600261"}}}
    return manifest, artifacts


class FakeRpc:
    def __init__(self, m, artifacts):
        self.calls = []
        self.chain = 10143
        self.reorg = False
        self.timestamp = 1_800_000_000
        self.code = {m[key]: artifact["deployedBytecode"]["object"] for key, artifact in artifacts.items()}
        self.code[AUSD] = "0x6000"
        self.values = {}
        getters = {
            "71be2e4a": 8, "1a686502": 10_000_000, "04f3bcec": int(OPERATOR, 16),
            "03a79426": int(RULES_HASH, 16), "d8dfeb45": int(AUSD, 16), "ec9c6c30": 6,
            "39a3a99a": m["closes_at"], "35add209": 55_451_775,
            "94483919": int(m["base_token_factory"], 16), "2f04002b": int(m["pricing_engine"], 16),
            "df034cd0": int(OPERATOR, 16), "d13daab8": 2_000_000, "ea777612": 10_000_000,
            "fb5bb0c3": 3600, "0964ff26": 60, "f3a504f2": 1, "3f6fa655": 0,
            "7cc96380": 0, "69b4ecc9": 0, "199733be": 0, "e43830e9": 0, "d0530fd0": 0,
            "0019984b": 0, "a88db792": 55_451_775, "b53105a3": 55_451_775}
        for selector, value in getters.items():
            self.values[(m["pool"], abi(selector))] = abi("", value)
        for selector, values in (("a154e571", [32, 8, *range(8)]), ("a5b5433b", [32, 0]), ("c1fe13e9", [32, 0])):
            self.values[(m["pool"], abi(selector))] = abi("", *values)
        self.values[(AUSD, abi("313ce567"))] = abi("", 6)
        self.values[(AUSD, abi("70a08231", int(m["pool"], 16)))] = abi("", 55_451_775)
        self.values[(AUSD, abi("70a08231", int(OPERATOR, 16)))] = abi("", 10_000_000)
        self.values[(AUSD, abi("dd62ed3e", int(OPERATOR, 16), int(m["pool"], 16)))] = abi("", 0)

    def __call__(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method == "eth_chainId": return hex(self.chain)
        if method == "eth_getBlockByNumber":
            return {"number": "0x64", "timestamp": hex(self.timestamp),
                    "hash": "0x" + ("bb" if self.reorg and params[0] != "latest" else "aa") * 32}
        if method == "eth_getCode": return self.code[params[0]]
        if method == "eth_call": return self.values[(params[0]["to"], params[0]["data"])]
        raise AssertionError("Unexpected or write RPC method")


class LearningDeploymentTests(unittest.TestCase):
    def test_separate_manifest_and_all_reads_pinned(self):
        m, artifacts = fixture()
        m["receipt"] = "untrusted field must not survive"
        rpc = FakeRpc(m, artifacts)
        report = verify(m, rpc, artifacts, now=rpc.timestamp)
        self.assertEqual(report["status"], "verified_learning_snapshot")
        self.assertNotEqual(report["status"], "verified_snapshot")
        self.assertNotIn("receipt", report)
        self.assertEqual(report["runtime_evidence"]["pool"]["immutable_groups_checked"], 15)
        self.assertEqual(report["balances"]["pool_collateral_atoms"], 55_451_775)
        for method, params in rpc.calls:
            if method in ("eth_call", "eth_getCode"): self.assertEqual(params[-1], "0x64")

    def test_wrong_manifest_policy_authority_or_token_rejected(self):
        for key, value in (("chain_id", 143), ("cash", OPERATOR), ("updater", AUSD), ("resolver", AUSD),
                           ("operator", AUSD), ("rules", "real events"), ("rules_hash", "0x" + "00" * 32),
                           ("deployment_kind", "ordinary_pool"), *[(key, value + 1) for key, value in PLAN.items()]):
            m, artifacts = fixture(); rpc = FakeRpc(m, artifacts); m[key] = value
            with self.subTest(key=key), self.assertRaises(CheckError):
                verify(m, rpc, artifacts, now=rpc.timestamp)

    def test_every_getter_and_accounting_check_fails_closed(self):
        m, artifacts = fixture()
        for key in FakeRpc(m, artifacts).values:
            rpc = FakeRpc(m, artifacts)
            # Zero invalidates required positive values. One invalidates required zero values.
            old = rpc.values[key]
            rpc.values[key] = abi("", 1 if old == abi("", 0) else 0)
            with self.subTest(call=key), self.assertRaises(CheckError):
                verify(m, rpc, artifacts, now=rpc.timestamp)

    def test_dry_run_addresses_wrong_code_and_helper_substitution_rejected(self):
        for key in ("pool", "pricing_engine", "base_token_factory", "cash"):
            for code in ("0x", "not hex"):
                m, artifacts = fixture(); rpc = FakeRpc(m, artifacts); rpc.code[m[key]] = code
                with self.subTest(key=key, code=code), self.assertRaises(CheckError):
                    verify(m, rpc, artifacts, now=rpc.timestamp)
        for key in ("pool", "pricing_engine", "base_token_factory"):
            m, artifacts = fixture(); rpc = FakeRpc(m, artifacts)
            rpc.code[m[key]] = "0x62" + rpc.code[m[key]][4:]
            with self.subTest(key=key), self.assertRaises(CheckError):
                verify(m, rpc, artifacts, now=rpc.timestamp)

    def test_all_immutable_copies_must_agree(self):
        m, artifacts = fixture()
        code = bytearray.fromhex(artifacts["pool"]["deployedBytecode"]["object"][2:])
        code[32] = 1
        with self.assertRaisesRegex(CheckError, "Inconsistent immutable"):
            match_runtime("0x" + code.hex(), artifacts["pool"], 15)
        code[64] = 1
        match_runtime("0x" + code.hex(), artifacts["pool"], 15)

    def test_chain_reorg_freshness_and_closed_market(self):
        for attr, value in (("chain", 143), ("reorg", True), ("timestamp", 1_799_999_000),
                            ("timestamp", 1_800_000_030), ("timestamp", 1_800_604_800)):
            m, artifacts = fixture(); rpc = FakeRpc(m, artifacts); setattr(rpc, attr, value)
            with self.subTest(attr=attr, value=value), self.assertRaises(CheckError):
                verify(m, rpc, artifacts, now=1_800_000_000 if attr != "timestamp" or value != m["closes_at"] else value)

    def test_failed_verification_removes_prior_success_and_redacts_unexpected_error(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "input.json", Path(folder) / "verified.json"
            source.write_text(json.dumps(fixture()[0])); output.write_text('{"status":"verified_learning_snapshot"}')
            with patch("verify_learning_deployment.load_artifacts", side_effect=ValueError("secret rpc url")), contextlib.redirect_stdout(io.StringIO()):
                code = main(["--manifest", str(source), "--output", str(output)])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(output.read_text())["status"], "blocked")
            self.assertNotIn("secret", output.read_text())
            self.assertEqual(json.loads(source.read_text())["chain_id"], 10143)

    def test_cli_refuses_to_overwrite_input(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stderr(io.StringIO()):
            path = Path(folder) / "manifest.json"; path.write_text("unchanged")
            with self.assertRaises(SystemExit): main(["--manifest", str(path), "--output", str(path)])
            self.assertEqual(path.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
