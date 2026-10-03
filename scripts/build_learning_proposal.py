"""Build an unsigned funded-pool update; no RPC, signing, or floating-point funding math."""
import argparse
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def uint(value, bits=128):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,77}", value):
        raise ValueError("on-chain integers must be canonical decimal strings")
    number = int(value)
    if number >= 1 << bits:
        raise ValueError("integer overflow")
    return number


def decimal(value):
    if (not isinstance(value, str) or len(value) > 80
            or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]{1,3})?", value)):
        raise ValueError("invalid decimal parameter")
    result = Decimal(value)
    if abs(result.as_tuple().exponent) > 100:
        raise ValueError("decimal exponent out of bounds")
    return Fraction(result)


def rounded(value):
    """Exact rational nearest-integer rounding; ties to even, including negatives."""
    return round(value)


def tables(raw, events, canonical=False):
    if not isinstance(raw, list) or len(raw) > 64:
        raise ValueError("invalid factor count")
    result = {}
    previous = 0
    for row in raw:
        scope = uint(row["scope"], 32)
        if not 0 < scope < 1 << events or scope.bit_count() > 3 or scope in result:
            raise ValueError("invalid or duplicate scope")
        values = row["values"]
        if not isinstance(values, list) or len(values) != 1 << scope.bit_count():
            raise ValueError("invalid factor shape")
        values = [uint(v) for v in values]
        if canonical and (scope <= previous or min(values) != 0):
            raise ValueError("noncanonical bias")
        result[scope] = values
        previous = scope
    return result


def graph(events, order, actual, bias, liquidity):
    if len(actual) + len(bias) > 64:
        raise ValueError("combined factor limit exceeded")
    if sum(max(v) for v in actual.values()) + sum(max(v) for v in bias.values()) > 100 * liquidity:
        raise ValueError("combined numeric domain exceeded")
    scopes = list(actual) + list(bias)
    for event in order:
        bit = 1 << event
        joined = bit
        remaining = []
        for scope in scopes:
            if scope & bit:
                joined |= scope
            else:
                remaining.append(scope)
        if joined.bit_count() > 3:
            raise ValueError("combined graph exceeds fixed width 2; model was not pruned")
        scopes = remaining + [joined & ~bit]


def value_at(factors, state):
    total = 0
    for scope, values in factors.items():
        local = 0
        for index, event in enumerate(i for i in range(8) if scope & (1 << i)):
            local |= ((state >> event) & 1) << index
        total += values[local]
    return total


def distribution(energies):
    high = max(energies)
    weights = [(e - high).exp() for e in energies]
    total = sum(weights)
    return [v / total for v in weights]


def as_decimal(value):
    return Decimal(value.numerator) / Decimal(value.denominator)


def build(model, snapshot, *, max_funding, deadline, max_tv="0.000001"):
    if model["schema"] != "flurbo.ising-model.v1" or snapshot["schema"] != "flurbo.funded-snapshot.v1":
        raise ValueError("unsupported schema")
    events = model["events"]
    if type(events) is not int or type(snapshot["events"]) is not int or not 1 <= events <= 8 or snapshot["events"] != events:
        raise ValueError("model/snapshot event mismatch or unsupported event count")
    order = snapshot["order"]
    if not isinstance(order, list) or any(type(i) is not int for i in order) or sorted(order) != list(range(events)):
        raise ValueError("invalid elimination order")
    decimals = snapshot["decimals"]
    if type(decimals) is not int or not 0 <= decimals <= 18:
        raise ValueError("invalid collateral decimals")
    liquidity = uint(snapshot["liquidity"])
    if not 10**12 <= liquidity * 10**(18 - decimals) <= 10**27:
        raise ValueError("invalid liquidity domain")
    for key, size in [("pool", 40), ("blockHash", 64)]:
        if not isinstance(snapshot[key], str) or not re.fullmatch("0x[0-9a-fA-F]{" + str(size) + "}", snapshot[key]):
            raise ValueError("invalid snapshot address/hash")
        if int(snapshot[key], 16) == 0:
            raise ValueError("zero snapshot address/hash")
    uint(snapshot["blockNumber"], 256)
    chain_id, revision = uint(snapshot["chainId"], 256), uint(snapshot["revision"], 256)
    expires = uint(deadline, 256)
    if not uint(snapshot["timestamp"], 64) < expires < uint(snapshot["closesAt"], 64):
        raise ValueError("deadline must be after the snapshot and before close")
    funding = uint(max_funding)
    movement_limit = uint(snapshot["maxBiasMovement"])
    if not 0 < movement_limit <= liquidity:
        raise ValueError("invalid movement policy")
    tolerance = decimal(max_tv)
    if not 0 <= tolerance <= 1:
        raise ValueError("invalid total variation tolerance")
    params = model["parameters"]
    if not isinstance(params, list) or len(params) != events * (events + 1) // 2:
        raise ValueError("invalid parameter count")
    params = [decimal(p) for p in params]
    if any(abs(p) > 12 for p in params):
        raise ValueError("parameter domain exceeded")
    scopes = [1 << i for i in range(events)] + [(1 << i) | (1 << j) for i in range(events) for j in range(i + 1, events)]
    energies = [sum((p for scope, p in zip(scopes, params) if state & scope == scope), Fraction(0)) for state in range(1 << events)]
    if max(energies) - min(energies) > 24:
        raise ValueError("model energy span exceeded")
    actual = tables(snapshot["factors"], events)
    old_bias = tables(snapshot["biasFactors"], events, canonical=True)
    graph(events, order, actual, old_bias, liquidity)
    candidate = {}
    quantization_error = Fraction(0)
    for scope, parameter in zip(scopes, params):
        exact = parameter * liquidity
        coefficient = rounded(exact)
        quantization_error += abs(exact - coefficient)
        # Keep declared nonzero edges even when rounding their coefficient to zero.
        if parameter:
            candidate[scope] = [0] * (1 << scope.bit_count())
            candidate[scope][-1] = coefficient
    for scope, liabilities in actual.items():
        current = candidate.setdefault(scope, [0] * len(liabilities))
        candidate[scope] = [a - q for a, q in zip(current, liabilities)]
    for scope, values in candidate.items():
        low = min(values)
        candidate[scope] = [v - low for v in values]
        if max(candidate[scope]) >= 1 << 128:
            raise ValueError("bias atom overflow")
    graph(events, order, actual, candidate, liquidity)
    movement = 0
    for scope in old_bias.keys() | candidate.keys():
        zero = [0] * (1 << scope.bit_count())
        delta = [a - b for a, b in zip(candidate.get(scope, zero), old_bias.get(scope, zero))]
        movement += max(delta) - min(delta)
    if movement > movement_limit:
        raise ValueError("movement limit exceeded; proposal was not clipped")
    # If the energy error has span E, probability ratios are bounded by exp(E).
    # For 0<=E<1, exp(E)-1 <= E/(1-E). Use an exact conservative bound for
    # acceptance, including tolerances too small for Decimal diagnostics to resolve.
    error_span = quantization_error / liquidity
    tv_bound = min(Fraction(1), error_span / (1 - error_span)) if error_span < 1 else Fraction(1)
    if tv_bound > tolerance:
        raise ValueError("quantization bound exceeds total variation tolerance")
    with localcontext() as context:
        context.prec = 80
        learned = distribution([as_decimal(v) for v in energies])
        implied = distribution([Decimal(value_at(actual, state) + value_at(candidate, state)) / liquidity for state in range(1 << events)])
        tv = sum(abs(a - b) for a, b in zip(learned, implied)) / 2
        diagnostics = {
            "totalVariationDecimal80": str(tv),
            "learnedDistribution": [str(v) for v in learned],
            "impliedDistribution": [str(v) for v in implied],
            "energyErrorSpanBound": str(error_span),
            "totalVariationUpperBound": str(tv_bound),
            "movementBoundAtoms": str(movement),
            "rounding": "exact rational nearest integer, ties to even",
        }
    return {
        "schema": "flurbo.unsigned-learning-proposal.v1",
        "snapshotSha256": digest(snapshot), "modelSha256": digest(model),
        "snapshotBlockNumber": snapshot["blockNumber"], "snapshotBlockHash": snapshot["blockHash"],
        "proposal": {"chainId": str(chain_id), "pool": snapshot["pool"].lower(),
                     "expectedRevision": str(revision), "deadline": str(expires), "maxFunding": str(funding),
                     "bias": [{"scope": str(s), "values": [str(v) for v in candidate[s]]} for s in sorted(candidate)]},
        "diagnostics": diagnostics,
        "requiresOnChainSimulation": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--max-funding", required=True, help="Collateral atoms, never inferred from probability math")
    parser.add_argument("--deadline", required=True)
    parser.add_argument("--max-tv", default="0.000001")
    args = parser.parse_args()
    try:
        for path in [args.model, args.snapshot]:
            if path.stat().st_size > 1_000_000:
                raise ValueError("input exceeds 1 MB")
        result = build(json.loads(args.model.read_text()), json.loads(args.snapshot.read_text()),
                       max_funding=args.max_funding, deadline=args.deadline, max_tv=args.max_tv)
        print(json.dumps(result, indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f"Proposal rejected: {error}\n")


if __name__ == "__main__":
    main()
