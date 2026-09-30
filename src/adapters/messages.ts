// Every sentence the user reads from spend-guard.
import { GuardMode, UsageWindow, Verdict, type GuardStatus, type TurnVerdict, type WindowGauge } from '../domain/types.ts';

// The user command `/spend-guard <argument>`. The hook answers it before it expands, so it never reaches Claude.
export const COMMAND_NAME = 'spend-guard';

export enum SpendCommand {
    On = 'on',
    Off = 'off',
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
        `or ${name} alone to see usage.`,
    ].join('\n');
}

// What the user command expands to when the hook did not answer it, which means the plugin is not running.
export const COMMAND_FILE_TEXT = [
    '---',
    'description: Turn spend-guard on or off for this session or for all, or see usage. Answered by spend-guard, never reaches Claude.',
    '---',
    'spend-guard did not answer this command, so its hooks are not running. Tell the user, in plain words:',
    'the plugin is disabled or uninstalled; run `claude plugin enable spend-guard` to bring it back,',
    'or `/spend-guard:restore` to remove this command. Do nothing else. Arguments: $ARGUMENTS',
    '',
].join('\n');

const NO_COMMAND = '(none)';

export const NOT_CONNECTED = 'Run /spend-guard:setup to connect. Until then spend-guard sees no usage and stops nothing.';

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

export function setupDone(userCommand: string | undefined): string {
    return [
        'spend-guard is set up.',
        `Original status line command: ${userCommand ?? NO_COMMAND}`,
        `Added /${COMMAND_NAME} ${SpendCommand.On}, /${COMMAND_NAME} ${SpendCommand.Off} and /${COMMAND_NAME}.`,
        'Start a new session now. spend-guard protects it from the first reply.',
    ].join('\n');
}

export function alreadySetUp(userCommand: string | undefined): string {
    return ['spend-guard is already set up. Nothing changed.', `Original status line command: ${userCommand ?? NO_COMMAND}`].join('\n');
}

export function restoreDone(userCommand: string | undefined): string {
    return [
        `Status line restored. /${COMMAND_NAME} removed.`,
        `Status line command now: ${userCommand ?? NO_COMMAND}`,
        'spend-guard sees no usage and stops nothing until /spend-guard:setup runs again.',
    ].join('\n');
}

export function nothingToRestore(currentCommand: string | undefined): string {
    return ['Nothing to restore. spend-guard is not set up.', `Status line command now: ${currentCommand ?? NO_COMMAND}`].join('\n');
}

// The message for a session that may not start more work; undefined when it may.
export function refusal(turn: TurnVerdict): string | undefined {
    if (turn.verdict === Verdict.Proceed) {
        return undefined;
    }
    const { gauge, activeSessions } = turn;
    const sessions = activeSessions > 1 ? `, ${activeSessions} sessions active` : '';
    return [
        `spend-guard: ${WINDOW_LABELS[gauge.window]} limit at ${percent(gauge.percentUsed)}${sessions}. The next reply may bill usage credits.`,
        `Wait for the reset at ${resetTime(gauge)}, or send /${COMMAND_NAME} ${SpendCommand.Off} to bill them anyway.`,
    ].join('\n');
}

// wrapped: the user's settings run the guard's status line.
export function describeStatus(status: GuardStatus, wrapped: boolean): string {
    const reporting = status.statusLineSeenAtSeconds !== undefined;
    const lines = [modeLine(status)];
    if (!wrapped) {
        lines.push(NOT_CONNECTED);
    } else if (!reporting) {
        lines.push(NOT_REPORTING);
    }
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
    return lines.join('\n');
}

// At most one decimal, so a measured 0.30000000000001137 reads as 0.3%.
function percent(value: number): string {
    return `${Number(value.toFixed(1))}%`;
}

function resetTime(gauge: WindowGauge): string {
    return new Date(gauge.resetsAtSeconds * 1000).toLocaleString(undefined, RESET_TIME_FORMATS[gauge.window]);
}
