import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from flurbo_sdk.semantics import semantic_error
from flurbo_sdk.runtime.executor import Executor

F = json.loads((Path(__file__).resolve().parents[3] / 'protocol/fixtures/semantics.json').read_text())

class Semantics(unittest.TestCase):
    def test_conformance(self):
        for c in F['cases']:
            with self.subTest(c['name']):
                self.assertEqual(semantic_error(c['result'], F['deployment'], c['claim'], c['claim']['quantityAtoms'], F['now']), c['error'])

    def test_execution_aborts_before_approval_or_signing(self):
        for code in ('SEMANTIC_COLLISION', 'SEMANTICS_UNKNOWN', 'SEMANTICS_UNAVAILABLE'):
            c = next(c for c in F['cases'] if c['error'] == code)
            entry = dict(id='test', status='planned', action='buy', claim={'scope':3,'mask':'8'}, quantityAtoms='1000000')
            class Journal:
                def locked(self, fn):
                    return fn({'entries':[entry]})
            logs = []
            ex = Executor(None, SimpleNamespace(address='0x'+'4'*40), Journal(), SimpleNamespace(validate_trade=lambda *a: c['result']), None, lambda: (True,None), now=lambda: F['now'], log=lambda code,detail: logs.append(code))
            result = ex.execute(dict(deployment=F['deployment'], action='buy', claim={'scope':3,'mask':8}, quantityAtoms=1000000))
            self.assertEqual(result['reason'], code)
            self.assertIsNone(ex.sign('test', F['deployment']))
            self.assertEqual(entry['status'],'abandoned')
            self.assertEqual(entry['note'],code)
            self.assertIn(code,logs)

    def test_disabled_passes_guard_but_failures_never_do(self):
        disabled = next(c for c in F['cases'] if c['name'] == 'disabled proceeds without semantic assurance')['result']
        def offline(*a):
            raise OSError('offline')
        for validate, expected in ((lambda *a: disabled, None), (offline, 'SEMANTICS_UNAVAILABLE'), (lambda *a: {'code': 'SEMANTICS_UNAVAILABLE'}, 'SEMANTICS_UNAVAILABLE')):
            with self.subTest(expected=expected):
                logs = []
                ex = Executor(None, SimpleNamespace(address='0x'+'4'*40), None, SimpleNamespace(validate_trade=validate), None, lambda: (True, None), now=lambda: F['now'], log=lambda code, detail: logs.append(code))
                self.assertEqual(ex.semantic_check(F['deployment'], {'scope': 3, 'mask': 8}, 1000000), expected)
                self.assertEqual('SEMANTICS_DISABLED' in logs, expected is None)
