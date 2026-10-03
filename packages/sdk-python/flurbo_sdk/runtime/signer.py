"""The only place a transaction is signed. Keys stay in the operator's runtime: never sent to Flurbo, never
logged, never placed in a model prompt. Remote signers (a KMS or a signing service) implement the same
interface: an `address` attribute and `sign_transaction` / `sign_message` methods."""
import os
import re
from typing import Protocol

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak

from ..errors import FlurboError


class Signer(Protocol):
    address: str
    kind: str

    def sign_transaction(self, tx: dict) -> str: ...

    def sign_message(self, message: str) -> str: ...


def _hex(b: bytes) -> str:
    h = b.hex()
    return h if h.startswith("0x") else "0x" + h


class LocalKeySigner:
    kind = "local-key"

    def __init__(self, private_key: str):
        if not isinstance(private_key, str) or not re.match(r"^0x[0-9a-fA-F]{64}$", private_key):
            raise FlurboError("invalid_input", "The agent key must be 32 bytes of hex with a 0x prefix.")
        self._account = Account.from_key(private_key)
        self.address = self._account.address.lower()

    def sign_transaction(self, tx: dict) -> str:
        """tx: chainId, nonce, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas (EIP-1559)."""
        signed = self._account.sign_transaction({"type": 2, "chainId": tx["chainId"], "nonce": tx["nonce"], "to": _checksum(tx["to"]), "data": tx["data"],
                                                 "value": tx["value"], "gas": tx["gas"], "maxFeePerGas": tx["maxFeePerGas"], "maxPriorityFeePerGas": tx["maxPriorityFeePerGas"]})
        return _hex(signed.raw_transaction)

    def sign_message(self, message: str) -> str:
        return _hex(self._account.sign_message(encode_defunct(text=message)).signature)

    def __repr__(self) -> str:  # never print key material
        return f"LocalKeySigner({self.address})"


def _checksum(address: str) -> str:
    from eth_utils import to_checksum_address
    return to_checksum_address(address)


def signer_from_env(variable: str, env: dict | None = None) -> LocalKeySigner:
    """Reads the key from an environment variable. The value is never echoed, even in errors."""
    value = (env if env is not None else os.environ).get(variable)
    if not value:
        raise FlurboError("invalid_input", f"Set {variable} to the dedicated agent wallet key (testnet only). Never use a deployer, settlement, reviewer or personal wallet.")
    return LocalKeySigner(value.strip())


def transaction_hash(raw: str) -> str:
    return _hex(keccak(hexstr=raw))


def keccak_hex(data: str) -> str:
    return _hex(keccak(hexstr=data))
