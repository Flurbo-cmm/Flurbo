"""Flurbo agent SDK for Python (Monad testnet beta, test assets only).

The core modules (claims, abi, amounts, policy, recovery, effects, research, strategy, transaction,
protocol) use only the standard library and follow the shared protocol in protocol/ of the repository.
The runtime package adds chain access, signing (eth-account), a journal, execution, research adapters and
the command-line runner.
"""
from .errors import FlurboError
from .protocol import PROTOCOL_VERSION, CHAIN_ID, COLLATERAL, parse_deployment

__version__ = "0.2.0b0"
__all__ = ["FlurboError", "PROTOCOL_VERSION", "CHAIN_ID", "COLLATERAL", "parse_deployment", "__version__"]
