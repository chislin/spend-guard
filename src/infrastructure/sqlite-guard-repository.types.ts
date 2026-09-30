// Rows as SQLite returns them. Columns hold whatever they were given, so the numbers are checked before they reach the domain.
export interface LedgerRow {
    window: string;
    percent_used: number;
    resets_at_seconds: number;
}

export interface RiseRow {
    window: string;
    rise: number;
}

export interface SessionRow {
    mode: string | null;
    status_line_seen_at_seconds: number | null;
}

export interface SettingRow {
    value: string;
}

export interface CountRow {
    count: number;
}

export interface VersionRow {
    user_version: number;
}
