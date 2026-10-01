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
    // The project folder the session runs in; Claude Code keeps its scheduled prompts there.
    cwd?: string;
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

// A warning Claude Code shows the user. It is the one hook output a Remote Control device receives, so every
// refusal carries its text here as well: the block reason and the stop reason stay in the terminal.
export interface Notice {
    systemMessage: string;
}

export interface PromptBlock extends Notice {
    decision: 'block';
    reason: string;
}

export interface TurnStop extends Notice {
    continue: false;
    stopReason: string;
}
