"""An AI agent on your machine: questions, rules and published sources -> allowlisted retrieval -> a real model
provider's structured joint forecast -> validation -> executable quotes -> policy -> (live) signed trade. No
browser, no per-trade MetaMask confirmation.

    python examples/ai_agent.py flurbo-agent.json [--once]

research.provider examples:
  {"kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "<model id>", "apiKeyEnv": "OPENAI_API_KEY"}
  {"kind": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY"}
  {"kind": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1", "model": "<local model>", "apiKeyEnv": null}
Check your provider's current terms and prices; this example does not assume any provider is free.
"""
import json
import os
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flurbo_sdk.runtime.runner import AgentRunner, parse_config  # noqa: E402

path = Path(sys.argv[1] if len(sys.argv) > 1 else "flurbo-agent.json").resolve()
config = parse_config(json.loads(path.read_text(encoding="utf-8")))
provider, problems = config["research"]["provider"], []
if provider["kind"] == "none":
    problems.append("research.provider is not configured, so the agent would only abstain.")
if provider["kind"] == "fixture":
    problems.append("research.provider is a fixture. This example needs a real model provider; a fixed reply is not AI.")
if provider["kind"] in ("openai-compatible", "anthropic") and provider.get("apiKeyEnv") and not os.environ.get(provider["apiKeyEnv"]):
    problems.append(f"{provider['apiKeyEnv']} is not set for the model provider.")
if not os.environ.get(config["api"]["credentialEnv"]):
    problems.append(f"{config['api']['credentialEnv']} is not set (issue an agent credential on the agent page).")
if config["mode"] == "live" and not os.environ.get(config["signer"]["keyEnv"]):
    problems.append(f"{config['signer']['keyEnv']} is not set (the dedicated agent wallet key; live mode only).")
if problems:
    sys.exit("Not starting:\n  " + "\n  ".join(problems))
runner = AgentRunner({**config, "stateDir": str((path.parent / config["stateDir"]).resolve())})
signal.signal(signal.SIGINT, lambda *_: runner.request_stop())
runner.run(once="--once" in sys.argv)
