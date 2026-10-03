"""flurbo-agent for Python: a local runner on the operator's own infrastructure. It never uploads keys, prints
secrets or runs anything on Flurbo's servers. Closing the dashboard does not stop it; `stop` (or Ctrl+C) does.

    python -m flurbo_sdk <init [--markets A,B]|start [--once]|stop|status|recover|address|sign-message --file F> [--config flurbo-agent.json]
"""
import sys

try:
    from .runtime.cli import entry
except ModuleNotFoundError as missing:
    # Running from a source copy without installing it: say how to install instead of printing a traceback.
    sys.stderr.write(
        f"The Flurbo Python SDK needs its dependencies ({missing.name} is missing). From packages/sdk-python, "
        "preferably inside a virtual environment, run:\n\n    python -m pip install -e .\n\nthen run this command again. "
        "The README and the agent page on Flurbo list every step.\n")
    raise SystemExit(2)

entry()
