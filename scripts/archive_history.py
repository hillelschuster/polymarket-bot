#!/usr/bin/env python3
"""Retention Phase 2: Weekly SQLite full snapshot, compress, upload, verify, prune.

Usage:
  scripts/archive_history.py [--db PATH] [--temp-root PATH] [--remote PREFIX]
      [--local-only] [--prune] [--dry-run] [--now DATETIME]
"""
import argparse
import datetime
import fcntl
import hashlib
import io
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

DEFAULT_DB = pathlib.Path("/var/lib/trading-bots/polymarket-bot/polymarket-bot.sqlite")
DEFAULT_TEMP_ROOT = pathlib.Path("/var/lib/trading-bots/polymarket-bot/archive-tmp")
DEFAULT_REMOTE = "gdrive:TradingBots/Polymarket/sqlite"
BOT_NAME = "polymarket-bot"
LOCK_FILE = "/tmp/polymarket-archive.lock"
BUSY_TIMEOUT_MS = 60000


# ---------------------------------------------------------------------------
# ISO week / cutoff helpers
# ---------------------------------------------------------------------------
def iso_week_cutoff(now: datetime.datetime) -> datetime.date:
    iso_year, iso_week, _ = now.isocalendar()
    mon = datetime.date.fromisocalendar(iso_year, iso_week, 1)
    return mon - datetime.timedelta(days=14)


def archive_filename(now: datetime.datetime, bot_name: str = BOT_NAME) -> str:
    iso_year, iso_week, _ = now.isocalendar()
    return f"{bot_name}-{iso_year}-W{iso_week:02d}.sqlite.zst"


def remote_folder(now: datetime.datetime) -> str:
    iso_year, iso_week, _ = now.isocalendar()
    return f"{iso_year}/{iso_year}-W{iso_week:02d}"


# ---------------------------------------------------------------------------
# SHA256 helpers
# ---------------------------------------------------------------------------
def compute_sha256(stream: io.RawIOBase | io.BufferedIOBase) -> str:
    h = hashlib.sha256()
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        h.update(chunk)
    return h.hexdigest()



# ---------------------------------------------------------------------------
# Remote verification helpers
# ---------------------------------------------------------------------------
def verify_remote_hash(
    remote_path: str,
    expected_hash: str,
    _run=subprocess.run,
) -> bool:
    try:
        proc = _run(
            ["rclone", "cat", remote_path],
            capture_output=True,
            timeout=300,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if proc.returncode != 0:
        return False
    actual = hashlib.sha256(proc.stdout).hexdigest()
    return actual == expected_hash


def remote_sidecar_hash(
    remote_sidecar_path: str,
    _run=subprocess.run,
) -> str | None:
    try:
        proc = _run(
            ["rclone", "cat", remote_sidecar_path],
            capture_output=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    return proc.stdout.decode("utf-8").strip().split()[0]


# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------
def acquire_lock() -> int:
    fd = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        print("ERROR: another archive process is running", file=sys.stderr)
        sys.exit(1)
    return fd


def release_lock(fd: int) -> None:
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


# ---------------------------------------------------------------------------
# Snapshot / high-water
# ---------------------------------------------------------------------------
def snapshot_high_water(con: sqlite3.Connection) -> dict[str, int]:
    ot = con.execute("SELECT COALESCE(MAX(rowid),0) FROM ObservedTrade").fetchone()[0]
    dj = con.execute("SELECT COALESCE(MAX(rowid),0) FROM DecisionJournal").fetchone()[0]
    return {"observed_trade_rowid": ot, "decision_journal_rowid": dj}


def assert_quick_check(db_path: pathlib.Path) -> None:
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.DatabaseError as e:
        print(f"FATAL: cannot open database: {e}", file=sys.stderr)
        sys.exit(1)
    try:
        row = con.execute("PRAGMA quick_check").fetchone()
    except sqlite3.DatabaseError as e:
        con.close()
        print(f"FATAL: PRAGMA quick_check error: {e}", file=sys.stderr)
        sys.exit(1)
    con.close()
    if not row or row[0] != "ok":
        print(f"FATAL: PRAGMA quick_check failed: {row}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Archive creation
# ---------------------------------------------------------------------------
def create_archive(
    db_path: pathlib.Path,
    temp_root: pathlib.Path,
    now: datetime.datetime,
    remote_prefix: str,
    local_only: bool,
) -> dict:
    metrics: dict = {}
    t0 = time.time()

    temp_root.mkdir(parents=True, exist_ok=True)
    run_dir = pathlib.Path(tempfile.mkdtemp(dir=temp_root))
    metrics["temp_dir"] = str(run_dir)
    print(f"Archive temp: {run_dir}")

    fn = archive_filename(now)
    fn_sha = fn + ".sha256"
    remote_dir = f"{remote_prefix}/{remote_folder(now)}"
    remote_zst = f"{remote_dir}/{fn}"
    remote_sha = f"{remote_dir}/{fn_sha}"

    existing_hash = remote_sidecar_hash(remote_sha)
    if existing_hash is not None:
        print(f"Remote archive exists (hash={existing_hash[:16]}...). Verifying...")
        if verify_remote_hash(remote_zst, existing_hash):
            print("Remote archive verified. Reusing.")
            metrics["reused"] = True
            metrics["remote_verified"] = True
            metrics["remote_hash"] = existing_hash
            metrics["elapsed"] = time.time() - t0
            con_db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_MS)
            try:
                metrics["high_water"] = snapshot_high_water(con_db)
            finally:
                con_db.close()
            return metrics
        else:
            print("Remote archive corrupt or hash mismatch. Re-creating.")

    # Snapshot
    snap_path = run_dir / "snapshot.sqlite"
    con_src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_MS)
    try:
        con_dst = sqlite3.connect(str(snap_path))
        con_src.backup(con_dst)
        con_dst.close()
    finally:
        con_src.close()
    metrics["snapshot_bytes"] = snap_path.stat().st_size
    print(f"Snapshot: {snap_path} ({metrics['snapshot_bytes']} bytes)")

    assert_quick_check(snap_path)
    print("quick_check: ok")

    con_snap = sqlite3.connect(str(snap_path))
    hw = snapshot_high_water(con_snap)
    con_snap.close()
    metrics["high_water"] = hw
    print(f"High-water: OT rowid={hw['observed_trade_rowid']}, DJ rowid={hw['decision_journal_rowid']}")


    # Compress
    zst_path = run_dir / fn
    comp = subprocess.run(
        ["zstd", "-6", "-q", "-o", str(zst_path), str(snap_path)],
        capture_output=True,
        timeout=600,
    )
    if comp.returncode != 0:
        print(f"FATAL: zstd failed: {comp.stderr.decode()}", file=sys.stderr)
        sys.exit(1)
    metrics["zst_bytes"] = zst_path.stat().st_size
    print(f"Compressed: {zst_path} ({metrics['zst_bytes']} bytes)")

    check = subprocess.run(["zstd", "-t", str(zst_path)], capture_output=True, timeout=60)
    if check.returncode != 0:
        print(f"FATAL: zstd -t failed: {check.stderr.decode()}", file=sys.stderr)
        sys.exit(1)

    with open(zst_path, "rb") as f:
        zst_hash = compute_sha256(f)
    metrics["zst_hash"] = zst_hash
    sha_path = run_dir / fn_sha
    sha_path.write_text(f"{zst_hash}  {fn}\n")
    print(f"SHA256: {zst_hash[:16]}...")

    if not local_only:
        print("Uploading...")
        upload_proc = subprocess.run(
            ["rclone", "copyto", str(zst_path), remote_zst],
            capture_output=True,
            timeout=600,
        )
        if upload_proc.returncode != 0:
            print(f"FATAL: rclone upload failed: {upload_proc.stderr.decode()}", file=sys.stderr)
            sys.exit(1)
        subprocess.run(
            ["rclone", "copyto", str(sha_path), remote_sha],
            capture_output=True,
            timeout=60,
        )
        print(f"Uploaded to {remote_zst}")

        if not verify_remote_hash(remote_zst, zst_hash):
            print("FATAL: remote verification failed -- hash mismatch", file=sys.stderr)
            sys.exit(1)
        print("Remote verification: OK")
        metrics["remote_verified"] = True

    metrics["elapsed"] = time.time() - t0
    metrics["reused"] = False
    return metrics


# ---------------------------------------------------------------------------
# Pruning
# ---------------------------------------------------------------------------
# ponytail: _candidate_skip_dj, its UPDATE (step 1), and DELETE (step 2) in prune_exact
# share the same WHERE eligibility predicates. Keep all three in lockstep.
def _candidate_skip_dj(
    con: sqlite3.Connection,
    cutoff: datetime.date,
    hw_dj_rowid: int,
) -> int:
    return con.execute("""
        SELECT COUNT(*) FROM DecisionJournal
        WHERE decision = 'skip'
          AND createdAt < ?
          AND rowid <= ?
          AND id NOT IN (SELECT decisionJournalId FROM PaperTrade WHERE decisionJournalId IS NOT NULL)
          AND id NOT IN (SELECT decisionJournalId FROM LiveOrder)
          AND id NOT IN (SELECT decisionJournalId FROM OutcomeReview)
    """, (cutoff.isoformat(), hw_dj_rowid)).fetchone()[0]


def _candidate_orphan_ot(
    con: sqlite3.Connection,
    cutoff: datetime.date,
    hw_ot_rowid: int,
) -> int:
    return con.execute("""
        SELECT COUNT(*) FROM ObservedTrade
        WHERE createdAt < ?
          AND rowid <= ?
          AND NOT EXISTS (
              SELECT 1 FROM DecisionJournal
              WHERE DecisionJournal.observedTradeId = ObservedTrade.id
          )
    """, (cutoff.isoformat(), hw_ot_rowid)).fetchone()[0]


def prune_exact(
    con: sqlite3.Connection,
    cutoff: datetime.date,
    hw: dict[str, int],
) -> dict[str, int]:
    con.execute("BEGIN IMMEDIATE")

    # ponytail: predicates below mirror _candidate_skip_dj. Keep in lockstep.
    # Step 1: Null out FK reference on skip DJs being deleted
    con.execute("""
        UPDATE DecisionJournal SET observedTradeId = NULL
        WHERE decision = 'skip'
          AND createdAt < ?
          AND rowid <= ?
          AND id NOT IN (SELECT decisionJournalId FROM PaperTrade WHERE decisionJournalId IS NOT NULL)
          AND id NOT IN (SELECT decisionJournalId FROM LiveOrder)
          AND id NOT IN (SELECT decisionJournalId FROM OutcomeReview)
    """, (cutoff.isoformat(), hw["decision_journal_rowid"]))

    # Step 2: delete DJ skip rows
    con.execute("""
        DELETE FROM DecisionJournal
        WHERE decision = 'skip'
          AND createdAt < ?
          AND rowid <= ?
          AND observedTradeId IS NULL
          AND id NOT IN (SELECT decisionJournalId FROM PaperTrade WHERE decisionJournalId IS NOT NULL)
          AND id NOT IN (SELECT decisionJournalId FROM LiveOrder)
          AND id NOT IN (SELECT decisionJournalId FROM OutcomeReview)
    """, (cutoff.isoformat(), hw["decision_journal_rowid"]))
    dj_del = con.execute("SELECT changes()").fetchone()[0]

    # Step 3: delete orphan OT rows
    con.execute("""
        DELETE FROM ObservedTrade
        WHERE createdAt < ?
          AND rowid <= ?
          AND NOT EXISTS (
              SELECT 1 FROM DecisionJournal
              WHERE DecisionJournal.observedTradeId = ObservedTrade.id
          )
    """, (cutoff.isoformat(), hw["observed_trade_rowid"]))
    ot_del = con.execute("SELECT changes()").fetchone()[0]

    con.execute("COMMIT")
    return {"dj_skip": dj_del, "ot_orphan": ot_del}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Polymarket SQLite archive & prune")
    ap.add_argument("--db", type=pathlib.Path, default=DEFAULT_DB)
    ap.add_argument("--temp-root", type=pathlib.Path, default=DEFAULT_TEMP_ROOT)
    ap.add_argument("--remote", default=DEFAULT_REMOTE)
    ap.add_argument("--local-only", action="store_true",
                    help="Skip rclone/remote; never prune")
    ap.add_argument("--prune", action="store_true",
                    help="Prune old data after verified upload")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report prune candidates without deleting")
    ap.add_argument("--now", type=lambda s: datetime.datetime.fromisoformat(s),
                    help="Override current time (for testing)")
    args = ap.parse_args(argv)
    if args.local_only and args.prune:
        ap.error("--local-only and --prune are incompatible")
    return args


def main() -> None:
    args = parse_args()
    t0 = time.time()

    lock_fd = acquire_lock()
    try:
        now = args.now if args.now else datetime.datetime.now(datetime.timezone.utc)

        archive_metrics = create_archive(
            db_path=args.db,
            temp_root=args.temp_root,
            now=now,
            remote_prefix=args.remote,
            local_only=args.local_only,
        )

        if args.prune:
            if not archive_metrics.get("remote_verified"):
                print("ERROR: cannot prune without successful remote verification",
                      file=sys.stderr)
                sys.exit(1)
            con = sqlite3.connect(str(args.db), timeout=BUSY_TIMEOUT_MS)
            try:
                cutoff = iso_week_cutoff(now)
                hw = archive_metrics["high_water"]
                if args.dry_run:
                    djs = _candidate_skip_dj(con, cutoff, hw["decision_journal_rowid"])
                    ots = _candidate_orphan_ot(con, cutoff, hw["observed_trade_rowid"])
                    print(f"[dry-run] DJ skip candidates: {djs}, "
                          f"OT orphan candidates: {ots}")
                else:
                    con.execute("PRAGMA foreign_keys=ON")
                    deleted = prune_exact(con, cutoff, hw)
                    con.commit()
                    print(f"Pruned: DJ skip={deleted.get('dj_skip', 0)}, "
                          f"OT orphan={deleted.get('ot_orphan', 0)}")
            finally:
                con.close()

        temp_dir = archive_metrics.get("temp_dir")
        if temp_dir and pathlib.Path(temp_dir).exists():
            shutil.rmtree(temp_dir)
            print(f"Cleaned: {temp_dir}")

        elapsed = time.time() - t0
        print(f"Done in {elapsed:.2f}s")
    finally:
        release_lock(lock_fd)


if __name__ == "__main__":
    main()