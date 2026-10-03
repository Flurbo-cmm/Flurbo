"""Learning trading reads stay pinned to their own pool and reject changed evidence."""
import copy
import hashlib
import json
from pathlib import Path
import unittest

from check_monad_readiness import CheckError
from learning_dashboard import LearningDashboard, POOL, AUSD, OPERATOR
from serve_dashboard import route

BASE = json.loads((Path(__file__).resolve().parents[1] / 'config/learning-testnet.json').read_text())
NETWORK = {"contracts": {"ausd": AUSD}}
HASH = "0x" + "ab" * 32
word = lambda *values: "0x" + "".join(f"{v:064x}" for v in values)


class Rpc:
    def __init__(self, m):
        self.m = m
        self.calls = []
        self.chain = "0x279f"
        self.code = "0x6001"
        self.reorg = False
        self.cash = 55967320
        self.required = 55967320
        self.resolved = False
        self.values = {"f3a504f2": 1, "a88db792": 55967320, "0019984b": 1000000,
                       "7cc96380": 2, "69b4ecc9": 1, "a6a83dde": 279955, "f29d0ba9": 259000,
                       "dd62ed3e": 500000, "90fc2c7b": 1000000, "1bb51c6a": 3}

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "eth_chainId": return self.chain
        if method == "eth_getCode": return self.code
        if method == "eth_getBalance": return hex(10**19)
        if method == "eth_getBlockByNumber":
            number = self.m["verified_block"] if params[0] == hex(self.m["verified_block"]) else self.m["verified_block"] + 20
            anchor = number == self.m["verified_block"]
            return {"number": hex(number), "timestamp": hex(self.m["verified_timestamp"] + 60),
                    "hash": self.m["verified_block_hash"] if anchor else "0x" + "cd" * 32 if self.reorg and params[0] != 'latest' else HASH}
        if method == 'eth_getTransactionByHash': return None
        if method == 'eth_getTransactionReceipt': return None
        if method != "eth_call": raise AssertionError("No writes permitted")
        tx = params[0]; selector = tx["data"][2:10]
        if selector == "70a08231": return word(self.cash if tx['data'][10:] == POOL[2:].rjust(64, '0') else 10000000)
        if selector == "b53105a3": return word(self.required)
        if selector == "3f6fa655": return word(int(self.resolved))
        return word(self.values[selector])


def fixture():
    m = copy.deepcopy(BASE)
    sha = hashlib.sha256(bytes.fromhex('6001')).hexdigest()
    m['cash_proxy_sha256'] = sha
    for evidence in m['runtime_evidence'].values(): evidence['runtime_sha256'] = sha
    rpc = Rpc(m)
    model = LearningDashboard(m, NETWORK, rpc, 'public_testnet', lambda: m['verified_timestamp'] + 60)
    return model, rpc, m


class LearningTradingTests(unittest.TestCase):
    def test_state_holdings_quotes_and_read_routes_are_learning_only(self):
        model, rpc, _ = fixture()
        state = route(model, f'/api/state?wallet={OPERATOR}&claims=3:8')
        self.assertEqual(state['market_id'], 'learning')
        self.assertEqual(state['contracts']['pool'], POOL)
        self.assertEqual(state['wallet']['positions'][0]['quantity_atoms'], '1000000')
        self.assertEqual(state['wallet']['pool_allowance_atoms'], '500000')
        self.assertNotIn('receipt', state['contracts'])
        self.assertFalse(state['capabilities']['kuru'])
        self.assertFalse(state['conversion_available'])
        self.assertTrue(state['trading_available'])
        for side, price in [('buy', '279955'), ('sell', '259000')]:
            quote = route(model, f'/api/quote?side={side}&scope=3&mask=8&quantity=1000000')
            self.assertEqual(quote['quote']['collateral_atoms'], price)
            self.assertEqual(quote['market_id'], 'learning')
            self.assertEqual(quote['contracts']['pool'], POOL)
        for method, params in rpc.calls:
            if method == 'eth_call':
                self.assertIn(params[0]['to'], [POOL, AUSD])
                self.assertEqual(params[1], hex(BASE['verified_block'] + 20))

    def test_changed_manifest_chain_runtime_and_reorg_are_rejected(self):
        for key, value in [('pool', AUSD), ('cash', POOL), ('environment', 'local_fork'), ('status', 'verified_snapshot')]:
            model, rpc, m = fixture(); m[key] = value
            with self.assertRaises(CheckError): LearningDashboard(m, NETWORK, rpc, 'public_testnet')
        for key, value in [('chain', '0x1'), ('code', '0x6002'), ('reorg', True)]:
            model, rpc, _ = fixture(); setattr(rpc, key, value)
            with self.assertRaises(CheckError): model.snapshot()

    def test_shortfall_stale_closed_resolved_and_wrong_reserve_never_allow_trading(self):
        model, rpc, m = fixture(); rpc.cash = 55967319
        self.assertFalse(model.snapshot()['trading_available'])
        self.assertIsNone(model.quote('buy', 3, 8, 1000000)['quote'])
        model, rpc, m = fixture(); model.clock = lambda: m['verified_timestamp'] + 100
        self.assertFalse(model.snapshot()['trading_available'])
        self.assertIsNone(model.quote('buy', 3, 8, 1000000)['quote'])
        model, rpc, m = fixture(); model.m['closes_at'] = m['verified_timestamp'] + 59
        self.assertFalse(model.snapshot()['trading_available'])
        model, rpc, _ = fixture(); rpc.resolved = True; rpc.required = 1000000
        state = model.snapshot(OPERATOR, [(3, 8)])
        self.assertFalse(state['trading_available']); self.assertTrue(state['redemption_available'])
        self.assertEqual(state['wallet']['positions'][0]['redeemable_atoms'], '1000000')
        model, rpc, _ = fixture(); rpc.required = 0
        with self.assertRaises(CheckError): model.snapshot()

    def test_invalid_claims_and_excessive_queries_are_rejected(self):
        model, _, _ = fixture()
        for path in ['/api/state?claims=3:8&claims=1:2', '/api/state?claims=255:2',
                     '/api/quote?side=buy&scope=3&mask=8&quantity=0', '/api/state?claims=' + ','.join(['1:2'] * 17)]:
            with self.assertRaises(ValueError): route(model, path)
        self.assertEqual(model.transaction('0x' + '11' * 32)['market_id'], 'learning')


if __name__ == '__main__': unittest.main()
