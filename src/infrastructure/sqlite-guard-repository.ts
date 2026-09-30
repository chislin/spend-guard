import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GuardRepository, GuardState } from '../domain/ports.ts';
import { GuardMode, UsageWindow, type LedgerRecord, type SessionState } from '../domain/types.ts';
import { UsageLedger } from '../domain/usage-ledger.ts';
import type { CountRow, LedgerRow, RiseRow, SessionRow, SettingRow, VersionRow } from './sqlite-guard-repository.types.ts';

// A session untouched this long is forgotten the next time any session is saved.
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const BUSY_TIMEOUT_MS = 2000;

// A database written by another schema version is emptied: the ledger refills on the next status line refresh.
const SCHEMA_VERSION = 3;
const SCHEMA = `
    DROP TABLE IF EXISTS ledger;
    DROP TABLE IF EXISTS rises;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS settings;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ledger (window TEXT PRIMARY KEY, percent_used REAL NOT NULL, resets_at_seconds REAL NOT NULL);
    CREATE TABLE rises (window TEXT NOT NULL, position INTEGER NOT NULL, rise REAL NOT NULL, PRIMARY KEY (window, position));
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        mode TEXT,
        status_line_seen_at_seconds REAL,
        saved_at_seconds REAL NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
`;
const ALL_SESSIONS_KEY = 'mode_for_all_sessions';
const DAMAGED_FILE_CODES = ['SQLITE_NOTADB', 'SQLITE_CORRUPT'];

// One SQLite file shared by every session; ':memory:' keeps the state in the process.
export class SqliteGuardRepository implements GuardRepository {
    private database: Database | undefined;

    constructor(
        private readonly file: string,
        private readonly nowSeconds: () => number = () => Date.now() / 1000,
    ) {}

    async transaction<T>(work: (state: GuardState) => T): Promise<T> {
        const db = this.db();
        const state = new SqliteGuardState(db, this.nowSeconds());
        return db.transaction(() => work(state)).immediate();
    }

    private db(): Database {
        this.database ??= this.open();
        return this.database;
    }

    // A file that is not a database is replaced by an empty one. Any other failure throws, so the guard stops instead of passing blind.
    private open(): Database {
        try {
            return this.openFile();
        } catch (error) {
            const code = (error as { code?: string }).code ?? '';
            if (!DAMAGED_FILE_CODES.includes(code)) {
                throw error;
            }
            for (const suffix of ['', '-wal', '-shm']) {
                rmSync(this.file + suffix, { force: true });
            }
            return this.openFile();
        }
    }

    private openFile(): Database {
        if (this.file !== ':memory:') {
            mkdirSync(dirname(this.file), { recursive: true });
        }
        const db = new Database(this.file, { create: true });
        db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        db.run('PRAGMA journal_mode = WAL');
        db.transaction(() => {
            const version = db.query<VersionRow, []>('PRAGMA user_version').get()?.user_version;
            if (version !== SCHEMA_VERSION) {
                db.run(SCHEMA);
            }
        }).immediate();
        return db;
    }
}

// The tables of one open transaction, read and written as domain objects.
class SqliteGuardState implements GuardState {
    constructor(
        private readonly db: Database,
        private readonly now: number,
    ) {}

    ledger(): UsageLedger {
        const rows = this.db.query<LedgerRow, []>('SELECT * FROM ledger').all();
        const rises = this.db.query<RiseRow, []>('SELECT window, rise FROM rises ORDER BY window, position').all();
        const records: LedgerRecord[] = [];
        for (const row of rows) {
            const recentRises = rises.filter((rise) => rise.window === row.window).map((rise) => rise.rise);
            const record = recordFrom(row, recentRises);
            if (record !== undefined) {
                records.push(record);
            }
        }
        return UsageLedger.restore(records);
    }

    saveLedger(ledger: UsageLedger): void {
        this.db.run('DELETE FROM ledger');
        this.db.run('DELETE FROM rises');
        for (const record of ledger.snapshot()) {
            this.db.run('INSERT INTO ledger VALUES (?, ?, ?)', [record.window, record.percentUsed, record.resetsAtSeconds]);
            for (const [position, rise] of record.recentRises.entries()) {
                this.db.run('INSERT INTO rises VALUES (?, ?, ?)', [record.window, position, rise]);
            }
        }
    }

    session(sessionId: string): SessionState {
        const query = this.db.query<SessionRow, [string]>('SELECT mode, status_line_seen_at_seconds FROM sessions WHERE id = ?');
        const row = query.get(sessionId);
        return {
            mode: modeFrom(row?.mode ?? null),
            statusLineSeenAtSeconds: row?.status_line_seen_at_seconds ?? undefined,
        };
    }

    saveSession(sessionId: string, state: SessionState): void {
        const seenAt = state.statusLineSeenAtSeconds ?? null;
        this.db.run('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?)', [sessionId, state.mode ?? null, seenAt, this.now]);
        this.db.run('DELETE FROM sessions WHERE saved_at_seconds < ?', [this.now - SESSION_LIFETIME_SECONDS]);
    }

    modeForAllSessions(): GuardMode {
        const row = this.db.query<SettingRow, [string]>('SELECT value FROM settings WHERE key = ?').get(ALL_SESSIONS_KEY);
        return modeFrom(row?.value ?? null) ?? GuardMode.On;
    }

    saveModeForAllSessions(mode: GuardMode): void {
        this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?)', [ALL_SESSIONS_KEY, mode]);
    }

    forgetSessionModes(): void {
        this.db.run('UPDATE sessions SET mode = NULL');
    }

    countSessionsSeenSince(seconds: number): number {
        const query = this.db.query<CountRow, [number]>('SELECT count(*) AS count FROM sessions WHERE status_line_seen_at_seconds >= ?');
        const row = query.get(seconds);
        return row?.count ?? 0;
    }
}

// Undefined for anything but the two modes, by a manual edit or an older build.
function modeFrom(value: string | null): GuardMode | undefined {
    return value === GuardMode.On || value === GuardMode.Off ? value : undefined;
}

// Undefined for a row that lost its numbers or names an unknown window, by a manual edit or an older build.
function recordFrom(row: LedgerRow, recentRises: number[]): LedgerRecord | undefined {
    const numbers = [row.percent_used, row.resets_at_seconds, ...recentRises];
    if (!isUsageWindow(row.window) || !numbers.every(Number.isFinite)) {
        return undefined;
    }
    return { window: row.window, percentUsed: row.percent_used, resetsAtSeconds: row.resets_at_seconds, recentRises };
}

function isUsageWindow(value: string): value is UsageWindow {
    return Object.values(UsageWindow).includes(value as UsageWindow);
}
