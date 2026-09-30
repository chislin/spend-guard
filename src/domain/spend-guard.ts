import type { GuardRepository, GuardState } from './ports.ts';
import { GuardMode, Verdict, type GuardStatus, type SessionState, type TurnVerdict, type UsageReading } from './types.ts';

// Sessions whose status line refreshed this recently are taken as still working, so headroom is kept for one reply from each.
const ACTIVE_SESSION_SECONDS = 10 * 60;

// Decides whether a session may start work that could bill usage credits.
export class SpendGuard {
    constructor(
        private readonly repository: GuardRepository,
        private readonly nowSeconds: () => number = () => Date.now() / 1000,
    ) {}

    // Called on each status line refresh of a session, with or without readings.
    recordReadings(sessionId: string | undefined, readings: UsageReading[]): Promise<void> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            if (readings.length > 0) {
                const ledger = state.ledger();
                for (const reading of readings) {
                    ledger.record(reading);
                }
                state.saveLedger(ledger);
            }
            if (sessionId !== undefined) {
                const session = state.session(sessionId);
                state.saveSession(sessionId, { ...session, statusLineSeenAtSeconds: now });
            }
        });
    }

    verdictFor(sessionId: string): Promise<TurnVerdict> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            if (modeOf(state, state.session(sessionId)) === GuardMode.Off) {
                return { verdict: Verdict.Proceed };
            }
            const activeSessions = Math.max(1, state.countSessionsSeenSince(now - ACTIVE_SESSION_SECONDS));
            const gauge = state.ledger().windowAboutToBill(now, activeSessions);
            if (gauge === undefined) {
                return { verdict: Verdict.Proceed };
            }
            return { verdict: Verdict.Refuse, gauge, activeSessions };
        });
    }

    setMode(sessionId: string, mode: GuardMode): Promise<GuardStatus> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            const session = { ...state.session(sessionId), mode };
            state.saveSession(sessionId, session);
            return statusOf(state, session, now);
        });
    }

    // Sets the mode for every session, current and future. A session may still choose its own mode afterwards.
    setModeForAll(sessionId: string, mode: GuardMode): Promise<GuardStatus> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            state.saveModeForAllSessions(mode);
            state.forgetSessionModes();
            return statusOf(state, state.session(sessionId), now);
        });
    }

    status(sessionId: string): Promise<GuardStatus> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => statusOf(state, state.session(sessionId), now));
    }
}

function statusOf(state: GuardState, session: SessionState, nowSeconds: number): GuardStatus {
    return {
        mode: modeOf(state, session),
        allSessions: state.modeForAllSessions(),
        statusLineSeenAtSeconds: session.statusLineSeenAtSeconds,
        gauges: state.ledger().liveGauges(nowSeconds),
    };
}

function modeOf(state: GuardState, session: SessionState): GuardMode {
    return session.mode ?? state.modeForAllSessions();
}
