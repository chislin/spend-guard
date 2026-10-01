import type { GuardRepository, GuardState } from '../src/domain/ports.ts';
import { GuardMode, type LedgerRecord, type ProbeRecord, type SessionState } from '../src/domain/types.ts';
import { UsageLedger } from '../src/domain/usage-ledger.ts';

const NEW_SESSION: SessionState = { mode: undefined, statusLineSeenAtSeconds: undefined, lastReadings: [] };

// The repository as the domain sees it, with nothing underneath. Every transaction sees the same state.
export class MemoryGuardRepository implements GuardRepository, GuardState {
    private records: readonly LedgerRecord[] = [];
    private readonly sessions = new Map<string, SessionState>();
    private allSessions = GuardMode.On;
    private resend = false;
    private probe: ProbeRecord | undefined;

    async transaction<T>(work: (state: GuardState) => T): Promise<T> {
        return work(this);
    }

    ledger(): UsageLedger {
        return UsageLedger.restore(this.records);
    }

    saveLedger(ledger: UsageLedger): void {
        this.records = ledger.snapshot();
    }

    session(sessionId: string): SessionState {
        return this.sessions.get(sessionId) ?? NEW_SESSION;
    }

    saveSession(sessionId: string, state: SessionState): void {
        this.sessions.set(sessionId, state);
    }

    modeForAllSessions(): GuardMode {
        return this.allSessions;
    }

    saveModeForAllSessions(mode: GuardMode): void {
        this.allSessions = mode;
    }

    forgetSessionModes(): void {
        for (const [sessionId, session] of this.sessions) {
            this.sessions.set(sessionId, { ...session, mode: undefined });
        }
    }

    resendBlocked(): boolean {
        return this.resend;
    }

    saveResendBlocked(on: boolean): void {
        this.resend = on;
    }

    lastProbe(): ProbeRecord | undefined {
        return this.probe;
    }

    saveProbe(probe: ProbeRecord): void {
        this.probe = probe;
    }

    countSessionsSeenSince(seconds: number): number {
        const seen = [...this.sessions.values()].map((session) => session.statusLineSeenAtSeconds);
        return seen.filter((seenAt) => seenAt !== undefined && seenAt >= seconds).length;
    }
}
