"""ABI encoding for the protocol's calls: every argument is a static type (protocol/specs/contracts.md).

Selectors and event topics are fixed by the protocol and checked against protocol/fixtures/calldata.json.
"""
import re

from .errors import FlurboError

SELECTORS = {
    "buy": "0x3e6b6cde", "sell": "0xc39849c5", "redeem": "0xdf992423", "quoteBuy": "0xa6a83dde", "quoteSell": "0xf29d0ba9",
    "holdings": "0x90fc2c7b", "payoutFraction": "0xf0f54950", "closesAt": "0x39a3a99a", "eventCount": "0x71be2e4a", "collateral": "0xd8dfeb45",
    "collateralDecimals": "0xec9c6c30", "settlementRulesHash": "0x03a79426", "resolved": "0x3f6fa655", "resolvedState": "0x1bb51c6a",
    "voidMask": "0x91187684", "funded": "0xf3a504f2", "approve": "0x095ea7b3", "allowance": "0xdd62ed3e", "balanceOf": "0x70a08231", "decimals": "0x313ce567",
}
TOPICS = {
    "Traded": "0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5",
    "Redeemed": "0x3e24bbc5ae535f3f571a815b8ba9fc70c94ad494d812f0210c3da99fad2173ae",
}
_SIGNATURES = {
    "buy": ["uint32", "uint256", "uint128", "uint128", "uint256"], "sell": ["uint32", "uint256", "uint128", "uint128", "uint256"],
    "redeem": ["uint32", "uint256", "uint128"], "quoteBuy": ["uint32", "uint256", "uint128"], "quoteSell": ["uint32", "uint256", "uint128"],
    "holdings": ["address", "uint32", "uint256"], "payoutFraction": ["uint32", "uint256"], "approve": ["address", "uint256"],
    "allowance": ["address", "address"], "balanceOf": ["address"],
}
_BITS = {"uint8": 8, "uint32": 32, "uint128": 128, "uint256": 256, "address": 160, "bool": 1}
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_HEX = re.compile(r"^0x[0-9a-f]*$")


def _bad(message: str):
    raise FlurboError("invalid_input", message)


def _word(kind: str, value) -> str:
    if kind == "address":
        if not isinstance(value, str) or not _ADDRESS.match(value):
            _bad("Invalid address.")
        n = int(value, 16)
    elif kind == "bool":
        if not isinstance(value, bool):
            _bad("Invalid boolean.")
        n = int(value)
    else:
        if isinstance(value, bool):
            _bad(f"Invalid {kind}.")
        if isinstance(value, int):
            n = value
        elif isinstance(value, str) and re.match(r"^(0|[1-9][0-9]*)$", value):
            n = int(value)
        else:
            _bad(f"Invalid {kind}.")
    if n < 0 or n >= 1 << _BITS[kind]:
        _bad(f"Value out of range for {kind}.")
    return format(n, "064x")


def encode_call(name: str, args: list) -> str:
    if name not in SELECTORS:
        _bad("Unsupported function.")
    kinds = _SIGNATURES.get(name, [])
    if len(args) != len(kinds):
        _bad(f"{name} takes {len(kinds)} arguments.")
    return SELECTORS[name] + "".join(_word(k, a) for k, a in zip(kinds, args))


def decode_call(data: str) -> tuple[str, list[int]]:
    """Rejects unknown selectors, wrong lengths and non-canonical words."""
    data = data.lower()
    if not _HEX.match(data) or len(data) < 10:
        _bad("Invalid calldata.")
    name = next((n for n, s in SELECTORS.items() if s == data[:10]), None)
    if name is None:
        _bad("Unsupported function.")
    kinds, body = _SIGNATURES.get(name, []), data[10:]
    if len(body) != len(kinds) * 64:
        _bad("Invalid calldata length.")
    args = [int(body[i * 64:i * 64 + 64] or "0", 16) for i in range(len(kinds))]
    for kind, value in zip(kinds, args):
        if value >= 1 << _BITS[kind]:
            _bad("Non-canonical calldata.")
    return name, args


def address_from_word(value: int) -> str:
    return "0x" + format(value, "040x")


def decode_words(data: str, count: int) -> list[int]:
    data = data.lower()
    if not _HEX.match(data) or len(data) != 2 + count * 64:
        raise FlurboError("invalid_response", "Unexpected contract return data.")
    return [int(data[2 + i * 64:2 + i * 64 + 64], 16) for i in range(count)]


def decode_pool_log(log: dict) -> dict | None:
    """A decoded pool event, or None for any other (or malformed) log."""
    topics = [str(t).lower() for t in (log.get("topics") or [])]
    if len(topics) != 4 or not isinstance(log.get("data"), str) or not all(re.match(r"^0x[0-9a-f]{64}$", t) for t in topics):
        return None
    who, scope, mask = int(topics[1], 16), int(topics[2], 16), int(topics[3], 16)
    if who >= 1 << 160 or scope >= 1 << 32:
        return None
    address = str(log.get("address", "")).lower()
    try:
        if topics[0] == TOPICS["Traded"]:
            is_buy, quantity, amount = decode_words(log["data"], 3)
            if is_buy > 1 or quantity >= 1 << 128 or amount >= 1 << 128:
                return None
            return {"event": "Traded", "address": address, "trader": address_from_word(who), "scope": scope, "mask": mask,
                    "isBuy": is_buy == 1, "quantity": quantity, "collateralAmount": amount}
        if topics[0] == TOPICS["Redeemed"]:
            quantity, amount = decode_words(log["data"], 2)
            if quantity >= 1 << 128 or amount >= 1 << 128:
                return None
            return {"event": "Redeemed", "address": address, "owner": address_from_word(who), "scope": scope, "mask": mask,
                    "quantity": quantity, "collateralAmount": amount}
    except FlurboError:
        return None
    return None
