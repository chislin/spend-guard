// Learns the live usage the one way a plugin may: Claude Code itself answers a one-word prompt in print mode, with its own
// login, and reports the gauges it got with the reply as a rate_limit_event in its stream-json output.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { UsageSource } from '../domain/ports.ts';
import { UsageWindow, type UsageProbe, type UsageReading } from '../domain/types.ts';
import { EntryPoint } from './types.ts';
import type { RateLimitEvent, RateLimitWindow } from './usage-ping.types.ts';

// Set for the ping's own session, so spend-guard's hooks let the ping through and record nothing from it.
export const PING_ENV = 'SPEND_GUARD_PING';
export const PING_MODEL = 'haiku';
const PROMPT = 'ping';
const SYSTEM_PROMPT = 'Reply with the single word: pong';
const PING_TIMEOUT_MS = 90_000;

const WINDOW_FIELDS: Record<UsageWindow, 'five_hour' | 'seven_day'> = {
    [UsageWindow.FiveHour]: 'five_hour',
    [UsageWindow.Weekly]: 'seven_day',
};

export const NO_USAGE_IN_ANSWER = 'the ping brought no usage gauges';

export class UsagePing implements UsageSource {
    constructor(
        private readonly claudeExecutable: string,
        private readonly env: Record<string, string | undefined> = Bun.env,
        private readonly workDir: string = tmpdir(),
    ) {}

    // Runs the ping entry point in a process of its own, which outlives the hook that started it and records the answer.
    // Never from inside a ping's own session: main.ts keeps the hooks out of it, and this guards the same line twice.
    static launchInBackground(env: Record<string, string | undefined> = Bun.env): void {
        if (env[PING_ENV]) {
            return;
        }
        const child = spawn('bun', [Bun.main, EntryPoint.Ping], { env, cwd: tmpdir(), detached: true, stdio: 'ignore' });
        child.unref();
    }

    // The smallest reply Claude Code can make: the cheapest model, one turn, no tools, no servers, no project, nothing saved.
    async readUsage(): Promise<UsageProbe> {
        const args = [
            '-p', PROMPT,
            '--model', PING_MODEL,
            '--output-format', 'stream-json',
            '--verbose',
            '--max-turns', '1',
            '--tools', '',
            '--strict-mcp-config',
            '--disable-slash-commands',
            '--no-session-persistence',
            '--system-prompt', SYSTEM_PROMPT,
        ];
        try {
            const process = Bun.spawn([this.claudeExecutable, ...args], {
                cwd: this.workDir,
                env: { ...this.env, [PING_ENV]: '1' },
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const killer = setTimeout(() => process.kill(), PING_TIMEOUT_MS);
            const [stdout, stderr] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
            const exitCode = await process.exited;
            clearTimeout(killer);
            const readings = readingsIn(stdout);
            if (readings !== undefined) {
                return { readings };
            }
            return { failure: exitCode === 0 ? NO_USAGE_IN_ANSWER : `claude exited with code ${exitCode}: ${firstLine(stderr || stdout)}` };
        } catch (error) {
            return { failure: `claude could not run: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
}

// The gauges in the last rate_limit_event of the output; undefined when there is none.
function readingsIn(stdout: string): UsageReading[] | undefined {
    let readings: UsageReading[] | undefined;
    for (const line of stdout.split('\n')) {
        const event = parseEvent(line);
        if (event?.type !== 'rate_limit_event') {
            continue;
        }
        const windows = event.rate_limit_info?.unifiedWindows ?? {};
        const found: UsageReading[] = [];
        for (const window of Object.values(UsageWindow)) {
            const reading = readingFrom(window, windows[WINDOW_FIELDS[window]]);
            if (reading !== undefined) {
                found.push(reading);
            }
        }
        if (found.length > 0) {
            readings = found;
        }
    }
    return readings;
}

function parseEvent(line: string): RateLimitEvent | undefined {
    if (!line.startsWith('{')) {
        return undefined;
    }
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

// Claude Code reports the utilization as a share of the window, 0 to 1, with the same rounding its status line applies.
function readingFrom(window: UsageWindow, field: RateLimitWindow | undefined): UsageReading | undefined {
    if (!field || !Number.isFinite(field.utilization) || !Number.isFinite(field.resetsAt)) {
        return undefined;
    }
    return { window, percentUsed: Math.round(field.utilization * 1000) / 10, resetsAtSeconds: field.resetsAt };
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
