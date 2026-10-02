// Runs under `claude plugin test`: the engine's own `$`, the mod loaded as a session loads it, store and clock in memory.
import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';

const CONTEXT = { window: 200_000 };
const IN_ONE_HOUR = new Date(Date.now() + 3600_000).toISOString();

function fiveHour(percentUsed: number) {
    return { kind: 'five_hour', percentUsed, resetsAt: IN_ONE_HOUR };
}

async function run($: Engine, args: string) {
    const presentation = { isFullscreen: false, columns: 120 };
    return (await $.command.run({ command: 'spend-guard', args, origin: { kind: 'composer' }, presentation })).text ?? '';
}

async function report($: Engine, ...percents: number[]) {
    for (const percentUsed of percents) {
        await $.session.measure({ context: CONTEXT, rateLimits: [fiveHour(percentUsed)], changed: ['rateLimits'] });
    }
}

// The engine beneath the mod: a session with an id and no gauges of its own, a store and a clock in memory, and the
// engine's own answers to a prompt, a tool call and a measurement, which here are the plain echoes core gives.
// `resent` collects every prompt that reaches the engine, as `origin:text`.
function world(on: On, resent: string[] = []) {
    mock.store(on);
    on('session.id', async () => ({ value: 'test-session' }));
    on('session.usage', async () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }));
    on('session.measure', async (_, e) => ({ changed: e.changed }));
    on('command.register', async (_, e) => ({ value: { command: e.name } }));
    on('ui.status', async () => ({ value: undefined }));
    on('prompt.submit', async (_, e) => {
        resent.push(`${e.origin.kind}:${e.text}`);
        return { text: e.text };
    });
    on('tool.call', async () => ({ result: { type: 'text', file: { filePath: '/tmp/x', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as never);
    return mock.clock(on, { now: Date.now() });
}

test('a tool call and a prompt pass while one more reply stays under the limit', async ($, on) => {
    world(on);
    await report($, 50, 60);
    const call = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' });
    expect(call.deny).toBeUndefined();
    const prompt = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false });
    expect(prompt.drop).toBeUndefined();
});

test('a tool call and a prompt are refused once usage plus the typical rise reaches the limit', async ($, on) => {
    world(on);
    await report($, 60, 76, 92);
    const call = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' });
    expect(call.deny).toContain('5-hour limit at 92%');
    const prompt = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false });
    expect(prompt.drop).toContain('5-hour limit at 92%');
    expect(prompt.drop).toContain('/spend-guard resend on');
});

test('/spend-guard off lets work through, and a slash command is never refused', async ($, on) => {
    world(on);
    await report($, 60, 76, 92);
    const prompt = await $.prompt.submit({ text: '/spend-guard off', origin: { kind: 'composer' }, wait: false });
    expect(prompt.drop).toBeUndefined();
    expect(await run($, 'off')).toContain('spend-guard: off for this session');
    const call = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' });
    expect(call.deny).toBeUndefined();
    expect((await run($, 'on'))).toContain('spend-guard: on for all sessions');
    expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })).deny).toContain('5-hour limit');
});

test('the status answers with the gauges, and an unknown argument with the usage', async ($, on) => {
    world(on);
    await report($, 60, 76, 92);
    const status = await run($, '');
    expect(status).toContain('5-hour: 92% used, a reply adds ~16%');
    expect(status).toContain('weekly: no data yet');
    expect((await run($, 'maybe'))).toContain('send /spend-guard on or /spend-guard off');
});

test('with resend on, a refused prompt is sent again as the user once the window has reset', async ($, on) => {
    const resent: string[] = [];
    const clock = world(on, resent);
    await report($, 60, 76, 92);
    expect((await run($, 'resend on'))).toContain('Blocked prompts are sent again');
    const refused = await $.prompt.submit({ text: 'hello again', origin: { kind: 'composer' }, wait: false });
    expect(refused.drop).toContain('scheduled to be sent again at');
    await clock.advance(3600_000 + 120_000);
    expect(resent).toEqual(['plugin:hello again']);
});

test('reset forgets the usage until the next measurement', async ($, on) => {
    world(on);
    await report($, 60, 76, 92);
    expect((await run($, 'reset'))).toContain('spend-guard forgot the recorded usage');
    expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })).deny).toBeUndefined();
    await report($, 99);
    expect((await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })).deny).toContain('5-hour limit at 99%');
});
