// The only module that knows Claude Code's engine: its events, its store, its clock, its command and status line.
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code';
import { SpendGuard } from '../domain/spend-guard.ts';
import { GuardMode, UsageWindow, Verdict, type GuardStatus, type RefusedTurn, type UsageReading } from '../domain/types.ts';
import {
    ALL_SESSIONS,
    COMMAND_DESCRIPTION,
    COMMAND_NAME,
    commandUsage,
    describeStatus,
    refusal,
    RESEND_HINT,
    resendOutcome,
    SpendCommand,
    statusLine,
    USAGE_FORGOTTEN,
} from './messages.ts';

// The engine's names for the plan windows the guard watches; any other kind (a gateway's spend limit) is not a plan gauge.
const WINDOWS: Record<string, UsageWindow> = {
    five_hour: UsageWindow.FiveHour,
    seven_day: UsageWindow.Weekly,
};

const COMMAND_MODES: Record<string, GuardMode | undefined> = {
    [SpendCommand.On]: GuardMode.On,
    [SpendCommand.Off]: GuardMode.Off,
};

export const register: Register = (on) => {
    on('session.start', async ($, e, next) => {
        const guard = guardOf($);
        const sessionId = await $.session.id();
        // A resumed session already has its gauges; a fresh one learns them with its first reply.
        await guard.recordReadings(sessionId, readingsFrom((await $.session.usage()).rateLimits));
        for (const pending of await guard.pendingResends(sessionId)) {
            armResend($, guard, sessionId, pending.text, pending.atSeconds);
        }
        $.ui.status(statusLine(await guard.status(sessionId)));
        // Refused while the user still has 1.x's own /spend-guard command file; the command.run hook answers that one too.
        await $.command.register({ name: COMMAND_NAME, description: COMMAND_DESCRIPTION, argumentHint: 'on | off [all] | resend on|off | reset' }).catch(() => undefined);
        return next(e);
    });

    on('session.measure', async ($, e, next) => {
        if (e.changed.includes('rateLimits')) {
            const guard = guardOf($);
            const sessionId = await $.session.id();
            await guard.recordReadings(sessionId, readingsFrom(e.rateLimits));
            $.ui.status(statusLine(await guard.status(sessionId)));
        }
        return next(e);
    });

    on('tool.call', async ($, e, next) => {
        const turn = await guardOf($).verdictFor(await $.session.id());
        return turn.verdict === Verdict.Refuse ? { deny: refusal(turn) } : next(e);
    });

    on('prompt.submit', async ($, e, next) => {
        // A slash command is answered by command.run, and a prompt the guard itself resends has waited for the reset.
        if (e.text.startsWith('/') || e.origin.kind === 'plugin') {
            return next(e);
        }
        const guard = guardOf($);
        const sessionId = await $.session.id();
        const turn = await guard.verdictFor(sessionId);
        if (turn.verdict === Verdict.Proceed) {
            return next(e);
        }
        return { drop: [refusal(turn), await resendLine($, guard, sessionId, e.text, turn)].join('\n') };
    });

    on('command.run', { command: COMMAND_NAME }, async ($, e) => {
        const guard = guardOf($);
        const sessionId = await $.session.id();
        const [first = '', second = ''] = e.args.trim().split(/\s+/);
        const text = await answerCommand(guard, sessionId, first, second);
        $.ui.status(statusLine(await guard.status(sessionId)));
        return { text };
    });
};

// The engine's store, called noun by noun at the call site as the engine requires; the guard sees only the Store port.
function guardOf($: EngineInterface): SpendGuard {
    return new SpendGuard({
        get: (key) => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
        keys: () => $.store.keys(),
    });
}

function readingsFrom(rateLimits: readonly SessionRateLimit[]): UsageReading[] {
    const readings: UsageReading[] = [];
    for (const limit of rateLimits) {
        const window = WINDOWS[limit.kind];
        if (window !== undefined && limit.resetsAt !== undefined) {
            readings.push({ window, percentUsed: limit.percentUsed, resetsAtSeconds: Date.parse(limit.resetsAt) / 1000 });
        }
    }
    return readings;
}

async function answerCommand(guard: SpendGuard, sessionId: string, first: string, second: string): Promise<string> {
    const mode = COMMAND_MODES[first];
    if (mode !== undefined && (second === '' || second === ALL_SESSIONS)) {
        const status = second === ALL_SESSIONS ? await guard.setModeForAll(sessionId, mode) : await guard.setMode(sessionId, mode);
        return describeStatus(status);
    }
    if (first === SpendCommand.Resend && COMMAND_MODES[second] !== undefined) {
        return describeStatus(await guard.setResendBlocked(sessionId, second === SpendCommand.On));
    }
    if (first === SpendCommand.Reset && second === '') {
        return [USAGE_FORGOTTEN, describeStatus(await guard.forgetUsage(sessionId))].join('\n');
    }
    if (first === SpendCommand.Status) {
        return describeStatus(await guard.status(sessionId));
    }
    return commandUsage();
}

// Queues the refused prompt when the user asked for that, and says what became of it either way.
async function resendLine($: EngineInterface, guard: SpendGuard, sessionId: string, text: string, turn: RefusedTurn): Promise<string> {
    if (!turn.resendBlocked) {
        return RESEND_HINT;
    }
    const outcome = await guard.scheduleResend(sessionId, text, turn.gauge);
    if ('atSeconds' in outcome) {
        armResend($, guard, sessionId, text, outcome.atSeconds);
    }
    return resendOutcome(outcome, turn.gauge.window);
}

// Sends the prompt as the user's own once its time comes, in this session; the timer dies with the session, and the
// queue entry waits for the next session start.
function armResend($: EngineInterface, guard: SpendGuard, sessionId: string, text: string, atSeconds: number): void {
    void $.clock.now().then((nowMs) => {
        $.clock.after(Math.max(0, atSeconds * 1000 - nowMs), () => {
            void guard.dropResend(sessionId, text).then(() => $.prompt.submit({ text, asUser: true }));
        });
    });
}

