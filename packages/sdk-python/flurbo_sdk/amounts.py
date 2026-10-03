"""Amounts and probabilities as exact integers (protocol/specs/numbers.md). No floating point."""
import re

from .errors import FlurboError

PPM = 1_000_000
UINT128_MAX = (1 << 128) - 1
AUSD_DECIMALS = 6
_ATOMS = re.compile(r"^(0|[1-9][0-9]{0,38})$")
_DECIMAL = re.compile(r"^(0|[1-9][0-9]{0,30})(?:\.([0-9]+))?$")


def parse_atoms(value: object, label: str = "amount") -> int:
    if not isinstance(value, str) or not _ATOMS.match(value):
        raise FlurboError("invalid_input", f"Invalid {label}.")
    atoms = int(value)
    if atoms > UINT128_MAX:
        raise FlurboError("invalid_input", f"Invalid {label}.")
    return atoms


def parse_decimal(value: str, decimals: int = AUSD_DECIMALS) -> int:
    """'1.25' with 6 decimals is 1250000. Excess precision is rejected, never rounded."""
    match = _DECIMAL.match(value.strip())
    if not match:
        raise FlurboError("invalid_input", "Enter a positive decimal amount.")
    fraction = match.group(2) or ""
    if len(fraction) > decimals:
        raise FlurboError("invalid_input", f"At most {decimals} decimal places are supported.")
    return int(match.group(1)) * 10**decimals + int(fraction.ljust(decimals, "0") or "0")


def percent_to_ppm(text: str) -> int:
    ppm = parse_decimal(text, 4)
    if ppm > PPM:
        raise FlurboError("invalid_forecast", "Percentages cannot exceed 100.")
    return ppm


def ceil_div(a: int, b: int) -> int:
    if b <= 0 or a < 0:
        raise FlurboError("invalid_input", "Invalid division.")
    return (a + b - 1) // b


def trunc_div(a: int, b: int) -> int:
    """Integer division toward zero, as BigInt division in the TypeScript reference."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def buy_limit(quote: int, bps: int) -> int:
    return (quote * (10_000 + bps) + 9_999) // 10_000


def sell_minimum(quote: int, bps: int) -> int:
    return quote * (10_000 - bps) // 10_000


def frechet_bounds(p_a: int, p_b: int) -> tuple[int, int]:
    for p in (p_a, p_b):
        if p < 0 or p > PPM:
            raise FlurboError("invalid_forecast", "Probabilities must be between 0% and 100%.")
    return max(0, p_a + p_b - PPM), min(p_a, p_b)


def joint_from_pair(a: int, b: int, p_a: int, p_b: int, p_both: int) -> tuple[list[int], list[int]]:
    """Two events from marginals and their joint. Contradictory input is rejected, never repaired."""
    if a == b:
        raise FlurboError("invalid_forecast", "Choose two different events.")
    low, high = frechet_bounds(p_a, p_b)
    if p_both < low or p_both > high:
        raise FlurboError("invalid_forecast", "The chance of both is outside what the two chances allow.")
    first, second, p_first, p_second = (a, b, p_a, p_b) if a < b else (b, a, p_b, p_a)
    return [first, second], [PPM - p_first - p_second + p_both, p_first - p_both, p_second - p_both, p_both]
