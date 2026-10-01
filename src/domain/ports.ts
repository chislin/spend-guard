import type { UsageLedger } from './usage-ledger.ts';
import type { GuardMode, ProbeRecord, SessionState, UsageProbe } from './types.ts';

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
    // Whether a refused prompt is scheduled to be sent again after the reset; off until set.
    resendBlocked(): boolean;
    saveResendBlocked(on: boolean): void;
    // The last usage ping; undefined when none was ever started.
    lastProbe(): ProbeRecord | undefined;
    saveProbe(probe: ProbeRecord): void;
}

// Where the live usage can be learned at the price of one tiny reply.
export interface UsageSource {
    readUsage(): Promise<UsageProbe>;
}

// Runs work against the stored state as one atomic step, so concurrent sessions never see or drop half a change.
export interface GuardRepository {
    transaction<T>(work: (state: GuardState) => T): Promise<T>;
}
