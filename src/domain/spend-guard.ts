import type { GuardRepository, GuardState } from './ports.ts';
import { GuardMode, Verdict, type GuardStatus, type ProbeRecord, type SessionState, type TurnVerdict, type UsageProbe, type UsageReading } from './types.ts';
import { UsageLedger } from './usage-ledger.ts';

// Sessions whose status line refreshed this recently are taken as still working, so headroom is kept for one reply from each.
const ACTIVE_SESSION_SECONDS = 10 * 60;
// A refusal starts a usage ping at most this often, so a reset the sessions cannot see still lifts the block in time.
export const PROBE_INTERVAL_SECONDS = 5 * 60;
// A ping that has not reported back by then is given up on, and the next refusal may start another.
export const PROBE_TIMEOUT_SECONDS = 2 * 60;

// Decides whether a session may start work that could bill usage credits.
export class SpendGuard {
    constructor(
        private readonly repository: GuardRepository,
        readonly nowSeconds: () => number = () => Date.now() / 1000,
    ) {}

    // Called on each status line refresh of a session, with or without readings.
    // A gauge that fell since the same session last sent it reports a reset, and replaces whatever any session recorded.
    recordReadings(sessionId: string | undefined, readings: UsageReading[]): Promise<void> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            const session = sessionId === undefined ? undefined : state.session(sessionId);
            if (readings.length > 0) {
                const ledger = state.ledger();
                for (const reading of readings) {
                    const previous = session?.lastReadings.find((last) => UsageLedger.sameWindow(last, reading));
                    if (previous !== undefined && reading.percentUsed < previous.percentUsed) {
                        ledger.replace(reading);
                    } else {
                        ledger.record(reading);
                    }
                }
                state.saveLedger(ledger);
            }
            if (sessionId !== undefined && session !== undefined) {
                const lastReadings = readings.length > 0 ? readings : session.lastReadings;
                state.saveSession(sessionId, { ...session, statusLineSeenAtSeconds: now, lastReadings });
            }
        });
    }

    // Claims the next usage ping: true when the caller should start one now. A ping still running is never doubled.
    // One that never reported back is replaced once its timeout passed; otherwise, without force, the next is due
    // only after the interval since the last.
    claimProbe(force = false): Promise<boolean> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            const last = state.lastProbe();
            if (last !== undefined) {
                const sinceStart = now - last.startedAtSeconds;
                const unfinished = last.finishedAtSeconds === undefined;
                if (unfinished && sinceStart < PROBE_TIMEOUT_SECONDS) {
                    return false;
                }
                if (!unfinished && !force && sinceStart < PROBE_INTERVAL_SECONDS) {
                    return false;
                }
            }
            state.saveProbe({ startedAtSeconds: now, finishedAtSeconds: undefined, failure: undefined });
            return true;
        });
    }

    // Records what the ping gave. Live gauges are the truth for their windows, however low.
    recordProbe(probe: UsageProbe): Promise<void> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            const started = state.lastProbe()?.startedAtSeconds ?? now;
            state.saveProbe({ startedAtSeconds: started, finishedAtSeconds: now, failure: 'failure' in probe ? probe.failure : undefined });
            if ('readings' in probe) {
                const ledger = state.ledger();
                for (const reading of probe.readings) {
                    ledger.replace(reading);
                }
                state.saveLedger(ledger);
            }
        });
    }

    // Forgets the recorded usage, so work goes on until the next reply brings fresh gauges.
    forgetUsage(sessionId: string): Promise<GuardStatus> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            state.saveLedger(UsageLedger.restore([]));
            return statusOf(state, state.session(sessionId), now);
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
            return { verdict: Verdict.Refuse, gauge, activeSessions, resendBlocked: state.resendBlocked() };
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

    // Whether a refused prompt is sent again after the reset, for every session.
    setResendBlocked(sessionId: string, on: boolean): Promise<GuardStatus> {
        const now = this.nowSeconds();
        return this.repository.transaction((state) => {
            state.saveResendBlocked(on);
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
        resendBlocked: state.resendBlocked(),
        statusLineSeenAtSeconds: session.statusLineSeenAtSeconds,
        lastProbe: state.lastProbe(),
        gauges: state.ledger().liveGauges(nowSeconds),
    };
}

function modeOf(state: GuardState, session: SessionState): GuardMode {
    return session.mode ?? state.modeForAllSessions();
}
