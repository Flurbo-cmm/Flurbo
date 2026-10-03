"""flurbo-agent for Python: a local runner on the operator's own infrastructure. It never uploads keys, prints
secrets or runs anything on Flurbo's servers. Closing the dashboard does not stop it; `stop` (or Ctrl+C) does.

    python -m flurbo_sdk <init [--markets A,B]|start [--once]|stop|status|recover|address|sign-message --file F> [--config flurbo-agent.json]
"""
import argparse
import json
import signal
import sys
from pathlib import Path

from ..errors import FlurboError
from ..protocol import _NAMESPACE
from .runner import AgentRunner, default_config, parse_config
from .signer import signer_from_env


def main(argv: list[str], out=print, err=lambda s: print(s, file=sys.stderr)) -> int:
    parser = argparse.ArgumentParser(prog="python -m flurbo_sdk", add_help=True)
    parser.add_argument("command", choices=["init", "start", "stop", "status", "recover", "address", "sign-message"])
    parser.add_argument("--config", default="flurbo-agent.json")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--file")
    parser.add_argument("--markets", help="init only: comma separated market names from the agent page")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    config_path = Path(args.config).resolve()

    def load() -> dict:
        if not config_path.exists():
            raise FlurboError("invalid_input", f"No configuration at {config_path}. Run init first.")
        c = parse_config(json.loads(config_path.read_text(encoding="utf-8")))
        return {**c, "stateDir": str((config_path.parent / c["stateDir"]).resolve())}

    try:
        if args.command == "init":
            if config_path.exists():
                raise FlurboError("conflict", f"{config_path} already exists.")
            config = default_config()
            if args.markets is not None:
                markets = [m.strip() for m in args.markets.split(",") if m.strip()]
                if not markets or not all(_NAMESPACE.match(m) for m in markets):
                    raise FlurboError("invalid_input", "Pass --markets as the comma separated market names shown on the agent page: pilot, or practice- followed by the pool address without 0x.")
                config["markets"], config["policy"]["markets"] = markets, list(markets)
                parse_config(config)
            config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
            out(f"Wrote {config_path} (paper mode, markets {', '.join(config['markets'])}). Set FLURBO_AGENT_TOKEN, and FLURBO_AGENT_PRIVATE_KEY for live mode, in your environment. Never put them in the file.")
            return 0
        if args.command == "start":
            runner = AgentRunner(load())
            signal.signal(signal.SIGINT, lambda *_: (err("Stopping after the current step. Submitted transactions are still reconciled on the next start."), runner.request_stop()))
            runner.run(once=args.once)
            return 0
        if args.command == "stop":
            AgentRunner({**load(), "mode": "paper"}).request_stop()
            out("Stop requested. A running agent stops after its current step.")
            return 0
        if args.command == "status":
            out(json.dumps(AgentRunner(load()).status(), indent=2))
            return 0
        if args.command == "recover":
            out(json.dumps(AgentRunner(load()).recover(), indent=2))
            return 0
        if args.command == "address":
            out(signer_from_env(load()["signer"]["keyEnv"]).address)
            return 0
        if args.command == "sign-message":
            if not args.file:
                raise FlurboError("invalid_input", "Pass --file with the association message copied from the agent page.")
            message = Path(args.file).read_text(encoding="utf-8").replace("\r\n", "\n").rstrip("\n")
            if not message.startswith("Flurbo agent wallet association\n"):
                raise FlurboError("invalid_input", "This is not a Flurbo agent wallet association message.")
            signer = signer_from_env(load()["signer"]["keyEnv"])
            if f"Agent wallet: {signer.address}\n" not in message:
                raise FlurboError("invalid_input", f"The message is for a different wallet than {signer.address}.")
            out(signer.sign_message(message))
            return 0
    except FlurboError as e:
        err(f"{e.code}: {e}")
        return 1
    except Exception:
        err("Unexpected error. Nothing new was sent.")
        return 1
    return 1


def entry() -> None:
    sys.exit(main(sys.argv[1:]))
