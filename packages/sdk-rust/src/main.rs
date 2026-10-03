//! flurbo-agent-rs, the Rust runtime's command line. See src/runtime/cli.rs.
fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = flurbo_sdk::runtime::cli::main_with(&argv, &mut |s| println!("{}", s), &mut |s| eprintln!("{}", s));
    std::process::exit(code);
}
