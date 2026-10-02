// Every sentence the user reads from spend-guard.
import { RESEND_LIMIT } from '../domain/spend-guard.ts';
import { GuardMode, ResendResult, UsageWindow, type GuardStatus, type RefusedTurn, type ResendOutcome, type WindowGauge } from '../domain/types.ts';

// The slash command `/spend-guard <argument>`, answered by the mod and never reaching Claude.
export const COMMAND_NAME = 'spend-guard';
export const COMMAND_DESCRIPTION =
    'Turn spend-guard on or off for this session or for all, resend blocked prompts after the reset, forget recorded usage, or see usage.';

export enum SpendCommand {
    On = 'on',
    Off = 'off',
    // `resend on` or `resend off`: whether a refused prompt is sent again after the reset.
    Resend = 'resend',
    // Forgets the recorded usage, for a reset the guard did not see.
    Reset = 'reset',
    Status = '',
}

// The second word that makes `on` or `off` apply to every session.
export const ALL_SESSIONS = 'all';

// Verb first, no blame: the forms the command takes, nothing about what was typed.
export function commandUsage(): string {
    const name = `/${COMMAND_NAME}`;
    return [
        `spend-guard: send ${name} ${SpendCommand.On} or ${name} ${SpendCommand.Off} for this session,`,
        `${name} ${SpendCommand.On} ${ALL_SESSIONS} or ${name} ${SpendCommand.Off} ${ALL_SESSIONS} for every session,`,
        `${name} ${SpendCommand.Resend} ${SpendCommand.On} or ${name} ${SpendCommand.Resend} ${SpendCommand.Off} to send blocked prompts again after the reset,`,
        `${name} ${SpendCommand.Reset} to forget the recorded usage after a reset it did not see,`,
        `or ${name} alone to see usage.`,
    ].join('\n');
}

const NOT_REPORTING = "No usage from this session yet. It arrives with Claude's next reply.";

// The first line answers what the command did: the mode here and everywhere, then what it means for this session.
function modeLine(status: GuardStatus): string {
    const everywhere = status.mode === status.allSessions;
    const scope = everywhere ? 'all sessions' : `this session, ${status.allSessions} for the others`;
    const here = everywhere ? '' : ' here';
    const meaning =
        status.mode === GuardMode.On
            ? `Work stops${here} before a reply bills usage credits.`
            : `Replies${here} may bill usage credits.`;
    const wayBack =
        everywhere && status.mode === GuardMode.Off ? ` Send /${COMMAND_NAME} ${SpendCommand.On} ${ALL_SESSIONS} to guard them again.` : '';
    return `spend-guard: ${status.mode} for ${scope}. ${meaning}${wayBack}`;
}

const WINDOW_LABELS: Record<UsageWindow, string> = {
    [UsageWindow.FiveHour]: '5-hour',
    [UsageWindow.Weekly]: 'weekly',
};

// The weekly reset can be days away, so it names the day.
const RESET_TIME_FORMATS: Record<UsageWindow, Intl.DateTimeFormatOptions> = {
    [UsageWindow.FiveHour]: { hour: 'numeric', minute: '2-digit' },
    [UsageWindow.Weekly]: { weekday: 'short', hour: 'numeric', minute: '2-digit' },
};

export const USAGE_FORGOTTEN =
    'spend-guard forgot the recorded usage. Work goes on, and the next reply brings fresh gauges. If the limit did not reset, that reply may bill usage credits.';

export const RESEND_HINT = `Send /${COMMAND_NAME} ${SpendCommand.Resend} ${SpendCommand.On} to have blocked prompts sent again after the reset.`;

// What became of a refused prompt that was to be sent again.
export function resendOutcome(outcome: ResendOutcome, window: UsageWindow): string {
    switch (outcome.result) {
        case ResendResult.Scheduled:
            return `Your prompt is scheduled to be sent again at ${formatTime(outcome.atSeconds, window)} in this session, if it is still open then.`;
        case ResendResult.AlreadyScheduled:
            return `This prompt is already scheduled to be sent again at ${formatTime(outcome.atSeconds, window)}.`;
        case ResendResult.LimitReached:
            return `${RESEND_LIMIT} prompts are already scheduled to be sent again, so this one is not. Send it again after the reset.`;
    }
}

// The message for a session that may not start more work.
export function refusal(turn: RefusedTurn): string {
    const { gauge, activeSessions } = turn;
    const sessions = activeSessions > 1 ? `, ${activeSessions} sessions active` : '';
    return [
        `spend-guard: ${WINDOW_LABELS[gauge.window]} limit at ${percent(gauge.percentUsed)}${sessions}. The next reply may bill usage credits.`,
        `Wait for the reset at ${resetTime(gauge)}, or send /${COMMAND_NAME} ${SpendCommand.Off} to bill them anyway.`,
    ].join('\n');
}

export function describeStatus(status: GuardStatus): string {
    const reporting = status.reportedAtSeconds !== undefined;
    const lines = [modeLine(status), resendLine(status)];
    if (!reporting) {
        lines.push(NOT_REPORTING);
    }
    for (const window of Object.values(UsageWindow)) {
        const gauge = status.gauges.find((liveGauge) => liveGauge.window === window);
        if (gauge) {
            const used = `${percent(gauge.percentUsed)} used, a reply adds ~${percent(gauge.typicalRise)}`;
            lines.push(`${WINDOW_LABELS[window]}: ${used}, resets ${resetTime(gauge)}`);
        } else if (reporting) {
            lines.push(`${WINDOW_LABELS[window]}: no data yet, arrives with Claude's next reply`);
        }
    }
    return lines.join('\n');
}

// The one line kept under the prompt: the mode when off, else the fullest live gauge.
export function statusLine(status: GuardStatus): string | undefined {
    if (status.mode === GuardMode.Off) {
        return 'spend-guard off';
    }
    const fullest = [...status.gauges].sort((a, b) => b.percentUsed + b.typicalRise - (a.percentUsed + a.typicalRise))[0];
    if (fullest === undefined) {
        return undefined;
    }
    return `spend-guard: ${WINDOW_LABELS[fullest.window]} ${percent(fullest.percentUsed)}, resets ${resetTime(fullest)}`;
}

// At most one decimal, so a measured 0.30000000000001137 reads as 0.3%.
function percent(value: number): string {
    return `${Number(value.toFixed(1))}%`;
}

function resendLine(status: GuardStatus): string {
    if (status.resendBlocked) {
        return `Blocked prompts are sent again after the reset. Send /${COMMAND_NAME} ${SpendCommand.Resend} ${SpendCommand.Off} to stop that.`;
    }
    return `Blocked prompts are not sent again. ${RESEND_HINT}`;
}

function formatTime(seconds: number, window: UsageWindow): string {
    return new Date(seconds * 1000).toLocaleString(undefined, RESET_TIME_FORMATS[window]);
}

function resetTime(gauge: WindowGauge): string {
    return formatTime(gauge.resetsAtSeconds, gauge.window);
}
