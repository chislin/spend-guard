export enum HookEvent {
    SessionStart = 'SessionStart',
    UserPromptSubmit = 'UserPromptSubmit',
    UserPromptExpansion = 'UserPromptExpansion',
    PreToolUse = 'PreToolUse',
}

// What Claude Code sends a hook.
export interface HookInput {
    session_id: string;
    hook_event_name: HookEvent;
    prompt?: string;
    // UserPromptExpansion: the user typed `/<command_name> <command_args>`.
    command_name?: string;
    command_args?: string;
}

// What Claude Code sends the status line.
export interface StatusLineInput {
    session_id?: string;
    rate_limits?: Partial<Record<RateLimitKey, RateLimitWindow>>;
}

export type RateLimitKey = 'five_hour' | 'seven_day';

export interface RateLimitWindow {
    used_percentage: number;
    resets_at: number;
}

// A hook's stdout: one of the JSON shapes below, or empty to let the event through.
export type HookAnswer = string;

export interface PromptBlock {
    decision: 'block';
    reason: string;
}

export interface TurnStop {
    continue: false;
    stopReason: string;
}

export interface Notice {
    systemMessage: string;
}
