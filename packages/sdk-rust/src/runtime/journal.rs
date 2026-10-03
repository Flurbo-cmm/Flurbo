//! The runtime's durable record of every transaction intent (protocol/specs/transactions.md). One journal
//! per agent wallet in the operator's state directory, in the same format and with the same lock file as the
//! TypeScript and Python runtimes. Every change happens under an exclusive lock file shared by all processes
//! using the directory and is written atomically (temporary file, sync, rename over the old file).
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::claims::ClaimRef;
use crate::error::{FlurboError, Result};
use crate::policy::{unfinished, PolicyEntry};
use crate::time::now_millis;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub pid: u32,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFacts {
    pub block_number: String,
    pub gas_used: String,
    pub effective_gas_price: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportState {
    /// none, pending, accepted or rejected
    pub status: String,
    pub attempts: u32,
    pub flurbo_status: Option<String>,
}

/// One transaction intent. Amounts are decimal strings, as in every runtime's journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub action: String,
    pub namespace: String,
    pub pool: String,
    pub claim: Option<ClaimRef>,
    pub quantity_atoms: String,
    pub limit_atoms: String,
    pub deadline: Option<u64>,
    pub status: String,
    pub planned_at: i64,
    pub decision_id: Option<String>,
    pub to: String,
    pub data: String,
    pub gas: Option<String>,
    pub max_fee_per_gas: Option<String>,
    pub max_priority_fee_per_gas: Option<String>,
    pub nonce: Option<u64>,
    pub raw_transaction: Option<String>,
    pub hash: Option<String>,
    pub signed_at: Option<i64>,
    pub broadcast_at: Option<i64>,
    pub final_at: Option<i64>,
    pub cost_atoms: Option<String>,
    pub receipt: Option<ReceiptFacts>,
    pub note: Option<String>,
    pub owner: Owner,
    pub report: ReportState,
    /// Fields written by a newer runtime are kept, never dropped.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl JournalEntry {
    pub fn is_final(&self) -> bool {
        !unfinished(&self.status)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalFile {
    pub schema: String,
    pub wallet: String,
    pub chain_id: u64,
    pub entries: Vec<JournalEntry>,
}

pub fn policy_entries(j: &JournalFile) -> Vec<PolicyEntry> {
    j.entries
        .iter()
        .map(|e| PolicyEntry {
            id: e.id.clone(),
            action: e.action.clone(),
            namespace: e.namespace.clone(),
            claim: e.claim.clone(),
            quantity_atoms: e.quantity_atoms.parse().unwrap_or(0),
            limit_atoms: e.limit_atoms.parse().unwrap_or(0),
            cost_atoms: e.cost_atoms.as_ref().and_then(|c| c.parse().ok()),
            status: e.status.clone(),
            planned_at: e.planned_at,
        })
        .collect()
}

/// The machine name as Node's os.hostname() and Python's socket.gethostname() report it, so a lock left by
/// a crashed process of any runtime on this machine is recognised.
pub fn hostname() -> String {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("COMPUTERNAME").ok())
            .or_else(|| std::env::var("HOSTNAME").ok())
            .unwrap_or_else(|| "unknown".into())
    })
    .clone()
}

pub fn owner() -> Owner {
    Owner { pid: std::process::id(), host: hostname() }
}

/// Whether a process on this machine still runs. Unknown counts as alive (the lock then ages out).
fn alive(pid: u32) -> bool {
    let output = if cfg!(windows) {
        Command::new("tasklist").args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"]).output()
    } else {
        Command::new("kill").args(["-0", &pid.to_string()]).output()
    };
    match output {
        Ok(o) if cfg!(windows) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{}\"", pid)),
        Ok(o) => o.status.success() || String::from_utf8_lossy(&o.stderr).contains("not permitted"),
        Err(_) => true,
    }
}

// On Windows a file being deleted or read by another process briefly refuses opens and renames. These mean
// "someone else is using it", never "you may not".
fn transient(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::PermissionDenied | ErrorKind::WouldBlock) || e.raw_os_error() == Some(32)
}

fn io(e: std::io::Error) -> FlurboError {
    FlurboError::new("io", format!("The state directory could not be used ({}).", e.kind()))
}

pub struct FileJournal {
    pub dir: PathBuf,
    pub wallet: String,
    pub file: PathBuf,
    pub lock_file: PathBuf,
    pub lock_timeout: Duration,
    pub stale: Duration,
}

impl FileJournal {
    pub fn new(dir: &Path, wallet: &str) -> Result<Self> {
        fs::create_dir_all(dir).map_err(io)?;
        Ok(FileJournal {
            dir: dir.to_path_buf(),
            wallet: wallet.to_lowercase(),
            file: dir.join("journal.json"),
            lock_file: dir.join("journal.lock"),
            lock_timeout: Duration::from_secs(20),
            stale: Duration::from_secs(30),
        })
    }

    pub fn read(&self) -> Result<JournalFile> {
        let text = match fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Ok(JournalFile { schema: "flurbo.agent-journal.v1".into(), wallet: self.wallet.clone(), chain_id: 10143, entries: vec![] })
            }
            Err(e) => return Err(io(e)),
        };
        let j: JournalFile = serde_json::from_str(&text).map_err(|_| FlurboError::invalid("The journal file is not a Flurbo agent journal."))?;
        if j.schema != "flurbo.agent-journal.v1" || j.chain_id != 10143 {
            return Err(FlurboError::invalid("The journal file is not a Flurbo agent journal."));
        }
        if j.wallet != self.wallet {
            return Err(FlurboError::invalid(format!("This state directory belongs to wallet {}. Use one state directory per agent wallet.", j.wallet)));
        }
        Ok(j)
    }

    fn write(&self, j: &JournalFile) -> Result<()> {
        let tmp = self.dir.join("journal.json.tmp");
        {
            let mut f = fs::File::create(&tmp).map_err(io)?;
            f.write_all(serde_json::to_string_pretty(j).unwrap().as_bytes()).map_err(io)?;
            f.sync_all().map_err(io)?;
        }
        for attempt in 0..200 {
            match fs::rename(&tmp, &self.file) {
                Ok(()) => return Ok(()),
                Err(e) if transient(&e) && attempt < 199 => sleep(Duration::from_millis(10)),
                Err(e) => return Err(io(e)),
            }
        }
        Ok(())
    }

    fn acquire(&self) -> Result<()> {
        let deadline = Instant::now() + self.lock_timeout;
        let mut n: u64 = 0;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&self.lock_file) {
                Ok(mut f) => {
                    let held = json!({"pid": std::process::id(), "host": hostname(), "at": now_millis()});
                    f.write_all(held.to_string().as_bytes()).map_err(io)?;
                    return Ok(());
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists || transient(&e) => {}
                Err(e) => return Err(io(e)),
            }
            if let Some(held) = fs::read_to_string(&self.lock_file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                let age = now_millis() - held["at"].as_i64().unwrap_or(i64::MAX);
                let stale = self.stale.as_millis() as i64;
                let orphaned = held["host"].as_str() == Some(hostname().as_str()) && held["pid"].as_u64().is_some_and(|p| !alive(p as u32));
                if age > stale && (orphaned || age > stale * 4) {
                    let _ = fs::remove_file(&self.lock_file);
                    continue;
                }
            }
            if Instant::now() > deadline {
                return Err(FlurboError::new("conflict", "The agent journal is locked by another process. Retry shortly."));
            }
            n += 1;
            sleep(Duration::from_millis(20 + (std::process::id() as u64 * 7 + n * 13) % 30));
        }
    }

    // Another process reading the lock file (stale check) briefly blocks deletion on Windows; a lock that is
    // never released would stall every process, so the delete is retried.
    fn release(&self) {
        for _ in 0..500 {
            match fs::remove_file(&self.lock_file) {
                Ok(()) => return,
                Err(e) if e.kind() == ErrorKind::NotFound => return,
                Err(e) if transient(&e) => sleep(Duration::from_millis(5)),
                Err(_) => return,
            }
        }
    }

    /// Runs f on the journal under the lock; if it returns Ok the journal is written.
    pub fn locked<R>(&self, f: impl FnOnce(&mut JournalFile) -> Result<R>) -> Result<R> {
        self.acquire()?;
        let _held = Held(self);
        let mut j = self.read()?;
        let r = f(&mut j)?;
        self.write(&j)?;
        Ok(r)
    }

    /// Runs f under the journal lock without reading or writing the journal.
    pub fn with_lock<R>(&self, f: impl FnOnce() -> Result<R>) -> Result<R> {
        self.acquire()?;
        let _held = Held(self);
        f()
    }
}

/// Releases the lock when dropped, including on an early return or a panic.
struct Held<'a>(&'a FileJournal);

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// A random version 4 UUID.
pub fn uuid4() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("the operating system random source");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{:02x}", x)).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}
