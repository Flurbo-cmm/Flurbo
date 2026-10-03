// An AI agent on your machine: questions, rules and published sources -> allowlisted retrieval -> a real
// model provider's structured joint forecast -> validation -> executable quotes -> policy -> (live) signed
// trade. No browser, no per-trade MetaMask confirmation.
//
//   build/ai_agent flurbo-agent.json [--once]
//
// research.provider examples:
//   {"kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "<model id>", "apiKeyEnv": "OPENAI_API_KEY"}
//   {"kind": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY"}
//   {"kind": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1", "model": "<local model>", "apiKeyEnv": null}
// Check your provider's current terms and prices; this example does not assume any provider is free.
// To stop after the current step, run `flurbo-agent-cpp stop --config flurbo-agent.json` in another terminal.
#include <cstdio>

#include "flurbo/runtime.hpp"

using namespace flurbo;

int main(int argc, char** argv) {
  std::string path = "flurbo-agent.json";
  bool once = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--once") once = true;
    else path = a;
  }
  try {
    json::Value config = load_config(path);
    const json::Value& provider = config["research"]["provider"];
    std::string kind = provider.str("kind");
    std::vector<std::string> problems;
    if (kind == "none") problems.push_back("research.provider is not configured, so the agent would only abstain.");
    if (kind == "fixture") problems.push_back("research.provider is a fixture. This example needs a real model provider; a fixed reply is not AI.");
    if ((kind == "openai-compatible" || kind == "anthropic") && provider["apiKeyEnv"].is_string() && !get_env(provider.str("apiKeyEnv")))
      problems.push_back(provider.str("apiKeyEnv") + " is not set for the model provider.");
    if (!get_env(config["api"].str("credentialEnv")))
      problems.push_back(config["api"].str("credentialEnv") + " is not set (issue an agent credential on the agent page).");
    if (config.str("mode") == "live" && !get_env(config["signer"].str("keyEnv")))
      problems.push_back(config["signer"].str("keyEnv") + " is not set (the dedicated agent wallet key; live mode only).");
    if (!problems.empty()) {
      std::fprintf(stderr, "Not starting:\n");
      for (const auto& p : problems) std::fprintf(stderr, "  %s\n", p.c_str());
      return 1;
    }
    AgentRunner(config).run(once);
    return 0;
  } catch (const Error& e) {
    std::fprintf(stderr, "%s: %s\n", e.code.c_str(), e.what());
    return 1;
  }
}
