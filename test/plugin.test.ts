import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { HookEvent } from '../src/adapters/claude-code.types.ts';
import type { SpendGuard } from '../src/domain/spend-guard.ts';
import type { SettingsFile } from '../src/infrastructure/settings-file.ts';
import type { CommandFile } from '../src/infrastructure/command-file.ts';
import type { StableCopy } from '../src/infrastructure/stable-copy.ts';
import type { StatusLineWrapper } from '../src/infrastructure/status-line-wrapper.ts';
import { ALL_SESSIONS, COMMAND_FILE_TEXT, COMMAND_NAME, SpendCommand } from '../src/adapters/messages.ts';
import { EntryPoint } from '../src/infrastructure/types.ts';

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');
const IN_ONE_HOUR = Math.floor(Date.now() / 1000) + 3600;

interface Sandbox {
    root: string;
    dataDir: string;
    configDir: string;
}

const sandboxRoots: string[] = [];

function sandbox(): Sandbox {
    const root = join(tmpdir(), `spend-guard-${Bun.randomUUIDv7()}`);
    sandboxRoots.push(root);
    return { root, dataDir: join(root, 'data'), configDir: join(root, 'config') };
}

afterAll(async () => {
    for (const root of sandboxRoots) {
        await rm(root, { recursive: true, force: true });
    }
});

function pluginEnv(box: Sandbox, dataDir = box.dataDir): Record<string, string | undefined> {
    return { ...Bun.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_CONFIG_DIR: box.configDir };
}

function runRaw(box: Sandbox, entryPoint: EntryPoint, stdin: string) {
    return Bun.spawnSync(['bun', MAIN, entryPoint], { stdin: Buffer.from(stdin), env: pluginEnv(box) });
}

function settingsFile(box: Sandbox): string {
    return join(box.configDir, 'settings.json');
}

function writeSettings(box: Sandbox, settings: object): Promise<number> {
    return Bun.write(settingsFile(box), JSON.stringify(settings));
}

function readSettings(box: Sandbox): Promise<any> {
    return Bun.file(settingsFile(box)).json();
}

function run(box: Sandbox, entryPoint: EntryPoint, payload?: object): string {
    const result = runRaw(box, entryPoint, JSON.stringify(payload ?? {}));
    expect(result.stderr.toString()).toBe('');
    return result.stdout.toString();
}

// Runs the status line exactly as Claude Code would: the command from the settings file, in sh, with the input on stdin.
async function runSettingsStatusLine(box: Sandbox, stdin: string, env: Record<string, string | undefined> = Bun.env) {
    const settings = await readSettings(box);
    const command: string = settings.statusLine.command;
    return Bun.spawnSync(['sh', '-c', command], { stdin: Buffer.from(stdin), env: { ...env, CLAUDE_CONFIG_DIR: box.configDir } });
}

function reportFiveHour(box: Sandbox, ...percents: number[]): void {
    for (const percentUsed of percents) {
        const rateLimits = { five_hour: { used_percentage: percentUsed, resets_at: IN_ONE_HOUR } };
        run(box, EntryPoint.StatusLine, { session_id: 's1', rate_limits: rateLimits });
    }
}

function hook(box: Sandbox, event: HookEvent, sessionId: string, prompt?: string) {
    const output = run(box, EntryPoint.Hook, { session_id: sessionId, hook_event_name: event, prompt });
    if (!output) {
        return undefined;
    }
    return JSON.parse(output);
}

// The user typed `/<name> <args>`; Claude Code asks the hook before the command expands.
function command(box: Sandbox, sessionId: string, args: string, name = COMMAND_NAME) {
    const event = { session_id: sessionId, hook_event_name: HookEvent.UserPromptExpansion, command_name: name, command_args: args };
    const output = run(box, EntryPoint.Hook, event);
    return output ? JSON.parse(output) : undefined;
}

function commandFile(box: Sandbox): string {
    return join(box.configDir, 'commands', `${COMMAND_NAME}.md`);
}

describe('plugin hooks', () => {
    test('a prompt and a tool call pass while the limit is far', () => {
        const box = sandbox();
        reportFiveHour(box, 50, 60);
        expect(hook(box, HookEvent.UserPromptSubmit, 's1', 'hello')).toBeUndefined();
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
    });

    test('near the limit a prompt is blocked and a running turn stops', () => {
        const box = sandbox();
        reportFiveHour(box, 60, 76, 92);
        const promptReply = hook(box, HookEvent.UserPromptSubmit, 's1', 'hello');
        expect(promptReply.decision).toBe('block');
        expect(promptReply.reason).toContain('5-hour limit at 92%');
        expect(promptReply.reason).toContain('Wait for the reset at');
        expect(promptReply.hookSpecificOutput).toBeUndefined();
        expect(hook(box, HookEvent.PreToolUse, 's1').continue).toBe(false);
    });

    test('the guard command switches only its own session and never expands into a prompt', () => {
        const box = sandbox();
        reportFiveHour(box, 60, 76, 92);
        const offReply = command(box, 's1', ` ${SpendCommand.Off.toUpperCase()} `);
        expect(offReply.decision).toBe('block');
        expect(offReply.reason).toContain('spend-guard: off for this session, on for the others. Replies here may bill usage credits.');
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
        expect(hook(box, HookEvent.PreToolUse, 's2').continue).toBe(false);

        expect(command(box, 's1', SpendCommand.On).reason).toContain('spend-guard: on for all sessions. Work stops before');
        expect(hook(box, HookEvent.PreToolUse, 's1').continue).toBe(false);
    });

    test('the guard command with "all" switches every session and says how to switch back', () => {
        const box = sandbox();
        reportFiveHour(box, 60, 76, 92);
        const reply = command(box, 's1', `${SpendCommand.Off} ${ALL_SESSIONS}`);
        expect(reply.reason).toContain(`spend-guard: off for all sessions. Replies may bill usage credits. Send /${COMMAND_NAME} ${SpendCommand.On} ${ALL_SESSIONS} to guard them again.`);
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
        expect(hook(box, HookEvent.PreToolUse, 's2')).toBeUndefined();

        expect(command(box, 's2', SpendCommand.On).reason).toContain('spend-guard: on for this session, off for the others. Work stops here before');
        expect(hook(box, HookEvent.PreToolUse, 's2').continue).toBe(false);
        expect(hook(box, HookEvent.PreToolUse, 's3')).toBeUndefined();

        const onReply = command(box, 's3', `${SpendCommand.On} ${ALL_SESSIONS}`);
        expect(onReply.reason).toContain('spend-guard: on for all sessions.');
        expect(hook(box, HookEvent.PreToolUse, 's1').continue).toBe(false);
        expect(command(box, 's3', `${ALL_SESSIONS} ${SpendCommand.On}`).reason).toContain(`/${COMMAND_NAME} ${SpendCommand.Off} ${ALL_SESSIONS}`);
    });

    test('other commands expand as usual and a wrong argument is explained', () => {
        const box = sandbox();
        expect(command(box, 's1', 'off', 'other')).toBeUndefined();
        expect(command(box, 's1', 'spend-guard:setup', 'other')).toBeUndefined();
        const reply = command(box, 's1', 'maybe');
        expect(reply.decision).toBe('block');
        expect(reply.reason).toContain('/spend-guard on all or /spend-guard off all for every session');
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
    });

    test('the status prompt rounds the gauges', () => {
        const box = sandbox();
        reportFiveHour(box, 91.1, 91.4);
        const reply = command(box, 's1', SpendCommand.Status);
        expect(reply.reason).toContain('5-hour: 91.4% used, a reply adds ~2%, resets ');
    });

    test('without setup, the status prompt and the session start say how to connect', () => {
        const box = sandbox();
        const reply = command(box, 's1', SpendCommand.Status);
        expect(reply.reason).toContain('spend-guard: on for all sessions');
        expect(reply.reason).toContain('Run /spend-guard:setup');
        expect(hook(box, HookEvent.SessionStart, 's1').systemMessage).toContain('Run /spend-guard:setup');
    });

    test('after setup, a window without data says when data arrives and the session start is silent', () => {
        const box = sandbox();
        run(box, EntryPoint.Setup);
        run(box, EntryPoint.StatusLine, { session_id: 's1' });
        const reply = command(box, 's1', SpendCommand.Status);
        expect(reply.reason).toContain('weekly: no data yet');
        expect(reply.reason).not.toContain('No usage from this session yet');
        expect(reply.reason).not.toContain('/spend-guard:setup');
        expect(hook(box, HookEvent.SessionStart, 's1')).toBeUndefined();
    });

    test('after setup, a session whose status line never reached the guard says so', () => {
        const box = sandbox();
        run(box, EntryPoint.Setup);
        reportFiveHour(box, 50);
        const reply = command(box, 's2', SpendCommand.Status);
        expect(reply.reason).toContain('No usage from this session yet');
        expect(reply.reason).toContain('5-hour: 50% used');
    });

    test('session start copies the source to the stable path and drops files the source no longer has', async () => {
        const box = sandbox();
        const leftover = join(box.dataDir, 'app', 'removed-by-update.ts');
        await Bun.write(leftover, '');
        hook(box, HookEvent.SessionStart, 's1');
        expect(await Bun.file(join(box.dataDir, 'app', 'main.ts')).exists()).toBe(true);
        expect(await Bun.file(leftover).exists()).toBe(false);
    });

    test('after setup, session start rewrites the command file so it follows plugin updates', async () => {
        const box = sandbox();
        run(box, EntryPoint.Setup);
        await Bun.write(commandFile(box), 'text from an older build');
        hook(box, HookEvent.SessionStart, 's1');
        expect(await Bun.file(commandFile(box)).text()).toBe(COMMAND_FILE_TEXT);
    });

    test('a session id is stored as data and never names a file', async () => {
        const box = sandbox();
        command(box, '../../escape', SpendCommand.Off);
        expect(await Bun.file(join(box.root, 'escape.json')).exists()).toBe(false);
        expect(command(box, '../../escape', SpendCommand.Status).reason).toContain('spend-guard: off for this session');
    });
});

describe('failures', () => {
    test('a damaged state file reads as no data and the next reading replaces it', async () => {
        const box = sandbox();
        await Bun.write(join(box.dataDir, 'guard.db'), '{broken');
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
        reportFiveHour(box, 99);
        expect(hook(box, HookEvent.PreToolUse, 's1').continue).toBe(false);
    });

    test('a stored record of the wrong shape is dropped and the next reading replaces it', () => {
        const box = sandbox();
        reportFiveHour(box, 50);
        const db = new Database(join(box.dataDir, 'guard.db'));
        db.run("UPDATE ledger SET percent_used = 'fifty'");
        db.close();
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
        reportFiveHour(box, 99);
        expect(hook(box, HookEvent.PreToolUse, 's1').continue).toBe(false);
    });

    test('a database from another schema version is emptied and refilled', () => {
        const box = sandbox();
        reportFiveHour(box, 99);
        const db = new Database(join(box.dataDir, 'guard.db'));
        db.run('PRAGMA user_version = 1');
        db.run('DROP TABLE rises');
        db.close();
        expect(hook(box, HookEvent.PreToolUse, 's1')).toBeUndefined();
        reportFiveHour(box, 99);
        expect(hook(box, HookEvent.PreToolUse, 's1').continue).toBe(false);
    });

    test('sessions reporting at the same time all land in the ledger', async () => {
        const box = sandbox();
        reportFiveHour(box, 50);
        const percents = [60, 70, 80, 90, 99];
        const runs = percents.map((percentUsed) => {
            const rateLimits = { five_hour: { used_percentage: percentUsed, resets_at: IN_ONE_HOUR } };
            const stdin = Buffer.from(JSON.stringify({ session_id: `s${percentUsed}`, rate_limits: rateLimits }));
            return Bun.spawn(['bun', MAIN, EntryPoint.StatusLine], { stdin, env: pluginEnv(box) }).exited;
        });
        expect(await Promise.all(runs)).toEqual(percents.map(() => 0));
        expect(command(box, 's1', SpendCommand.Status).reason).toContain('5-hour: 99% used');
        expect(hook(box, HookEvent.UserPromptSubmit, 's1', 'hello').reason).toContain(', 6 sessions active');
    });

    test('a check that outlasts the deadline stops the turn', async () => {
        const neverAnswers = { verdictFor: () => new Promise(() => {}) } as unknown as SpendGuard;
        const adapter = new ClaudeCodeAdapter(neverAnswers, {} as StableCopy, {} as StatusLineWrapper, {} as SettingsFile, {} as CommandFile, 10);
        const input = JSON.stringify({ session_id: 's1', hook_event_name: HookEvent.PreToolUse });
        const reply = JSON.parse(await adapter.runHook(input));
        expect(reply.continue).toBe(false);
        expect(reply.stopReason).toContain('took longer than');
    });

    test('an event the guard does not know stops the turn', () => {
        const box = sandbox();
        const reply = JSON.parse(runRaw(box, EntryPoint.Hook, JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' })).stdout.toString());
        expect(reply.continue).toBe(false);
    });

    test('a hook command that cannot run blocks instead of passing', async () => {
        const manifest = await Bun.file(join(import.meta.dir, '..', '.claude-plugin', 'plugin.json')).json();
        for (const event of [HookEvent.UserPromptSubmit, HookEvent.PreToolUse]) {
            const command: string = manifest.hooks[event][0].hooks[0].command;
            const result = Bun.spawnSync(['/bin/sh', '-c', command], { env: { PATH: '/nonexistent', CLAUDE_PLUGIN_ROOT: '/nonexistent' } });
            expect(result.exitCode).toBe(2);
            expect(result.stderr.toString()).toContain('spend-guard could not run its hook');
        }
    });

    test('an empty data folder name is refused instead of writing into the current folder', () => {
        const box = sandbox();
        const result = Bun.spawnSync(['bun', MAIN, EntryPoint.Setup], { env: pluginEnv(box, '') });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain('CLAUDE_PLUGIN_DATA is not set');
    });

    test('a hook that cannot check stops the turn instead of passing it', () => {
        const box = sandbox();
        const result = runRaw(box, EntryPoint.Hook, 'not json');
        const reply = JSON.parse(result.stdout.toString());
        expect(reply.continue).toBe(false);
        expect(reply.stopReason).toContain('could not check usage');
    });

    test('the user status line still runs when the input cannot be read', async () => {
        const box = sandbox();
        await writeSettings(box, { statusLine: { type: 'command', command: 'echo mine' } });
        run(box, EntryPoint.Setup);
        expect((await runSettingsStatusLine(box, '')).stdout.toString()).toBe('mine\n');
    });
});

describe('status line setup', () => {
    test('wraps the user status line once, keeps its other fields, and passes the input through', async () => {
        const box = sandbox();
        await writeSettings(box, { model: 'opus', statusLine: { type: 'command', command: 'cat | cat', padding: 0 } });

        expect(run(box, EntryPoint.Setup)).toContain('Original status line command: cat | cat');
        expect(run(box, EntryPoint.Setup)).toContain('already set up');

        const settings = await readSettings(box);
        expect(settings.model).toBe('opus');
        expect(settings.statusLine.padding).toBe(0);
        expect(settings.statusLine.command).toContain(`bun "$1" statusline`);
        expect(settings.statusLine.command).toContain(join(box.dataDir, 'app', 'main.ts'));

        const payload = { session_id: 's1', model: { display_name: 'Opus' } };
        const result = await runSettingsStatusLine(box, JSON.stringify(payload));
        expect(result.stdout.toString()).toBe(JSON.stringify(payload));
        expect(await Bun.file(join(box.dataDir, 'guard.db')).exists()).toBe(true);
    });

    test('setup adds the /spend-guard command to the user commands and restore removes it', async () => {
        const box = sandbox();
        run(box, EntryPoint.Setup);
        expect(await Bun.file(commandFile(box)).text()).toContain('$ARGUMENTS');

        run(box, EntryPoint.Restore);
        expect(await Bun.file(commandFile(box)).exists()).toBe(false);
        expect(run(box, EntryPoint.Restore)).toContain('Nothing to restore');
    });

    test("the user's command keeps a single quote and runs when the plugin data or bun is gone", async () => {
        const box = sandbox();
        await writeSettings(box, { statusLine: { type: 'command', command: "echo 'it''s mine'" } });
        run(box, EntryPoint.Setup);
        expect((await runSettingsStatusLine(box, '')).stdout.toString()).toBe('its mine\n');

        expect((await runSettingsStatusLine(box, '', { PATH: '/usr/bin:/bin' })).stdout.toString()).toBe('its mine\n');
        await rm(box.dataDir, { recursive: true, force: true });
        expect((await runSettingsStatusLine(box, '')).stdout.toString()).toBe('its mine\n');

        expect(run(box, EntryPoint.Restore)).toContain("Status line command now: echo 'it''s mine'");
    });

    test('the first command of a user pipeline receives the input', async () => {
        const pipelines: [string, string][] = [
            ['tr a-z A-Z | cat', 'HI'],
            ['input=$(cat); echo "got:$input"', 'got:hi\n'],
            ['cat && echo done', 'hidone\n'],
        ];
        for (const [command, output] of pipelines) {
            const box = sandbox();
            await writeSettings(box, { statusLine: { type: 'command', command } });
            run(box, EntryPoint.Setup);
            expect((await runSettingsStatusLine(box, 'hi')).stdout.toString()).toBe(output);
        }
    });

    test('restore puts the original command back and is safe to repeat', async () => {
        const box = sandbox();
        await writeSettings(box, { model: 'opus', statusLine: { type: 'command', command: 'cat', padding: 0 } });
        run(box, EntryPoint.Setup);

        expect(run(box, EntryPoint.Restore)).toContain('Status line command now: cat');
        expect(await readSettings(box)).toEqual({ model: 'opus', statusLine: { type: 'command', command: 'cat', padding: 0 } });
        expect(run(box, EntryPoint.Restore)).toContain('Nothing to restore');
    });

    test('restore removes the status line when there was none before setup', async () => {
        const box = sandbox();
        run(box, EntryPoint.Setup);
        expect(run(box, EntryPoint.Restore)).toContain('Status line command now: (none)');
        expect(await readSettings(box)).toEqual({});
    });

    test('setup writes through a symlinked settings file and keeps the link', async () => {
        const box = sandbox();
        const realFile = join(box.root, 'dotfiles', 'settings.json');
        const linkFile = settingsFile(box);
        await Bun.write(realFile, JSON.stringify({ statusLine: { type: 'command', command: 'cat' } }));
        await mkdir(box.configDir, { recursive: true });
        await symlink(realFile, linkFile);

        run(box, EntryPoint.Setup);
        expect((await lstat(linkFile)).isSymbolicLink()).toBe(true);
        expect((await Bun.file(realFile).json()).statusLine.command).toContain('statusline');
    });
});
