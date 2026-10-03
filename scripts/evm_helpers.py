"""Small EVM ABI and snapshot helpers shared by the legacy readers."""

import re

from check_monad_readiness import CheckError, quantity


# Read-only getter selectors for the deployed synthetic executor.
SELECTORS = {"pool": "16f0115b", "market": "80f55605", "receipt": "e1e6b898",
             "cash": "961be391", "operator": "570ca735", "scope": "6e62d0a8", "mask": "116134ee"}


def words(value, count):
    if not isinstance(value, str) or not re.fullmatch("0x" + "[0-9a-fA-F]{64}" * count, value):
        raise CheckError("Unexpected ABI return shape; stop and recheck the deployed interface")
    return [int(value[2 + index * 64:2 + (index + 1) * 64], 16) for index in range(count)]


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value) or int(value, 16) == 0:
        raise CheckError("Configure nonzero executor, pool, market, receipt, cash and operator addresses")
    return value.lower()


def uint(value, bits=256, positive=True):
    if type(value) is not int or not (int(positive) <= value < 2**bits):
        raise CheckError("Configuration or amount is outside its integer range")
    return value


def abi(selector, *values):
    return "0x" + selector + "".join(f"{uint(value, positive=False):064x}" for value in values)


def block_info(block):
    if not isinstance(block, dict) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", str(block.get("hash", ""))):
        raise CheckError("Invalid block snapshot")
    return quantity(block.get("number")), quantity(block.get("timestamp")), block["hash"].lower()
