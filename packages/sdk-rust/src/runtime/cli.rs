//! flurbo-agent-rs: a local runner on the operator's own infrastructure. It never uploads keys, prints secrets
//! or runs anything on Flurbo's servers. Closing the dashboard does not stop it; `stop` (or Ctrl+C) does.
//!
//! ```text
//! flurbo-agent-rs <init [--markets A,B]|start [--once]|stop|status|recover|address|sign-message --file F> [--config flurbo-agent.json]
//! ```
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::config::{default_config, parse_config, AgentConfig};
use super::runner::{AgentRunner, RunnerOptions};
use crate::error::{FlurboError, Result};
use crate::signer::{LocalKeySigner, Signer};

pub const USAGE: &str = "usage: flurbo-agent-rs <init [--markets A,B]|start [--once]|stop|status|recover|address|sign-message --file F> [--config flurbo-agent.json]";

struct Args {
    command: String,
    config: PathBuf,
    once: bool,
    file: Option<PathBuf>,
    markets: Option<String>,
}

fn parse_args(argv: &[String]) -> Result<Args> {
    let mut args = Args { command: String::new(), config: PathBuf::from("flurbo-agent.json"), once: false, file: None, markets: None };
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--config" => args.config = PathBuf::from(it.next().ok_or_else(|| FlurboError::invalid(USAGE))?),
            "--file" => args.file = Some(PathBuf::from(it.next().ok_or_else(|| FlurboError::invalid(USAGE))?)),
            "--once" => args.once = true,
            "--markets" => args.markets = Some(it.next().ok_or_else(|| FlurboError::invalid(USAGE))?.clone()),
            c if args.command.is_empty() && ["init", "start", "stop", "status", "recover", "address", "sign-message"].contains(&c) => args.command = c.into(),
            _ => return Err(FlurboError::invalid(USAGE)),
        }
    }
    if args.command.is_empty() {
        return Err(FlurboError::invalid(USAGE));
    }
    Ok(args)
}

fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().map(|d| d.join(p)).unwrap_or_else(|_| p.to_path_buf())
    }
}

/// Reads and validates the configuration; the state directory is resolved next to the file.
pub fn load_config(path: &Path) -> Result<AgentConfig> {
    let path = absolute(path);
    let text = fs::read_to_string(&path).map_err(|_| FlurboError::invalid(format!("No configuration at {}. Run init first.", path.display())))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| FlurboError::invalid("The configuration is not valid JSON."))?;
    let mut c = parse_config(&value)?;
    let dir = path.parent().unwrap_or(Path::new(".")).join(&c.state_dir);
    c.state_dir = dir.to_string_lossy().to_string();
    Ok(c)
}

fn key_signer(c: &AgentConfig) -> Result<LocalKeySigner> {
    LocalKeySigner::from_env(&c.signer.key_env)
}

/// Runs one command; returns the process exit code. Output goes to `out`, errors to `err`.
pub fn main_with(argv: &[String], out: &mut dyn FnMut(&str), err: &mut dyn FnMut(&str)) -> i32 {
    let result = (|| -> Result<()> {
        let args = parse_args(argv)?;
        let path = absolute(&args.config);
        match args.command.as_str() {
            "init" => {
                if path.exists() {
                    return Err(FlurboError::new("conflict", format!("{} already exists.", path.display())));
                }
                let mut config = default_config();
                if let Some(markets) = &args.markets {
                    let list: Vec<String> = markets.split(',').map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
                    if list.is_empty() || !list.iter().all(|m| crate::protocol::namespace_ok(m)) {
                        return Err(FlurboError::invalid(
                            "Pass --markets as the comma separated market names shown on the agent page: pilot, or practice- followed by the pool address without 0x.",
                        ));
                    }
                    config["markets"] = json!(list);
                    config["policy"]["markets"] = json!(list);
                    parse_config(&config)?;
                }
                let names: Vec<&str> = config["markets"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                fs::write(&path, serde_json::to_string_pretty(&config).unwrap() + "\n").map_err(|_| FlurboError::new("io", "The configuration could not be written."))?;
                out(&format!(
                    "Wrote {} (paper mode, markets {}). Set FLURBO_AGENT_TOKEN, and FLURBO_AGENT_PRIVATE_KEY for live mode, in your environment. Never put them in the file.",
                    path.display(),
                    names.join(", ")
                ));
            }
            "start" => {
                let mut runner = AgentRunner::new(load_config(&path)?, RunnerOptions::default())?;
                runner.run(args.once);
            }
            "stop" => {
                let mut c = load_config(&path)?;
                c.mode = "paper".into();
                AgentRunner::new(c, RunnerOptions::default())?.request_stop()?;
                out("Stop requested. A running agent stops after its current step.");
            }
            "status" => out(&serde_json::to_string_pretty(&AgentRunner::new(load_config(&path)?, RunnerOptions::default())?.status()).unwrap()),
            "recover" => out(&serde_json::to_string_pretty(&AgentRunner::new(load_config(&path)?, RunnerOptions::default())?.recover()?).unwrap()),
            "address" => out(&key_signer(&load_config(&path)?)?.address()),
            "sign-message" => {
                let file = args.file.ok_or_else(|| FlurboError::invalid("Pass --file with the association message copied from the agent page."))?;
                let raw = fs::read_to_string(&file).map_err(|_| FlurboError::invalid("The message file could not be read."))?;
                let message = raw.replace("\r\n", "\n");
                let message = message.trim_end_matches('\n');
                if !message.starts_with("Flurbo agent wallet association\n") {
                    return Err(FlurboError::invalid("This is not a Flurbo agent wallet association message."));
                }
                let signer = key_signer(&load_config(&path)?)?;
                if !message.contains(&format!("Agent wallet: {}\n", signer.address())) {
                    return Err(FlurboError::invalid(format!("The message is for a different wallet than {}.", signer.address())));
                }
                out(&signer.sign_message(message)?);
            }
            _ => return Err(FlurboError::invalid(USAGE)),
        }
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(e) => {
            err(&format!("{}: {}", e.code, e.message));
            1
        }
    }
}
