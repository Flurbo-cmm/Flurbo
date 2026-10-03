"""Fixed stdin/stdout adapter for the exact unsigned builder. No network or signing."""
import json
import sys

from build_learning_proposal import build


def main():
    try:
        raw = sys.stdin.buffer.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("Input too large")
        request = json.loads(raw)
        if set(request) != {"model", "snapshot", "maxFunding", "deadline"}:
            raise ValueError("Unexpected inputs")
        result = build(request["model"], request["snapshot"],
                       max_funding=request["maxFunding"], deadline=request["deadline"])
        print(json.dumps(result))
        return 0
    except Exception:
        # Input and child exceptions never expose server paths or environment values.
        print(json.dumps({"error": "Proposal rejected by exact quantization, graph or movement checks"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
