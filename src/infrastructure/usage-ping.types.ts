// One line of Claude Code's stream-json output, as far as the ping reads it.
export interface RateLimitEvent {
    type: string;
    rate_limit_info?: {
        status?: string;
        unifiedWindows?: {
            five_hour?: RateLimitWindow;
            seven_day?: RateLimitWindow;
            [otherWindow: string]: unknown;
        };
        [otherField: string]: unknown;
    };
}

export interface RateLimitWindow {
    // Share of the window used, 0 to 1.
    utilization: number;
    // Seconds since the epoch.
    resetsAt: number;
}
