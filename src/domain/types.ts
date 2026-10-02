export enum UsageWindow {
    FiveHour = 'five-hour',
    Weekly = 'weekly',
}

export interface UsageReading {
    window: UsageWindow;
    percentUsed: number;
    resetsAtSeconds: number;
}

export interface WindowGauge extends UsageReading {
    // Percentage points usage typically rises between two readings; the headroom one more reply needs.
    typicalRise: number;
}

export interface LedgerRecord extends UsageReading {
    // Rises between consecutive readings of one window, newest last.
    recentRises: number[];
}

// Whether this session is guarded. Off means replies may bill usage credits.
export enum GuardMode {
    On = 'on',
    Off = 'off',
}

export enum Verdict {
    Proceed = 'proceed',
    Refuse = 'refuse',
}

export type TurnVerdict =
    | { verdict: Verdict.Proceed }
    // activeSessions: sessions that reported usage recently; each is assumed to want one more reply.
    // resendBlocked: the user wants a refused prompt sent again after the reset.
    | { verdict: Verdict.Refuse; gauge: WindowGauge; activeSessions: number; resendBlocked: boolean };

export type RefusedTurn = Extract<TurnVerdict, { verdict: Verdict.Refuse }>;

export interface SessionState {
    // The mode this session chose; undefined means it follows the setting for all sessions.
    mode: GuardMode | undefined;
    // When this session last reported usage; undefined means it never has, so its own gauges are unknown.
    reportedAtSeconds: number | undefined;
    // The gauges this session last reported. A session's own gauge only falls when the account's usage really dropped.
    lastReadings: readonly UsageReading[];
}

export interface GuardStatus {
    // The mode in force for this session.
    mode: GuardMode;
    allSessions: GuardMode;
    // Whether a refused prompt is sent again after the reset; one setting for every session.
    resendBlocked: boolean;
    reportedAtSeconds: number | undefined;
    gauges: WindowGauge[];
}

// A refused prompt waiting to be sent again in the session that typed it, once its window has reset.
export interface PendingResend {
    sessionId: string;
    text: string;
    atSeconds: number;
}

export enum ResendResult {
    Scheduled = 'scheduled',
    AlreadyScheduled = 'already-scheduled',
    LimitReached = 'limit-reached',
}

export type ResendOutcome = { result: ResendResult.Scheduled | ResendResult.AlreadyScheduled; atSeconds: number } | { result: ResendResult.LimitReached };
