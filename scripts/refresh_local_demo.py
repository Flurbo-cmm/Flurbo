"""Mine fresh local Anvil blocks for manual testing. Never connects to a public RPC."""

import argparse
import json
import time
from pathlib import Path

from check_monad_readiness import CONFIG, CheckError, quantity
from dashboard_data import Dashboard, DashboardRpc
from scan_arbitrage import block_info


class LocalClockRpc(DashboardRpc):
    allowed_methods = DashboardRpc.allowed_methods | {"web3_clientVersion", "evm_setNextBlockTimestamp", "evm_mine"}

    def __init__(self):
        super().__init__("http://127.0.0.1:18545")


def refresh_block(rpc, manifest, now):
    version = rpc("web3_clientVersion", [])
    if not isinstance(version, str) or "anvil" not in version.lower() or quantity(rpc("eth_chainId", [])) != 10143:
        raise CheckError("Local clock helper requires Anvil on chain 10143")
    if manifest.get("environment") != "local_fork" or manifest.get("status") != "verified_snapshot":
        raise CheckError("Local clock helper requires a verified local manifest")
    checkpoint = block_info(rpc("eth_getBlockByNumber", [hex(manifest["verified_block"]), False]))
    if checkpoint[2] != manifest["verified_block_hash"]:
        raise CheckError("Local deployment checkpoint changed; stopping the clock helper")
    _, timestamp, _ = block_info(rpc("eth_getBlockByNumber", ["latest", False]))
    if now < timestamp:
        raise CheckError("Local chain time is ahead of wall time; stopping instead of changing settlement time")
    if now == timestamp:
        return False
    rpc("evm_setNextBlockTimestamp", [now])
    rpc("evm_mine", [])
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--watch", action="store_true", help="Keep local block time current every 10 seconds; Ctrl+C stops")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        network = json.loads(CONFIG.read_text())["networks"]["testnet"]
        rpc = LocalClockRpc()
        Dashboard(manifest, network, rpc, "local_fork").snapshot()
        print("Local Anvil clock only: mining at wall time. No trades or public-network writes. Ctrl+C stops.", flush=True)
        while True:
            if refresh_block(rpc, manifest, int(time.time())):
                print("Mined a fresh local block.", flush=True)
            if not args.watch:
                break
            time.sleep(10)
    except KeyboardInterrupt:
        pass
    except (CheckError, ValueError, OSError, KeyError):
        parser.exit(1, "Local clock unavailable or manifest/chain mismatch; no further blocks will be mined.\n")


if __name__ == "__main__":
    main()
