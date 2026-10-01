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
    // When this session's status line last reached the guard; undefined means the guard may not see this session's usage.
    statusLineSeenAtSeconds: number | undefined;
    // The gauges this session last sent. A session's own gauge only falls when the account's usage really dropped.
    lastReadings: readonly UsageReading[];
}

// What a usage ping gave: the live gauges, or why there are none.
export type UsageProbe = { readings: UsageReading[] } | { failure: string };

// The last usage ping: started, and if it finished, with what. A ping still running has no finish time.
export interface ProbeRecord {
    startedAtSeconds: number;
    finishedAtSeconds: number | undefined;
    failure: string | undefined;
}

export interface GuardStatus {
    // The mode in force for this session.
    mode: GuardMode;
    allSessions: GuardMode;
    // Whether a refused prompt is sent again after the reset; one setting for every session.
    resendBlocked: boolean;
    statusLineSeenAtSeconds: number | undefined;
    lastProbe: ProbeRecord | undefined;
    gauges: WindowGauge[];
}
