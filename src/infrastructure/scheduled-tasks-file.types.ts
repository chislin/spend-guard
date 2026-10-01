// The file as Claude Code writes it. Only the fields spend-guard reads or writes are named; the rest travel untouched.
export interface ScheduledTasks {
    tasks: ScheduledTask[];
}

export interface ScheduledTask {
    id: string;
    // Five cron fields in local time. A task without `recurring` fires once at the next match and is then removed.
    cron: string;
    prompt: string;
    // Milliseconds since the epoch.
    createdAt: number;
    // Claude Code runs a task in the session that created it.
    createdBySessionId?: string;
    createdInProject?: string;
    [otherField: string]: unknown;
}

export interface ResendRequest {
    projectDir: string;
    sessionId: string;
    prompt: string;
    // The prompt is sent in the first minute after this time: the reset of the window that refused it.
    notBeforeSeconds: number;
}

export enum ResendResult {
    Scheduled = 'scheduled',
    AlreadyScheduled = 'already-scheduled',
    LimitReached = 'limit-reached',
}

export type ResendOutcome =
    | { result: ResendResult.Scheduled; atSeconds: number }
    | { result: ResendResult.AlreadyScheduled; atSeconds: number }
    | { result: ResendResult.LimitReached; pending: number };
