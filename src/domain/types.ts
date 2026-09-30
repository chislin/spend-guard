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
    | { verdict: Verdict.Refuse; gauge: WindowGauge; activeSessions: number };

export interface SessionState {
    // The mode this session chose; undefined means it follows the setting for all sessions.
    mode: GuardMode | undefined;
    // When this session's status line last reached the guard; undefined means the guard may not see this session's usage.
    statusLineSeenAtSeconds: number | undefined;
}

export interface GuardStatus {
    // The mode in force for this session.
    mode: GuardMode;
    allSessions: GuardMode;
    statusLineSeenAtSeconds: number | undefined;
    gauges: WindowGauge[];
}
