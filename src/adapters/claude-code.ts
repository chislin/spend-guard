// The only module that knows Claude Code's hook and status line JSON, and what its setup and restore commands do.
import { GuardMode, UsageWindow, Verdict, type GuardStatus, type RefusedTurn, type UsageReading } from '../domain/types.ts';
import type { SpendGuard } from '../domain/spend-guard.ts';
import type { CommandFile } from '../infrastructure/command-file.ts';
import type { ScheduledTasksFile } from '../infrastructure/scheduled-tasks-file.ts';
import { UsagePing } from '../infrastructure/usage-ping.ts';
import type { SettingsFile } from '../infrastructure/settings-file.ts';
import type { StableCopy } from '../infrastructure/stable-copy.ts';
import type { StatusLineWrapper } from '../infrastructure/status-line-wrapper.ts';
import {
    HookEvent,
    type HookAnswer,
    type HookInput,
    type Notice,
    type PromptBlock,
    type RateLimitKey,
    type StatusLineInput,
    type TurnStop,
} from './claude-code.types.ts';
import {
    ALL_SESSIONS,
    alreadySetUp,
    COMMAND_FILE_TEXT,
    COMMAND_NAME,
    commandUsage,
    couldNotCheck,
    couldNotSchedule,
    couldNotStart,
    describeStatus,
    NOT_CONNECTED,
    nothingToRestore,
    PROBE_STARTED,
    probeLine,
    refusal,
    RESEND_HINT,
    resendOutcome,
    restoreDone,
    setupDone,
    SpendCommand,
    USAGE_FORGOTTEN,
} from './messages.ts';

const PASS: HookAnswer = '';

const RATE_LIMIT_KEYS: Record<UsageWindow, RateLimitKey> = {
    [UsageWindow.FiveHour]: 'five_hour',
    [UsageWindow.Weekly]: 'seven_day',
};

// Claude Code cuts a hook off at the timeout in plugin.json and lets the turn go on; the guard answers before that.
const HOOK_DEADLINE_MS = 4000;

// Answers Claude Code for one plugin run: a hook, a status line refresh, or the setup and restore commands.
export class ClaudeCodeAdapter {
    constructor(
        private readonly guard: SpendGuard,
        private readonly stableCopy: StableCopy,
        private readonly wrapper: StatusLineWrapper,
        private readonly settings: SettingsFile,
        private readonly commandFile: CommandFile,
        private readonly scheduledTasks: ScheduledTasksFile,
        private readonly ping: UsagePing,
        private readonly deadlineMs = HOOK_DEADLINE_MS,
    ) {}

    // A guard that cannot check stops the turn: any failure, and a check that outlasts the deadline, becomes a stop, never a silent pass.
    async runHook(input: string): Promise<HookAnswer> {
        try {
            return await Promise.race([this.answerHook(input), failAfter(this.deadlineMs)]);
        } catch (error) {
            return stopTurn(couldNotCheck(causeOf(error)));
        }
    }

    // Records the gauges, then runs the user's own status line command on the same input; returns its exit code.
    async runStatusLine(input: string): Promise<number> {
        try {
            const status: StatusLineInput = JSON.parse(input);
            await this.guard.recordReadings(status.session_id, readingsFrom(status));
        } catch (error) {
            // The user's status line must survive a reading the guard cannot record.
            console.error(`spend-guard: ${causeOf(error)}`);
        }
        return this.wrapper.runUserCommand(input);
    }

    // Runs the usage ping to its end and records what it gave; the hook that started it has long answered.
    async runPing(): Promise<void> {
        await this.guard.recordProbe(await this.ping.readUsage());
    }

    // Wraps the user's status line command so the guard receives the gauges, and adds the /spend-guard user command.
    // Safe to repeat. Returns what to tell the user.
    async setup(): Promise<string> {
        await this.stableCopy.refresh();
        const settings = await this.settings.read();
        const currentCommand = settings.statusLine?.command;
        if (this.wrapper.isWrapping(currentCommand) && (await this.commandFile.exists())) {
            return alreadySetUp(this.wrapper.userCommandOf(currentCommand));
        }
        await this.commandFile.write(COMMAND_FILE_TEXT);
        if (this.wrapper.isWrapping(currentCommand)) {
            return setupDone(this.wrapper.userCommandOf(currentCommand));
        }
        const command = this.wrapper.wrapping(currentCommand ?? '');
        settings.statusLine = { ...settings.statusLine, type: 'command', command };
        await this.settings.write(settings);
        return setupDone(currentCommand);
    }

    // Undoes setup. A status line the user changed after setup is left as it is. Returns what to tell the user.
    async restore(): Promise<string> {
        const hadCommand = await this.commandFile.exists();
        await this.commandFile.remove();
        const settings = await this.settings.read();
        const currentCommand = settings.statusLine?.command;
        if (!this.wrapper.isWrapping(currentCommand)) {
            return hadCommand ? restoreDone(currentCommand) : nothingToRestore(currentCommand);
        }
        const userCommand = this.wrapper.userCommandOf(currentCommand);
        if (userCommand === undefined) {
            delete settings.statusLine;
        } else {
            settings.statusLine = { ...settings.statusLine, type: 'command', command: userCommand };
        }
        await this.settings.write(settings);
        return restoreDone(userCommand);
    }

    private async answerHook(input: string): Promise<HookAnswer> {
        const event: HookInput = JSON.parse(input);
        if (typeof event.session_id !== 'string') {
            throw new Error('the hook input names no session');
        }
        switch (event.hook_event_name) {
            case HookEvent.SessionStart:
                return this.startSession();
            case HookEvent.UserPromptSubmit:
                return this.answerPrompt(event);
            case HookEvent.UserPromptExpansion:
                return this.answerCommand(event.session_id, event.command_name, event.command_args ?? '');
            case HookEvent.PreToolUse:
                return runsOwnCommand(event) ? PASS : this.checkToolCall(event.session_id);
            default:
                throw new Error(`unknown hook event ${event.hook_event_name}`);
        }
    }

    // A session start never stops; a problem here is shown to the user as a notice.
    private async startSession(): Promise<HookAnswer> {
        try {
            await this.stableCopy.refresh();
            if (await this.connected()) {
                // The command file follows plugin updates too, so setup never has to run twice.
                await this.commandFile.write(COMMAND_FILE_TEXT);
                return PASS;
            }
            return notice(NOT_CONNECTED);
        } catch (error) {
            return notice(couldNotStart(causeOf(error)));
        }
    }

    // A prompt is let through or refused; a refused one stays in the input box, and is scheduled to be sent again when asked.
    private async answerPrompt(event: HookInput): Promise<HookAnswer> {
        const turn = await this.guard.verdictFor(event.session_id);
        if (turn.verdict === Verdict.Proceed) {
            return PASS;
        }
        const lines = [refusal(turn), await this.probeLineForRefusal(), await this.resendLine(turn, event)];
        return blockPrompt(lines.filter((line) => line !== '').join('\n'));
    }

    // A refusal rests on gauges the stopped sessions cannot refresh, so it starts a usage ping when one is due,
    // and says what the last one gave otherwise.
    private async probeLineForRefusal(): Promise<string> {
        if (await this.guard.claimProbe()) {
            UsagePing.launchInBackground();
            return PROBE_STARTED;
        }
        return probeLine((await this.guard.status('')).lastProbe, this.guard.nowSeconds());
    }

    // Schedules the refused prompt for after the reset, and says what became of it. A prompt with no words is let go.
    private async resendLine(turn: RefusedTurn, event: HookInput): Promise<string> {
        if (!turn.resendBlocked) {
            return RESEND_HINT;
        }
        const prompt = event.prompt?.trim() ?? '';
        if (prompt === '') {
            return '';
        }
        if (event.cwd === undefined) {
            return couldNotSchedule('the hook input names no project folder');
        }
        try {
            const request = { projectDir: event.cwd, sessionId: event.session_id, prompt, notBeforeSeconds: turn.gauge.resetsAtSeconds };
            return resendOutcome(await this.scheduledTasks.scheduleResend(request), turn.gauge.window);
        } catch (error) {
            return couldNotSchedule(causeOf(error));
        }
    }

    // The /spend-guard command is answered here and never expands; every other command is left alone.
    private async answerCommand(sessionId: string, name: string | undefined, argument: string): Promise<HookAnswer> {
        if (name !== COMMAND_NAME) {
            return PASS;
        }
        const words = argument.trim().toLowerCase().split(/\s+/);
        const status = await this.spendCommandOutcome(sessionId, words);
        if (status === undefined) {
            return blockPrompt(commandUsage());
        }
        const preface = [];
        if (words[0] === SpendCommand.Reset) {
            preface.push(USAGE_FORGOTTEN);
        }
        if (words[0] === SpendCommand.Check) {
            preface.push(await this.startCheck());
        }
        return blockPrompt([...preface, describeStatus(status, await this.connected())].join('\n'));
    }

    // The check command starts a ping now, unless one is already running.
    private async startCheck(): Promise<string> {
        if (await this.guard.claimProbe(true)) {
            UsagePing.launchInBackground();
            return PROBE_STARTED;
        }
        return probeLine((await this.guard.status('')).lastProbe, this.guard.nowSeconds());
    }

    // The state the command leaves the session in; undefined when the words are not one of the command's forms.
    private async spendCommandOutcome(sessionId: string, words: string[]): Promise<GuardStatus | undefined> {
        const [first = SpendCommand.Status, scope, ...rest] = words;
        if (first === SpendCommand.Status && scope === undefined) {
            return this.guard.status(sessionId);
        }
        if (rest.length > 0) {
            return undefined;
        }
        if (first === SpendCommand.Reset || first === SpendCommand.Check) {
            if (scope !== undefined) {
                return undefined;
            }
            return first === SpendCommand.Reset ? this.guard.forgetUsage(sessionId) : this.guard.status(sessionId);
        }
        if (first === SpendCommand.Resend) {
            const resendMode = COMMAND_MODES[scope ?? ''];
            return resendMode === undefined ? undefined : this.guard.setResendBlocked(sessionId, resendMode === GuardMode.On);
        }
        const mode = COMMAND_MODES[first];
        if (mode === undefined) {
            return undefined;
        }
        if (scope === undefined) {
            return this.guard.setMode(sessionId, mode);
        }
        return scope === ALL_SESSIONS ? this.guard.setModeForAll(sessionId, mode) : undefined;
    }

    // False means the user's settings do not run the guard's status line, so no session sends it usage gauges.
    private async connected(): Promise<boolean> {
        const settings = await this.settings.read();
        return this.wrapper.isWrapping(settings.statusLine?.command);
    }

    private async checkToolCall(sessionId: string): Promise<HookAnswer> {
        const turn = await this.guard.verdictFor(sessionId);
        if (turn.verdict === Verdict.Proceed) {
            return PASS;
        }
        return stopTurn([refusal(turn), await this.probeLineForRefusal()].filter((line) => line !== '').join('\n'));
    }
}

// The plugin's own connect and disconnect run through a Bash tool call, and must never be stopped by the guard itself:
// a user at the limit still has to be able to take the plugin out.
const OWN_COMMAND = /main\.ts["']?\s+(setup|restore)\b/;

function runsOwnCommand(event: HookInput): boolean {
    return event.tool_name === 'Bash' && typeof event.tool_input?.command === 'string' && OWN_COMMAND.test(event.tool_input.command);
}

const COMMAND_MODES: Record<string, GuardMode | undefined> = {
    [SpendCommand.On]: GuardMode.On,
    [SpendCommand.Off]: GuardMode.Off,
};

function readingsFrom(status: StatusLineInput): UsageReading[] {
    const readings: UsageReading[] = [];
    for (const window of Object.values(UsageWindow)) {
        const rateLimit = status.rate_limits?.[RATE_LIMIT_KEYS[window]];
        if (rateLimit && Number.isFinite(rateLimit.used_percentage) && Number.isFinite(rateLimit.resets_at)) {
            readings.push({ window, percentUsed: rateLimit.used_percentage, resetsAtSeconds: rateLimit.resets_at });
        }
    }
    return readings;
}

// The reason is repeated as a system message so a Remote Control device sees why nothing was answered.
function blockPrompt(reason: string): HookAnswer {
    const block: PromptBlock = { decision: 'block', reason, systemMessage: reason };
    return JSON.stringify(block);
}

function stopTurn(stopReason: string): HookAnswer {
    const stop: TurnStop = { continue: false, stopReason, systemMessage: stopReason };
    return JSON.stringify(stop);
}

function notice(systemMessage: string): HookAnswer {
    const message: Notice = { systemMessage };
    return JSON.stringify(message);
}

function failAfter(deadlineMs: number): Promise<never> {
    return new Promise((_, reject) => {
        const fail = () => reject(new Error(`the check took longer than ${deadlineMs / 1000} seconds`));
        setTimeout(fail, deadlineMs).unref();
    });
}

function causeOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
