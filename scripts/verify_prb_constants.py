"""Check pinned sources and exp constants with exact rational bounds (no floats)."""
from fractions import Fraction as F
from hashlib import sha256
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1] / "contracts/node_modules/@prb/math/src"
HASHES = {
    "Common.sol": "aa06d9f62bd64264e6f3744c69cab001b87b35f4e511d170464da6e1d11ca273",
    "ud60x18/Math.sol": "c0fc89bffcd174e6155ce6d17af4894f0712dc625885f3709b2d1697516569b8",
    "ud60x18/Constants.sol": "7883364a05f0bc71338c68303f385c4213b8712900ed664eb1732daa0f0308a1",
}


def exp_interval(x):
    # For 0 <= x <= 1, positive Taylor sum through degree 80 and geometric tail.
    assert 0 <= x <= 1
    term = total = F(1)
    for n in range(1, 81):
        term *= x / n
        total += term
    tail = term * x / 81 / (1 - x / 82)
    return total, total + tail


def verify():
    for name, expected in HASHES.items():
        assert sha256((ROOT / name).read_bytes()).hexdigest() == expected, name
    z = F(1, 3)
    ln2_lower = 2 * sum(z ** (2*k + 1) / (2*k + 1) for k in range(80))
    ln2_upper = ln2_lower + 2 * z**161 / (161 * (1 - z*z))
    unit, binary = 10**18, 2**64
    k = 1442695040888963407
    assert F(k, unit) < 1 / ln2_upper <= 1 / ln2_lower < F(k + 1, unit)
    factors = [int(x, 16) for x in re.findall(r"result = \(result \* (0x[0-9A-F]+)\) >> 64;", (ROOT / "Common.sol").read_text())]
    assert len(factors) == 64
    maximum = 2**191
    for i, factor in enumerate(factors, 1):
        lower = exp_interval(ln2_lower / 2**i)[0]
        upper = exp_interval(ln2_upper / 2**i)[1]
        assert F(factor - 1, binary) < lower <= upper < F(factor + 1, binary)
        assert factor >= binary
        # All bits set maximizes every intermediate integer product.
        assert maximum * factor < 2**256
        maximum = maximum * factor // binary
    assert maximum * unit < 2**256
    # Includes normalization, log2(e), two radix conversions, products, and final floor.
    exp_error = exp_interval(F(104, unit))[1] * (1 + F(1, binary))**64 * (1 + F(1, 2**191))**64 - 1 + F(1, unit)
    assert exp_error < F(128, unit)
    assert F(128, unit) / (1 - F(128, unit)) + F(1, unit) < F(512, unit)
    print("Pinned sources, 64 exp2 constants, overflow envelope and weight error inequalities verified exactly.")


if __name__ == "__main__":
    verify()
