import type { Store } from './ports.ts';
import {
    GuardMode,
    ResendResult,
    Verdict,
    type GuardStatus,
    type LedgerRecord,
    type PendingResend,
    type ResendOutcome,
    type SessionState,
    type TurnVerdict,
    type UsageReading,
    type WindowGauge,
} from './types.ts';
import { UsageLedger } from './usage-ledger.ts';

// Sessions that reported usage this recently are taken as still working, so headroom is kept for one reply from each.
const ACTIVE_SESSION_SECONDS = 10 * 60;
// A session unheard of for this long is forgotten, so the store never grows with sessions long closed.
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// Refused prompts a session may have waiting at once, and the gap between their sends so each reply is measured first.
export const RESEND_LIMIT = 3;
const RESEND_SPACING_SECONDS = 120;

const LEDGER_KEY = 'ledger';
const SETTINGS_KEY = 'settings';
const RESENDS_KEY = 'resends';
const SESSION_KEY_PREFIX = 'session:';

interface Settings {
    allSessions: GuardMode;
    resendBlocked: boolean;
}

const DEFAULT_SETTINGS: Settings = { allSessions: GuardMode.On, resendBlocked: false };
const NEW_SESSION: SessionState = { mode: undefined, reportedAtSeconds: undefined, lastReadings: [] };

// Decides whether a session may start work that could bill usage credits, from the usage every session reports.
export class SpendGuard {
    constructor(
        private readonly store: Store,
        readonly nowSeconds: () => number = () => Date.now() / 1000,
    ) {}

    // Called whenever a session learns its gauges. A gauge that fell since the same session last reported it means
    // the account's usage really dropped, and replaces whatever any session recorded.
    async recordReadings(sessionId: string, readings: readonly UsageReading[]): Promise<void> {
        const now = this.nowSeconds();
        const session = await this.session(sessionId);
        if (readings.length > 0) {
            const ledger = await this.ledger();
            for (const reading of readings) {
                const previous = session.lastReadings.find((last) => UsageLedger.sameWindow(last, reading));
                if (previous !== undefined && reading.percentUsed < previous.percentUsed) {
                    ledger.replace(reading);
                } else {
                    ledger.record(reading);
                }
            }
            await this.store.set(LEDGER_KEY, ledger.snapshot());
        }
        const lastReadings = readings.length > 0 ? readings : session.lastReadings;
        await this.saveSession(sessionId, { ...session, reportedAtSeconds: now, lastReadings });
    }

    // Forgets the recorded usage, so work goes on until the next reply brings fresh gauges.
    async forgetUsage(sessionId: string): Promise<GuardStatus> {
        await this.store.set(LEDGER_KEY, []);
        return this.status(sessionId);
    }

    async verdictFor(sessionId: string): Promise<TurnVerdict> {
        const now = this.nowSeconds();
        const [session, settings] = await Promise.all([this.session(sessionId), this.settings()]);
        if ((session.mode ?? settings.allSessions) === GuardMode.Off) {
            return { verdict: Verdict.Proceed };
        }
        const [ledger, sessions] = await Promise.all([this.ledger(), this.sessions()]);
        const recentlyActive = [...sessions.values()].filter((other) => (other.reportedAtSeconds ?? -Infinity) >= now - ACTIVE_SESSION_SECONDS);
        const activeSessions = Math.max(1, recentlyActive.length);
        const gauge = ledger.windowAboutToBill(now, activeSessions);
        if (gauge === undefined) {
            return { verdict: Verdict.Proceed };
        }
        return { verdict: Verdict.Refuse, gauge, activeSessions, resendBlocked: settings.resendBlocked };
    }

    async setMode(sessionId: string, mode: GuardMode): Promise<GuardStatus> {
        await this.saveSession(sessionId, { ...(await this.session(sessionId)), mode });
        return this.status(sessionId);
    }

    // Sets the mode for every session, current and future. A session may still choose its own mode afterwards.
    async setModeForAll(sessionId: string, mode: GuardMode): Promise<GuardStatus> {
        await this.saveSettings({ ...(await this.settings()), allSessions: mode });
        for (const [id, session] of await this.sessions()) {
            if (session.mode !== undefined) {
                await this.saveSession(id, { ...session, mode: undefined });
            }
        }
        return this.status(sessionId);
    }

    // Whether a refused prompt is sent again after the reset, for every session.
    async setResendBlocked(sessionId: string, on: boolean): Promise<GuardStatus> {
        await this.saveSettings({ ...(await this.settings()), resendBlocked: on });
        return this.status(sessionId);
    }

    async status(sessionId: string): Promise<GuardStatus> {
        const [session, settings, ledger] = await Promise.all([this.session(sessionId), this.settings(), this.ledger()]);
        return {
            mode: session.mode ?? settings.allSessions,
            allSessions: settings.allSessions,
            resendBlocked: settings.resendBlocked,
            reportedAtSeconds: session.reportedAtSeconds,
            gauges: ledger.liveGauges(this.nowSeconds()),
        };
    }

    // Queues a refused prompt for the first minute after its window resets, each further one of the session two
    // minutes later so the reply before it is measured first. The same prompt is queued once.
    async scheduleResend(sessionId: string, text: string, gauge: WindowGauge): Promise<ResendOutcome> {
        const pending = await this.resends();
        const own = pending.filter((resend) => resend.sessionId === sessionId);
        const same = own.find((resend) => resend.text === text);
        if (same !== undefined) {
            return { result: ResendResult.AlreadyScheduled, atSeconds: same.atSeconds };
        }
        if (own.length >= RESEND_LIMIT) {
            return { result: ResendResult.LimitReached };
        }
        const firstMinute = Math.ceil((gauge.resetsAtSeconds + 1) / 60) * 60;
        const atSeconds = firstMinute + RESEND_SPACING_SECONDS * own.length;
        await this.store.set(RESENDS_KEY, [...pending, { sessionId, text, atSeconds }]);
        return { result: ResendResult.Scheduled, atSeconds };
    }

    // The prompts waiting to be sent again in this session.
    async pendingResends(sessionId: string): Promise<PendingResend[]> {
        return (await this.resends()).filter((resend) => resend.sessionId === sessionId);
    }

    // Takes a waiting prompt off the queue, whether or not it is still there.
    async dropResend(sessionId: string, text: string): Promise<void> {
        const pending = await this.resends();
        await this.store.set(
            RESENDS_KEY,
            pending.filter((resend) => !(resend.sessionId === sessionId && resend.text === text)),
        );
    }

    private async ledger(): Promise<UsageLedger> {
        return UsageLedger.restore(((await this.store.get(LEDGER_KEY)) as LedgerRecord[] | undefined) ?? []);
    }

    private async settings(): Promise<Settings> {
        return { ...DEFAULT_SETTINGS, ...((await this.store.get(SETTINGS_KEY)) as Partial<Settings> | undefined) };
    }

    private saveSettings(settings: Settings): Promise<void> {
        return this.store.set(SETTINGS_KEY, settings);
    }

    private async resends(): Promise<PendingResend[]> {
        return ((await this.store.get(RESENDS_KEY)) as PendingResend[] | undefined) ?? [];
    }

    private async session(sessionId: string): Promise<SessionState> {
        return { ...NEW_SESSION, ...((await this.store.get(SESSION_KEY_PREFIX + sessionId)) as Partial<SessionState> | undefined) };
    }

    private saveSession(sessionId: string, session: SessionState): Promise<void> {
        return this.store.set(SESSION_KEY_PREFIX + sessionId, session);
    }

    // Every session heard of within its lifetime.
    private async sessions(): Promise<Map<string, SessionState>> {
        const oldest = this.nowSeconds() - SESSION_LIFETIME_SECONDS;
        const sessions = new Map<string, SessionState>();
        for (const key of await this.store.keys()) {
            if (!key.startsWith(SESSION_KEY_PREFIX)) {
                continue;
            }
            const session = { ...NEW_SESSION, ...((await this.store.get(key)) as Partial<SessionState> | undefined) };
            if ((session.reportedAtSeconds ?? oldest) >= oldest) {
                sessions.set(key.slice(SESSION_KEY_PREFIX.length), session);
            }
        }
        return sessions;
    }
}
