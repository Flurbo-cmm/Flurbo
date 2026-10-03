"""Protocol version 1 constants and deployment validation (protocol/README.md, specs/contracts.md)."""
import re

from .errors import FlurboError

PROTOCOL_VERSION = "1"
PROTOCOL_HEADER = "Flurbo-Agent-Protocol"
RUNTIME_API_BASE = "/api/agent-runtime/v1"
CHAIN_ID = 10143
DEPLOYMENT_INTERFACE = "flurbo.pilot-pool.v1"
COLLATERAL = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc"
COLLATERAL_DECIMALS = 6
SERVICE_MAX_ATOMS = 100_000_000
SERVICE_SLIPPAGE_BPS = (10, 50, 100)
MAX_DEADLINE_SECONDS = 300
SCOPES = ("markets:read", "wallet:read", "runtime:report", "executions:report")
STOP_CODES = ("UNAUTHENTICATED", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "INVITE_REQUIRED", "AGENT_ARCHIVED", "SCOPE_REQUIRED")
_NAMESPACE = re.compile(r"^(pilot|practice-[0-9a-f]{40})$")
_ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
_HASH = re.compile(r"^0x[0-9a-f]{64}$")


def parse_deployment(d: dict) -> dict:
    """Validates a deployment record. Limits looser than the protocol's are refused, not trusted."""
    def bad(what: str):
        raise FlurboError("invalid_response", f"Unsupported deployment: {what}.")
    if not isinstance(d, dict) or d.get("schema") != "flurbo.agent-deployment.v1":
        bad("schema")
    if d.get("interface") != DEPLOYMENT_INTERFACE:
        bad("interface")
    if d.get("chainId") != CHAIN_ID:
        bad("chain")
    if not isinstance(d.get("namespace"), str) or not _NAMESPACE.match(d["namespace"]):
        bad("namespace")
    collateral = d.get("collateral") or {}
    if collateral.get("address") != COLLATERAL or collateral.get("decimals") != COLLATERAL_DECIMALS:
        bad("collateral")
    for key in ("pool", "resolver"):
        if not isinstance(d.get(key), str) or not _ADDRESS.match(d[key]):
            bad(key)
    hashes = d.get("codeHashes") or {}
    for value in (hashes.get("pool"), hashes.get("resolver"), d.get("rulesHash")):
        if not isinstance(value, str) or not _HASH.match(value):
            bad("hashes")
    if not isinstance(d.get("closesAt"), int) or d.get("eventCount") not in (2, 3, 4):
        bad("market shape")
    limits = d.get("limits") or {}
    if (limits.get("maxQuantityAtoms"), limits.get("maxLimitAtoms"), limits.get("slippageBps"), limits.get("maxDeadlineSeconds")) != ("100000000", "100000000", [10, 50, 100], 300):
        bad("service limits")
    return dict(d)
