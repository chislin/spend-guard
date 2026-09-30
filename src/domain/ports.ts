import type { UsageLedger } from './usage-ledger.ts';
import type { GuardMode, SessionState } from './types.ts';

// Everything the guard remembers, as seen inside one transaction. A session never saved has no mode of its own and was never seen.
export interface GuardState {
    ledger(): UsageLedger;
    saveLedger(ledger: UsageLedger): void;
    session(sessionId: string): SessionState;
    saveSession(sessionId: string, state: SessionState): void;
    countSessionsSeenSince(seconds: number): number;
    // The mode for every session without a choice of its own; on until set.
    modeForAllSessions(): GuardMode;
    saveModeForAllSessions(mode: GuardMode): void;
    // Drops every session's own choice, so the setting for all sessions is in force everywhere.
    forgetSessionModes(): void;
}

// Runs work against the stored state as one atomic step, so concurrent sessions never see or drop half a change.
export interface GuardRepository {
    transaction<T>(work: (state: GuardState) => T): Promise<T>;
}
