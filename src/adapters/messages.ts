// Every sentence the user reads from spend-guard.
import { GuardMode, UsageWindow, type GuardStatus, type ProbeRecord, type RefusedTurn, type WindowGauge } from '../domain/types.ts';
import { PROBE_TIMEOUT_SECONDS } from '../domain/spend-guard.ts';
import { PING_MODEL } from '../infrastructure/usage-ping.ts';
import { RESEND_LIMIT } from '../infrastructure/scheduled-tasks-file.ts';
import { ResendResult, type ResendOutcome } from '../infrastructure/scheduled-tasks-file.types.ts';

// The user command `/spend-guard <argument>`. The hook answers it before it expands, so it never reaches Claude.
export const COMMAND_NAME = 'spend-guard';

export enum SpendCommand {
    On = 'on',
    Off = 'off',
    // `resend on` or `resend off`: whether a refused prompt is sent again after the reset.
    Resend = 'resend',
    // Forgets the recorded usage, for a reset the guard did not see.
    Reset = 'reset',
    // Starts a usage ping now.
    Check = 'check',
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
        `${name} ${SpendCommand.Check} to learn the live usage with a one-word ${PING_MODEL} reply,`,
        `${name} ${SpendCommand.Reset} to forget the recorded usage after a reset it did not see,`,
        `or ${name} alone to see usage.`,
    ].join('\n');
}

// What the user command expands to when the hook did not answer it, which means the plugin is not running.
export const COMMAND_FILE_TEXT = [
    '---',
    'description: Turn spend-guard on or off for this session or for all, resend blocked prompts after the reset, check or forget recorded usage, or see usage. Answered by spend-guard, never reaches Claude.',
    '---',
    'spend-guard did not answer this command, so its hooks are not running. Tell the user, in plain words:',
    'the plugin is disabled or uninstalled; run `claude plugin enable spend-guard` to bring it back,',
    'or `/spend-guard:disconnect` to remove this command. Do nothing else. Arguments: $ARGUMENTS',
    '',
].join('\n');

const NO_COMMAND = '(none)';

export const NOT_CONNECTED = 'Run /spend-guard:connect to connect. Until then spend-guard sees no usage and stops nothing.';

const NOT_REPORTING =
    "No usage from this session yet. It arrives with Claude's next reply.\n" +
    'If it never does, a project settings file overrides the status line and this session is unguarded.';

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

export function couldNotCheck(cause: string): string {
    return `spend-guard stopped: it could not check usage (${cause}).\nTry again. If it repeats, run: claude plugin disable spend-guard`;
}

export function couldNotStart(cause: string): string {
    return `spend-guard could not start: ${cause}`;
}

export function connectDone(userCommand: string | undefined): string {
    return [
        'spend-guard is connected.',
        `Original status line command: ${userCommand ?? NO_COMMAND}`,
        `Added /${COMMAND_NAME} ${SpendCommand.On}, /${COMMAND_NAME} ${SpendCommand.Off} and /${COMMAND_NAME}.`,
        'Start a new session now. spend-guard protects it from the first reply.',
    ].join('\n');
}

export function alreadyConnected(userCommand: string | undefined): string {
    return ['spend-guard is already connected. Nothing changed.', `Original status line command: ${userCommand ?? NO_COMMAND}`].join('\n');
}

export function disconnectDone(userCommand: string | undefined): string {
    return [
        `Status line disconnected. /${COMMAND_NAME} removed.`,
        `Status line command now: ${userCommand ?? NO_COMMAND}`,
        'spend-guard sees no usage and stops nothing until /spend-guard:connect runs again.',
    ].join('\n');
}

export function nothingToDisconnect(currentCommand: string | undefined): string {
    return ['Nothing to disconnect. spend-guard is not connected.', `Status line command now: ${currentCommand ?? NO_COMMAND}`].join('\n');
}

export const PROBE_STARTED = `Checking the live usage with a one-word ${PING_MODEL} reply, which costs a little usage. Send your prompt again in a few seconds.`;

const CHECK_YOURSELF = `spend-guard cannot see a reset that comes before the time it recorded. Run /usage yourself; if the limit has reset, send /${COMMAND_NAME} ${SpendCommand.Check} or /${COMMAND_NAME} ${SpendCommand.Reset}.`;

// What the last usage ping gave; nothing when there never was one.
export function probeLine(probe: ProbeRecord | undefined, nowSeconds: number): string {
    if (probe === undefined) {
        return '';
    }
    if (probe.finishedAtSeconds === undefined) {
        if (nowSeconds - probe.startedAtSeconds < PROBE_TIMEOUT_SECONDS) {
            return 'A live usage check is running. Send your prompt again in a few seconds.';
        }
        return `The live usage check started at ${formatTime(probe.startedAtSeconds, UsageWindow.FiveHour)} never reported back. ${CHECK_YOURSELF}`;
    }
    const at = formatTime(probe.finishedAtSeconds, UsageWindow.FiveHour);
    if (probe.failure === undefined) {
        return `Live usage checked at ${at}.`;
    }
    return `Could not check the live usage at ${at} (${probe.failure}). ${CHECK_YOURSELF}`;
}

export const USAGE_FORGOTTEN =
    'spend-guard forgot the recorded usage. Work goes on, and the next reply brings fresh gauges. If the limit did not reset, that reply may bill usage credits.';

export const RESEND_HINT = `Send /${COMMAND_NAME} ${SpendCommand.Resend} ${SpendCommand.On} to have blocked prompts sent again after the reset.`;

export function couldNotSchedule(cause: string): string {
    return `The prompt could not be scheduled to be sent again (${cause}). Send it again after the reset.`;
}

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

// wrapped: the user's settings run the guard's status line.
export function describeStatus(status: GuardStatus, wrapped: boolean, nowSeconds = Date.now() / 1000): string {
    const reporting = status.statusLineSeenAtSeconds !== undefined;
    const lines = [modeLine(status), resendLine(status)];
    if (!wrapped) {
        lines.push(NOT_CONNECTED);
    } else if (!reporting) {
        lines.push(NOT_REPORTING);
    }
    lines.push(probeLine(status.lastProbe, nowSeconds));
    for (const window of Object.values(UsageWindow)) {
        const gauge = status.gauges.find((liveGauge) => liveGauge.window === window);
        if (gauge) {
            const label = WINDOW_LABELS[window];
            const used = `${percent(gauge.percentUsed)} used, a reply adds ~${percent(gauge.typicalRise)}`;
            lines.push(`${label}: ${used}, resets ${resetTime(gauge)}`);
        } else if (reporting) {
            lines.push(`${WINDOW_LABELS[window]}: no data yet, arrives with Claude's next reply`);
        }
    }
    return lines.filter((line) => line !== '').join('\n');
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
