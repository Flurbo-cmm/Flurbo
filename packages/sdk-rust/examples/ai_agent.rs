//! An AI agent on your machine: questions, rules and published sources -> allowlisted retrieval -> a real
//! model provider's structured joint forecast -> validation -> executable quotes -> policy -> (live) signed
//! trade. No browser, no per-trade MetaMask confirmation.
//!
//! ```text
//! cargo run --example ai_agent -- flurbo-agent.json [--once]
//! ```
//!
//! research.provider examples:
//!
//! ```text
//! {"kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "<model id>", "apiKeyEnv": "OPENAI_API_KEY"}
//! {"kind": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY"}
//! {"kind": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1", "model": "<local model>", "apiKeyEnv": null}
//! ```
//!
//! Check your provider's current terms and prices; this example does not assume any provider is free.
//! To stop after the current step, run `flurbo-agent-rs stop --config flurbo-agent.json` in another terminal.
use std::path::Path;

use flurbo_sdk::runtime::cli::load_config;
use flurbo_sdk::runtime::config::ProviderConfig;
use flurbo_sdk::runtime::runner::{AgentRunner, RunnerOptions};

fn set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.trim().is_empty())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.iter().find(|a| !a.starts_with("--")).cloned().unwrap_or_else(|| "flurbo-agent.json".into());
    let config = match load_config(Path::new(&path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}: {}", e.code, e.message);
            std::process::exit(1);
        }
    };
    let mut problems = Vec::new();
    match &config.research.provider {
        ProviderConfig::None => problems.push("research.provider is not configured, so the agent would only abstain.".to_string()),
        ProviderConfig::Fixture { .. } => problems.push("research.provider is a fixture. This example needs a real model provider; a fixed reply is not AI.".to_string()),
        ProviderConfig::OpenaiCompatible { api_key_env: Some(k), .. } | ProviderConfig::Anthropic { api_key_env: k, .. } if !set(k) => {
            problems.push(format!("{} is not set for the model provider.", k))
        }
        _ => {}
    }
    if !set(&config.api.credential_env) {
        problems.push(format!("{} is not set (issue an agent credential on the agent page).", config.api.credential_env));
    }
    if config.mode == "live" && !set(&config.signer.key_env) {
        problems.push(format!("{} is not set (the dedicated agent wallet key; live mode only).", config.signer.key_env));
    }
    if !problems.is_empty() {
        eprintln!("Not starting:\n  {}", problems.join("\n  "));
        std::process::exit(1);
    }
    match AgentRunner::new(config, RunnerOptions::default()) {
        Ok(mut runner) => runner.run(args.iter().any(|a| a == "--once")),
        Err(e) => {
            eprintln!("{}: {}", e.code, e.message);
            std::process::exit(1);
        }
    }
}
