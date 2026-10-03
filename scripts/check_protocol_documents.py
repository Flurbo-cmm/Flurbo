"""Parse the agent runtime OpenAPI document and require a response map on every operation.

Regression check for mis-indented YAML that silently breaks client generation. Needs PyYAML.
"""

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
OPENAPI = ROOT / "protocol/openapi/agent-runtime.v1.yaml"
METHODS = {"get", "put", "post", "delete", "patch"}


def problems(document):
    if not isinstance(document, dict) or not isinstance(document.get("paths"), dict) or not document["paths"]:
        return ["no paths"]
    found = []
    for path, item in document["paths"].items():
        for method, operation in (item or {}).items():
            if method not in METHODS:
                continue
            responses = (operation or {}).get("responses")
            if not isinstance(responses, dict) or not responses:
                found.append(f"{method.upper()} {path}: no responses")
                continue
            for status, response in responses.items():
                if not (status == "default" or (isinstance(status, str) and status.isdigit() and len(status) == 3)):
                    found.append(f"{method.upper()} {path}: unexpected response key {status!r}")
                elif not isinstance(response, dict):
                    found.append(f"{method.upper()} {path}: response {status} is not an object")
    return found


def main():
    try:
        document = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        print(f"{OPENAPI.relative_to(ROOT)} does not parse: {error}", file=sys.stderr)
        return 1
    found = problems(document)
    for line in found:
        print(f"{OPENAPI.relative_to(ROOT)}: {line}", file=sys.stderr)
    if not found:
        print(f"{OPENAPI.relative_to(ROOT)}: {len(document['paths'])} paths parse")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
