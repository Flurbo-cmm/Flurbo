"""Offline failure-path checks for the read-only RPC probe."""

import json
import unittest
from unittest.mock import MagicMock

from check_monad_readiness import CONFIG, CheckError, NoRedirect, Rpc, inspect, rpc_endpoint

NETWORK = json.loads(CONFIG.read_text())["networks"]["testnet"]
BLOCK = {"number": "0x10", "timestamp": "0x20", "hash": "0x" + "ab" * 32}


class FakeRpc:
    def __init__(self, chain=10143, code="0x6000", decimals=6, reorg=False):
        self.chain, self.code, self.decimals, self.reorg = chain, code, decimals, reorg
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "eth_chainId":
            return hex(self.chain)
        if method == "eth_getBlockByNumber":
            if self.reorg and params[0] != "latest":
                return {**BLOCK, "hash": "0x" + "cd" * 32}
            return BLOCK.copy()
        if method == "eth_getCode":
            return self.code
        if method == "eth_call":
            return f"0x{self.decimals:064x}"
        raise AssertionError("Unexpected RPC method")


class ReadinessTests(unittest.TestCase):
    def test_reads_use_one_block_and_only_decimals_call(self):
        rpc = FakeRpc()
        result = inspect(NETWORK, rpc)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["block_hash"], BLOCK["hash"])
        for method, params in rpc.calls:
            if method in {"eth_getCode", "eth_call"}:
                self.assertEqual(params[-1], "0x10")
            if method == "eth_call":
                self.assertEqual(params[0], {"to": NETWORK["contracts"]["ausd"], "data": "0x313ce567"})

    def test_wrong_chain_stops_before_contract_reads(self):
        rpc = FakeRpc(chain=143)
        with self.assertRaises(CheckError):
            inspect(NETWORK, rpc)
        self.assertEqual(rpc.calls, [("eth_chainId", [])])

    def test_empty_code_cannot_pass_and_skips_decimals(self):
        rpc = FakeRpc(code="0x")
        result = inspect(NETWORK, rpc)
        self.assertEqual(result["status"], "fail")
        self.assertIsNone(result["ausd_decimals"])
        self.assertFalse(any(method == "eth_call" for method, _ in rpc.calls))

    def test_wrong_decimals_fail(self):
        self.assertEqual(inspect(NETWORK, FakeRpc(decimals=18))["status"], "fail")

    def test_reorg_does_not_produce_success(self):
        with self.assertRaisesRegex(CheckError, "Snapshot changed"):
            inspect(NETWORK, FakeRpc(reorg=True))

    def test_malformed_code_and_abi_fail_closed(self):
        with self.assertRaises(CheckError):
            inspect(NETWORK, FakeRpc(code="0x0"))
        rpc = FakeRpc()
        with self.assertRaises(CheckError):
            inspect(NETWORK, lambda method, params: "0x06" if method == "eth_call" else rpc(method, params))

    def test_provider_configuration_requires_matching_https_host(self):
        name = NETWORK["alchemy_env"]
        for url in ["http://monad-testnet.g.alchemy.com/v2/secret", "https://example.com/v2/secret",
                    "https://monad-mainnet.g.alchemy.com/v2/secret", "https://monad-testnet.g.alchemy.com/v2/",
                    "https://user:secret@monad-testnet.g.alchemy.com/v2/key"]:
            with self.assertRaises(CheckError) as error:
                rpc_endpoint(NETWORK, "alchemy", {name: url})
            self.assertNotIn("secret", str(error.exception))
        with self.assertRaises(CheckError):
            rpc_endpoint(NETWORK, "alchemy", {})
        url = "https://monad-testnet.g.alchemy.com/v2/local-test-key"
        self.assertEqual(rpc_endpoint(NETWORK, "alchemy", {name: url}), url)

    def test_quicknode_endpoint_must_be_for_the_same_network(self):
        name = NETWORK["alchemy_env"]
        url = "https://little-dawn-cloud.monad-testnet.quiknode.pro/local-test-token/"
        self.assertEqual(rpc_endpoint(NETWORK, "quicknode", {name: url}), url)
        for bad in ["https://little-dawn-cloud.monad-mainnet.quiknode.pro/secret/", "https://little-dawn-cloud.monad-testnet.quiknode.pro/",
                    "https://a.b.monad-testnet.quiknode.pro/secret/", "https://monad-testnet.quiknode.pro.evil.com/secret/",
                    "http://little-dawn-cloud.monad-testnet.quiknode.pro/secret/"]:
            with self.assertRaises(CheckError) as error:
                rpc_endpoint(NETWORK, "quicknode", {name: bad})
            self.assertNotIn("secret", str(error.exception))

    def test_no_write_method_or_redirect_allowed(self):
        rpc = Rpc("https://example.com")
        with self.assertRaises(CheckError):
            rpc("eth_sendRawTransaction", ["0x"])
        self.assertEqual(rpc.counter, 0)
        with self.assertRaises(CheckError):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example")

    def test_remote_errors_bad_envelopes_and_transport_do_not_leak_secrets(self):
        cases = [b'not json SECRET',
                 json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"message": "SECRET"}}).encode(),
                 json.dumps({"jsonrpc": "2.0", "id": 99, "result": "SECRET"}).encode()]
        for body in cases:
            rpc = Rpc("https://example.com/v2/SECRET")
            rpc.opener = MagicMock()
            rpc.opener.open.return_value.__enter__.return_value.read.return_value = body
            with self.assertRaises(CheckError) as error:
                rpc("eth_chainId", [])
            self.assertNotIn("SECRET", str(error.exception))
        rpc = Rpc("https://example.com/v2/SECRET")
        rpc.opener = MagicMock()
        rpc.opener.open.side_effect = OSError("https://example.com/v2/SECRET")
        with self.assertRaises(CheckError) as error:
            rpc("eth_chainId", [])
        self.assertNotIn("SECRET", str(error.exception))


if __name__ == "__main__":
    unittest.main()
