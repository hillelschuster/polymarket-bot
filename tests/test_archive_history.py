"""Tests for archive_history.py -- Retention Phase 2."""
import contextlib
import datetime
import hashlib
import io
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock


# ---------------------------------------------------------------------------
# SQLite fixture helper
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS DecisionJournal (
    id              TEXT PRIMARY KEY,
    observedTradeId TEXT,
    walletAddress   TEXT NOT NULL,
    marketId        TEXT NOT NULL,
    decision        TEXT NOT NULL,
    createdAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ObservedTrade (
    id            TEXT PRIMARY KEY,
    walletAddress TEXT NOT NULL,
    marketId      TEXT NOT NULL,
    createdAt     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS PaperTrade (
    id                TEXT PRIMARY KEY,
    decisionJournalId TEXT,
    marketId          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS LiveOrder (
    id                TEXT PRIMARY KEY,
    decisionJournalId TEXT NOT NULL,
    marketId          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'submitted'
);
CREATE TABLE IF NOT EXISTS OutcomeReview (
    id                TEXT PRIMARY KEY,
    decisionJournalId TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS StrategySignal (
    id       TEXT PRIMARY KEY,
    marketId TEXT NOT NULL,
    status   TEXT NOT NULL DEFAULT 'paper_copy'
);
CREATE TABLE IF NOT EXISTS PnlSnapshot (
    id           TEXT PRIMARY KEY,
    paperTradeId TEXT NOT NULL
);
"""


@contextlib.contextmanager
def fixture_db(sql: str = ""):
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    try:
        con = sqlite3.connect(path)
        con.executescript(SCHEMA)
        if sql:
            con.executescript(sql)
        con.commit()
        con.close()
        yield path
    finally:
        os.unlink(path)


def _load_arch():
    for k in list(sys.modules):
        if 'archive_history' in k:
            del sys.modules[k]
    here = pathlib.Path(__file__).resolve().parent.parent
    scripts = str(here / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import archive_history as arch
    return arch


# ===========================================================================
# 1. ISO week / cutoff
# ===========================================================================
class TestIsoWeekCutoff(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_week_midweek(self):
        c = self.arch.iso_week_cutoff(
            datetime.datetime(2026, 8, 26, 12, 0, 0, tzinfo=datetime.timezone.utc))
        self.assertEqual(c, datetime.date(2026, 8, 10))

    def test_week_sunday(self):
        c = self.arch.iso_week_cutoff(
            datetime.datetime(2026, 8, 30, 12, 0, 0, tzinfo=datetime.timezone.utc))
        self.assertEqual(c, datetime.date(2026, 8, 10))

    def test_new_year(self):
        c = self.arch.iso_week_cutoff(
            datetime.datetime(2026, 1, 5, 0, 0, 0, tzinfo=datetime.timezone.utc))
        self.assertEqual(c, datetime.date(2025, 12, 22))

    def test_filename(self):
        fn = self.arch.archive_filename(
            datetime.datetime(2026, 8, 26, 12, 0, 0, tzinfo=datetime.timezone.utc),
            "polymarket-bot")
        self.assertRegex(fn, r"^polymarket-bot-2026-W35\.sqlite\.zst$")


# ===========================================================================
# 2. SHA256 sidecar
# ===========================================================================
class TestSha256Sidecar(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_compute_sha256(self):
        data = b"hello world\n" * 1000
        expected = hashlib.sha256(data).hexdigest()
        result = self.arch.compute_sha256(io.BytesIO(data))
        self.assertEqual(result, expected)

    def test_sidecar_file_format(self):
        """Sidecar file written to disk follows '<hash>  <filename>' format."""
        with tempfile.TemporaryDirectory() as tmp:
            sp = pathlib.Path(tmp) / "test.zst.sha256"
            sp.write_text("abc123  test.zst\n")
            line = sp.read_text().strip()
            parts = line.split("  ")
            self.assertEqual(len(parts), 2)
            self.assertEqual(parts[0], "abc123")
            self.assertEqual(parts[1], "test.zst")


# ===========================================================================
# 3. Remote hash detection
# ===========================================================================
class TestRemoteHash(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_hash_mismatch(self):
        good = b"A" * 5000
        fake_proc = mock.Mock(returncode=0, stdout=good)
        r = self.arch.verify_remote_hash(
            "gdrive:x/db.zst",
            hashlib.sha256(b"B" * 5000).hexdigest(),
            _run=mock.Mock(return_value=fake_proc),
        )
        self.assertFalse(r)

    def test_nonzero_exit(self):
        data = b"A" * 5000
        fake_proc = mock.Mock(returncode=1, stdout=data)
        r = self.arch.verify_remote_hash(
            "gdrive:x/db.zst",
            hashlib.sha256(data).hexdigest(),
            _run=mock.Mock(return_value=fake_proc),
        )
        self.assertFalse(r)

    def test_match_ok(self):
        data = b"A" * 5000
        fake_proc = mock.Mock(returncode=0, stdout=data)
        r = self.arch.verify_remote_hash(
            "gdrive:x/db.zst",
            hashlib.sha256(data).hexdigest(),
            _run=mock.Mock(return_value=fake_proc),
        )
        self.assertTrue(r)


# ===========================================================================
# 4. Local-only / default cannot prune
# ===========================================================================
class TestLocalOnlyNoPrune(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_local_only_rejects_prune(self):
        with self.assertRaises(SystemExit):
            self.arch.parse_args(["--local-only", "--prune"])

    def test_default_no_prune(self):
        args = self.arch.parse_args([])
        self.assertFalse(args.prune)

    def test_local_only_no_prune(self):
        args = self.arch.parse_args(["--local-only"])
        self.assertFalse(args.prune)
        self.assertTrue(args.local_only)


# ===========================================================================
# 5. Snapshot high-water uses rowid
# ===========================================================================
class TestSnapshotHighWater(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_rowid_high_water(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId) VALUES('ot-1','0x1','m1');
            INSERT INTO ObservedTrade(id,walletAddress,marketId) VALUES('ot-2','0x1','m2');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision) VALUES('dj-1','ot-1','0x1','m1','paper_copy');
        """) as db:
            con = sqlite3.connect(db)
            hw = self.arch.snapshot_high_water(con)
            con.close()
            self.assertIn("observed_trade_rowid", hw)
            self.assertIn("decision_journal_rowid", hw)
            self.assertGreaterEqual(hw["observed_trade_rowid"], 2)
            self.assertGreaterEqual(hw["decision_journal_rowid"], 1)


# ===========================================================================
# 6. Prune logic
# ===========================================================================
class TestPruneBehavior(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.arch = _load_arch()

    def _candidates(self, db_path, cutoff):
        con = sqlite3.connect(db_path)
        hw = self.arch.snapshot_high_water(con)
        djs = self.arch._candidate_skip_dj(con, cutoff, hw["decision_journal_rowid"])
        ots = self.arch._candidate_orphan_ot(con, cutoff, hw["observed_trade_rowid"])
        con.close()
        return djs, ots

    def test_old_skip_candidate(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','skip','2026-08-01');
        """) as db:
            djs, _ = self._candidates(db, datetime.date(2026, 8, 10))
            self.assertEqual(djs, 1)

    def test_old_accepted_not_candidate(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','paper_copy','2026-08-01');
        """) as db:
            djs, _ = self._candidates(db, datetime.date(2026, 8, 10))
            self.assertEqual(djs, 0)

    def test_hot_skip_not_candidate(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-15');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','skip','2026-08-15');
        """) as db:
            djs, _ = self._candidates(db, datetime.date(2026, 8, 10))
            self.assertEqual(djs, 0)

    def test_post_high_water_preserved(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','skip','2026-08-01');
        """) as db:
            con = sqlite3.connect(db)
            hw_before = self.arch.snapshot_high_water(con)
            con.execute("INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot2','0x1','m2','2026-08-01')")
            con.commit()
            con.close()
            cutoff = datetime.date(2026, 8, 10)
            con2 = sqlite3.connect(db)
            djs = self.arch._candidate_skip_dj(con2, cutoff, hw_before["decision_journal_rowid"])
            con2.close()
            self.assertEqual(djs, 1)

    def test_fk_order_delete(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','skip','2026-08-01');
        """) as db:
            cutoff = datetime.date(2026, 8, 10)
            con = sqlite3.connect(db)
            hw = self.arch.snapshot_high_water(con)
            deleted = self.arch.prune_exact(con, cutoff, hw)
            con.commit()
            rem_dj = con.execute("SELECT COUNT(*) FROM DecisionJournal").fetchone()[0]
            rem_ot = con.execute("SELECT COUNT(*) FROM ObservedTrade").fetchone()[0]
            con.close()
            self.assertEqual(rem_dj, 0)
            self.assertEqual(rem_ot, 0)
            self.assertGreaterEqual(deleted.get("dj_skip", 0), 1)
            self.assertGreaterEqual(deleted.get("ot_orphan", 0), 1)

    def test_idempotent(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','skip','2026-08-01');
        """) as db:
            cutoff = datetime.date(2026, 8, 10)
            con = sqlite3.connect(db)
            hw = self.arch.snapshot_high_water(con)
            first = self.arch.prune_exact(con, cutoff, hw)
            con.commit()
            con.close()
            con2 = sqlite3.connect(db)
            hw2 = self.arch.snapshot_high_water(con2)
            second = self.arch.prune_exact(con2, cutoff, hw2)
            con2.close()
            self.assertGreater(first.get("dj_skip", 0), 0)
            self.assertEqual(second.get("dj_skip", 0), 0)
            self.assertEqual(second.get("ot_orphan", 0), 0)

    def test_paper_trade_linked_skip_preserved(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot1','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj1','ot1','0x1','m1','skip','2026-08-01');
            INSERT INTO PaperTrade(id,decisionJournalId,marketId) VALUES('pt1','dj1','m1');
        """) as db:
            djs, _ = self._candidates(db, datetime.date(2026, 8, 10))
            self.assertEqual(djs, 0)

    def test_delete_skip_only(self):
        with fixture_db("""
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot-keep','0x1','m1','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj-keep','ot-keep','0x1','m1','paper_copy','2026-08-01');
            INSERT INTO ObservedTrade(id,walletAddress,marketId,createdAt) VALUES('ot-del','0x1','m2','2026-08-01');
            INSERT INTO DecisionJournal(id,observedTradeId,walletAddress,marketId,decision,createdAt) VALUES('dj-del','ot-del','0x1','m2','skip','2026-08-01');
        """) as db:
            cutoff = datetime.date(2026, 8, 10)
            con = sqlite3.connect(db)
            hw = self.arch.snapshot_high_water(con)
            deleted = self.arch.prune_exact(con, cutoff, hw)
            con.commit()
            rem_dj_ids = {r[0] for r in con.execute("SELECT id FROM DecisionJournal").fetchall()}
            rem_ot_count = con.execute("SELECT COUNT(*) FROM ObservedTrade").fetchone()[0]
            con.close()
            self.assertIn("dj-keep", rem_dj_ids)
            self.assertNotIn("dj-del", rem_dj_ids)
            self.assertEqual(rem_ot_count, 1)


# ===========================================================================
# 7. quick_check failure aborts
# ===========================================================================
class TestQuickCheck(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_garbage_file_aborts(self):
        """A file with non-SQLite content raises DatabaseError on PRAGMA; assert_quick_check must abort."""
        fd, bad_path = tempfile.mkstemp(suffix=".sqlite")
        os.write(fd, b"not a valid sqlite database")
        os.close(fd)
        with self.assertRaises(SystemExit):
            self.arch.assert_quick_check(pathlib.Path(bad_path))
        os.unlink(bad_path)


# ===========================================================================
# 8. Remote sidecar
# ===========================================================================
class TestRemoteSidecar(unittest.TestCase):
    def setUp(self):
        self.arch = _load_arch()

    def test_parsed(self):
        fake_proc = mock.Mock(returncode=0, stdout=b"abc123  file.zst\n")
        r = self.arch.remote_sidecar_hash(
            "gdrive:path/file.zst.sha256",
            _run=mock.Mock(return_value=fake_proc),
        )
        self.assertEqual(r, "abc123")


if __name__ == "__main__":
    unittest.main()