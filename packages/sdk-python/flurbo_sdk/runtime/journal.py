"""The runtime's durable record of every transaction intent (protocol/specs/transactions.md). One journal
per agent wallet in the operator's state directory, in the same format and with the same lock file as the
TypeScript runtime. Every change happens under an exclusive lock file shared by all processes using the
directory and is written atomically (temporary file, flush, replace)."""
import json
import os
import random
import socket
import sys
import time
from pathlib import Path

from ..errors import FlurboError
from ..policy import UNFINISHED

_TRANSIENT = (PermissionError, BlockingIOError)


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        # os.kill(pid, 0) sends CTRL_C_EVENT on Windows; query the process handle instead.
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # access denied: it exists
        code = ctypes.c_ulong()
        kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def is_final(entry: dict) -> bool:
    return entry["status"] not in UNFINISHED


def policy_entries(journal: dict) -> list[dict]:
    keys = ("id", "action", "namespace", "claim", "quantityAtoms", "limitAtoms", "costAtoms", "status", "plannedAt")
    return [{k: e.get(k) for k in keys} for e in journal["entries"]]


def owner() -> dict:
    return {"pid": os.getpid(), "host": socket.gethostname()}


class FileJournal:
    def __init__(self, directory: str | os.PathLike, wallet: str, lock_timeout: float = 20.0, stale_seconds: float = 30.0):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.wallet = wallet.lower()
        self.file, self.lock_file = self.dir / "journal.json", self.dir / "journal.lock"
        self._timeout, self._stale = lock_timeout, stale_seconds

    def read(self) -> dict:
        if not self.file.exists():
            return {"schema": "flurbo.agent-journal.v1", "wallet": self.wallet, "chainId": 10143, "entries": []}
        j = json.loads(self.file.read_text(encoding="utf-8"))
        if j.get("schema") != "flurbo.agent-journal.v1" or j.get("chainId") != 10143:
            raise FlurboError("invalid_input", "The journal file is not a Flurbo agent journal.")
        if j["wallet"] != self.wallet:
            raise FlurboError("invalid_input", f"This state directory belongs to wallet {j['wallet']}. Use one state directory per agent wallet.")
        return j

    def _write(self, j: dict) -> None:
        tmp = self.file.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(j, indent=1))
            f.flush()
            os.fsync(f.fileno())
        for attempt in range(200):
            try:
                os.replace(tmp, self.file)
                return
            except _TRANSIENT:
                if attempt == 199:
                    raise
                time.sleep(0.01)

    def _acquire(self) -> None:
        deadline = time.monotonic() + self._timeout
        while True:
            try:
                fd = os.open(self.lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, json.dumps({"pid": os.getpid(), "host": socket.gethostname(), "at": int(time.time() * 1000)}).encode())
                finally:
                    os.close(fd)
                return
            except FileExistsError:
                pass
            except _TRANSIENT:
                pass  # Windows: the previous holder's lock file is being deleted
            try:
                held = json.loads(self.lock_file.read_text())
                age = time.time() * 1000 - held["at"]
                orphaned = held["host"] == socket.gethostname() and not _alive(held["pid"])
                if age > self._stale * 1000 and (orphaned or age > self._stale * 4000):
                    self.lock_file.unlink(missing_ok=True)
                    continue
            except (OSError, ValueError, KeyError):
                pass
            if time.monotonic() > deadline:
                raise FlurboError("conflict", "The agent journal is locked by another process. Retry shortly.")
            time.sleep(0.02 + random.random() * 0.03)

    def _release(self) -> None:
        # On Windows another process reading the lock file (stale check) briefly blocks deletion; a lock that
        # is never released would stall every process, so the delete is retried.
        for _ in range(500):
            try:
                self.lock_file.unlink()
                return
            except FileNotFoundError:
                return
            except PermissionError:
                time.sleep(0.005)
            except OSError:
                return

    def locked(self, fn):
        """Runs fn(journal) under the lock; if it returns normally the journal is written."""
        self._acquire()
        try:
            j = self.read()
            result = fn(j)
            self._write(j)
            return result
        finally:
            self._release()

    def with_lock(self, fn):
        self._acquire()
        try:
            return fn()
        finally:
            self._release()
