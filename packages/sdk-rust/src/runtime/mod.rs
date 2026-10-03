//! The runtime on the operator's own machine: chain and API clients, the journal, execution and recovery,
//! research adapters, the agent loop and the command line.
pub mod chain;
pub mod cli;
pub mod config;
pub mod executor;
pub mod headless;
pub mod http;
pub mod journal;
pub mod research;
pub mod rpc;
pub mod runner;

pub mod capacity;
