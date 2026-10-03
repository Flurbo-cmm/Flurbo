import unittest
from unittest.mock import patch

from dashboard_data import Dashboard, DashboardRpc, TRADED, REDEEMED, WRAPPED, UNWRAPPED
from check_monad_readiness import CheckError
from portfolio_data import portfolio, CACHE, STARTS, CREATIONS
from serve_dashboard import route

POOL = next(iter(STARTS))
START = STARTS[POOL]
WALLET = '0x' + '11' * 20
OTHER = '0x' + '22' * 20


def word(n): return f'{n:064x}'
def log(block, index, topic=TRADED, owner=WALLET, scope=3, mask=8, buy=True):
    values = [int(buy), 1000000, 250000] if topic == TRADED else [1000000, 1000000] if topic == REDEEMED else [1000000]
    return {'address': POOL, 'topics': [topic, '0x' + word(int(owner, 16)), '0x' + word(scope), '0x' + word(mask)],
            'data': '0x' + ''.join(word(n) for n in values), 'blockNumber': hex(block), 'logIndex': hex(index),
            'transactionIndex': hex(index), 'transactionHash': '0x' + word(block * 100 + index),
            'blockHash': '0x' + word(block), 'removed': False}


class Model(Dashboard):
    def __init__(self):
        self.m = {'pool': POOL, 'cash': OTHER, 'environment': 'public_testnet', 'verified_block_hash': 'fixture'}
        self.number = START + 10
        self.logs, self.ranges, self.balances = [], [], {(3, 8): 1000000}
        self.reject, self.reorg, self.during_scan, self.resolved = False, None, False, False
        self.creation = {'transactionHash': CREATIONS[POOL], 'status': '0x1', 'to': None,
                         'contractAddress': POOL, 'blockNumber': hex(START), 'blockHash': '0x' + word(START)}
    def begin(self): self.tag = hex(self.number)
    def rpc(self, method, params):
        if method == 'eth_getCode': raise CheckError('Archive state is unavailable')
        if method == 'eth_getTransactionReceipt': return self.creation
        if method == 'eth_getBlockByNumber':
            n = int(params[0], 16)
            return {'number': hex(n), 'timestamp': '0x10', 'hash': '0x' + word(n + (1 if self.reorg == n else 0))}
        if method == 'eth_getLogs':
            f, t = int(params[0]['fromBlock'], 16), int(params[0]['toBlock'], 16)
            self.ranges.append((f, t))
            if self.reject: raise CheckError('Provider failure')
            if self.during_scan: self.reorg = t
            return [e for e in self.logs if f <= int(e['blockNumber'], 16) <= t]
        raise AssertionError(method)
    def state(self): return {'resolved': self.resolved, 'resolved_state': 3 if self.resolved else None}
    def call(self, key, selector, *args, **kwargs): return [self.balances.get(tuple(args[-2:]), 0)]
    def balance(self, *args): return 10000000
    def finish(self, payload): return {**payload, 'snapshot': {'block_number': self.number, 'stale': False}}


class PortfolioTests(unittest.TestCase):
    def setUp(self): CACHE.clear(); self.model = Model()

    def test_creation_receipt_replaces_archive_reads_and_includes_creation_block_events(self):
        m = self.model; m.logs = [log(START, 0)]
        self.assertEqual(portfolio(m, WALLET)['history_count'], 1)
        self.assertEqual(m.ranges[0][0], START)

    def test_invalid_creation_receipt_never_starts_or_caches_a_scan(self):
        original = dict(self.model.creation)
        for field, value in [('transactionHash', '0x' + word(1)), ('status', '0x0'),
                             ('to', OTHER), ('contractAddress', OTHER), ('blockNumber', hex(START + 1)),
                             ('blockHash', '0x' + word(1)), ('status', 1)]:
            with self.subTest(field=field, value=value):
                self.model.creation = {**original, field: value}
                with self.assertRaises(CheckError): portfolio(self.model, WALLET)
                self.assertFalse(CACHE); self.assertFalse(self.model.ranges)
        self.model.creation = None
        with self.assertRaises(CheckError): portfolio(self.model, WALLET)
        self.assertFalse(CACHE)

    def test_creation_reorg_and_future_boundary_are_rejected(self):
        m = self.model; m.reorg = START
        with self.assertRaises(CheckError): portfolio(m, WALLET)
        self.assertFalse(CACHE)
        m.reorg = None; m.number = START - 1
        with self.assertRaises(CheckError): portfolio(m, WALLET)
        self.assertFalse(CACHE)

    def test_receipt_transport_failure_can_be_retried_without_skipping_history(self):
        m = self.model
        with patch.object(m, 'rpc', side_effect=CheckError('Receipt read interrupted')):
            with self.assertRaises(CheckError): portfolio(m, WALLET)
        self.assertFalse(CACHE); self.assertFalse(m.ranges)
        m.logs = [log(START, 0)]
        self.assertEqual(portfolio(m, WALLET)['history_count'], 1)

    def test_discovers_unselected_combinations_and_checks_current_holdings(self):
        m = self.model
        m.logs = [log(START + 1, 0), log(START + 2, 1, scope=7, mask=128), log(START + 2, 2, owner=OTHER)]
        m.balances[(7, 128)] = 2000000
        result = route(m, f'/api/portfolio?wallet={WALLET}')
        self.assertTrue(result['index']['complete'])
        self.assertEqual(result['position_count'], 2)
        self.assertEqual(result['history_count'], 2)
        self.assertEqual(result['positions'][1]['quantity_atoms'], '2000000')
        m.balances[(3, 8)] = 0; m.number += 1
        m.logs.append(log(m.number, 0, buy=False))
        result = portfolio(m, WALLET)
        self.assertEqual(result['position_count'], 1)
        self.assertFalse(result['history'][0]['is_buy'])
        self.assertEqual(m.ranges[-1], (m.number, m.number))
        self.assertEqual(portfolio(m, OTHER)['history_count'], 1)

    def test_incomplete_scan_never_presents_empty_positions_and_resumes(self):
        m = self.model; m.number = START + 5010
        m.logs = [log(START + 5005, 0)]
        result = portfolio(m, WALLET)
        self.assertFalse(result['index']['complete'])
        self.assertIsNone(result['positions']); self.assertIsNone(result['history'])
        result = portfolio(m, WALLET)
        self.assertTrue(result['index']['complete']); self.assertEqual(result['position_count'], 1)
        self.assertEqual(m.ranges, [(START, START + 4999), (START + 5000, m.number)])

    def test_failed_range_never_advances_and_smaller_retry_keeps_events(self):
        m = self.model; m.reject = True
        with self.assertRaises(CheckError): portfolio(m, WALLET)
        self.assertEqual(next(iter(CACHE.values()))['end'], START - 1)
        self.assertEqual(next(iter(CACHE.values()))['span'], 2500)
        m.reject = False; m.logs = [log(START, 0)]
        self.assertEqual(portfolio(m, WALLET)['history_count'], 1)

    def test_reorg_restarts_and_discards_orphan_events(self):
        m = self.model; m.logs = [log(START, 0)]
        portfolio(m, WALLET)
        m.reorg = m.number; m.logs = []
        result = portfolio(m, WALLET)
        self.assertEqual(result['history_count'], 0); self.assertEqual(m.ranges[-1][0], START)

    def test_reorg_during_scan_and_malformed_or_duplicate_logs_do_not_commit(self):
        m = self.model; m.during_scan = True
        with self.assertRaises(CheckError): portfolio(m, WALLET)
        self.assertFalse(CACHE)
        m.during_scan = False; m.reorg = None
        for field, value in [('removed', True), ('address', OTHER), ('topics', []), ('data', '0x')]:
            bad = log(START, 0); bad[field] = value; m.logs = [bad]
            with self.assertRaises((CheckError, ValueError)): portfolio(m, WALLET)
            self.assertFalse(CACHE)
        m.logs = [log(START, 0), log(START, 0)]
        with self.assertRaises(CheckError): portfolio(m, WALLET)

    def test_conversions_redemption_and_empty_wallet(self):
        m = self.model; m.resolved = True
        m.logs = [log(START, 0, topic=WRAPPED, scope=1, mask=2), log(START + 1, 0, topic=UNWRAPPED, scope=1, mask=2), log(START + 2, 0, topic=REDEEMED)]
        m.balances = {(1, 2): 1000000}
        result = portfolio(m, WALLET)
        self.assertEqual(result['positions'][0]['redeemable_atoms'], '1000000')
        self.assertEqual([e['kind'] for e in result['history']], ['redemption', 'unwrap', 'wrap'])
        result = portfolio(m, OTHER)
        self.assertEqual(result['positions'], []); self.assertEqual(result['history'], [])

    def test_history_pagination_and_invalid_input(self):
        m = self.model; m.logs = [log(START, i) for i in range(25)]
        self.assertEqual(len(portfolio(m, WALLET)['history']), 20)
        self.assertEqual(len(portfolio(m, WALLET, history_page=1)['history']), 5)
        with self.assertRaises(ValueError): portfolio(m, WALLET, page=-1)
        with self.assertRaises(CheckError): portfolio(m, 'bad')
        with self.assertRaises(ValueError): route(m, f'/api/portfolio?wallet={WALLET}&wallet={OTHER}')
        with patch.dict(STARTS, {POOL: START + 1}):
            CACHE.clear()
            with self.assertRaises(CheckError): portfolio(m, WALLET)

    def test_stale_log_block_is_rejected_even_when_range_checkpoint_matches(self):
        m = self.model; m.logs = [log(START, 0)]
        m.logs[0]['blockHash'] = '0x' + word(START + 100)
        with self.assertRaises(CheckError): portfolio(m, WALLET)
        self.assertFalse(CACHE)

    def test_original_and_learning_caches_are_separate(self):
        m = self.model; m.logs = [log(START, 0)]
        portfolio(m, WALLET)
        learning = list(STARTS)[1]
        m.m = {**m.m, 'pool': learning, 'updater': WALLET}
        m.creation = {**m.creation, 'transactionHash': CREATIONS[learning], 'contractAddress': learning}
        m.logs = []
        with patch.dict(STARTS, {learning: START}):
            result = portfolio(m, WALLET)
        self.assertEqual(result['market_id'], 'learning')
        self.assertEqual(result['positions'], [])
        self.assertEqual(len(CACHE), 2)

    def test_public_rpc_uses_batched_hundred_block_ranges_and_checks_event_blocks(self):
        m = self.model; m.number = START + 1050; m.logs = [log(START + 500, 0)]
        delegate = m.rpc
        class Batch(DashboardRpc):
            url = 'https://testnet-rpc.monad.xyz'
            def __init__(self): self.batches = []
            def __call__(self, method, params): return delegate(method, params)
            def pace(self, count): pass
            def prefetch(self, calls): pass
            def read_batch(self, payload, keys):
                self.batches.append(payload)
                return {keys[p['id']]: delegate(p['method'], p['params']) for p in payload}
        m.rpc = Batch()
        first = portfolio(m, WALLET)
        self.assertFalse(first['index']['complete'])
        self.assertEqual(len(m.ranges), 10)
        self.assertTrue(all(end - start == 99 for start, end in m.ranges))
        self.assertEqual(len(m.rpc.batches[0]), 10)
        self.assertEqual(m.rpc.batches[1][0]['method'], 'eth_getBlockByNumber')
        second = portfolio(m, WALLET)
        self.assertTrue(second['index']['complete']); self.assertEqual(second['position_count'], 1)


if __name__ == '__main__': unittest.main()
