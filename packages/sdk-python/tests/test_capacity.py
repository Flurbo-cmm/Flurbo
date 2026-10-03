import unittest
from flurbo_sdk.runtime.capacity import permit, cooldown
from flurbo_sdk.errors import FlurboError

class CapacityTests(unittest.TestCase):
    def test_budget_is_shared(self):
        url='https://python-capacity-count.invalid'
        for _ in range(100):
            with permit(url): pass
        with self.assertRaises(FlurboError):
            with permit(url): pass
    def test_concurrency_and_cooldown(self):
        url='https://python-capacity-window.invalid'
        holds=[permit(url) for _ in range(4)]
        for p in holds:p.__enter__()
        with self.assertRaises(FlurboError):
            with permit(url):pass
        for p in holds:p.__exit__(None,None,None)
        with permit(url):cooldown(url,'60')
        with self.assertRaises(FlurboError):
            with permit(url):pass
