import { describe, expect, test } from 'bun:test';
import { SpendGuard } from '../src/domain/spend-guard.ts';
import { GuardMode, UsageWindow, Verdict } from '../src/domain/types.ts';
import { MemoryGuardRepository } from './memory-guard-repository.ts';

const NOW = 1_000_000;
const WINDOW_RESET = NOW + 3600;

async function guardWithFiveHourReadings(...percents: number[]): Promise<SpendGuard> {
    const guard = new SpendGuard(new MemoryGuardRepository(), () => NOW);
    for (const percentUsed of percents) {
        await guard.recordReadings('s1', [{ window: UsageWindow.FiveHour, percentUsed, resetsAtSeconds: WINDOW_RESET }]);
    }
    return guard;
}

describe('SpendGuard', () => {
    test('lets a turn proceed while one more turn stays under the limit', async () => {
        const guard = await guardWithFiveHourReadings(50, 60);
        expect(await guard.verdictFor('s1')).toEqual({ verdict: Verdict.Proceed });
    });

    test('refuses a turn once usage plus the typical rise reaches the limit', async () => {
        const guard = await guardWithFiveHourReadings(60, 76, 92);
        expect(await guard.verdictFor('s1')).toMatchObject({
            verdict: Verdict.Refuse,
            gauge: { window: UsageWindow.FiveHour, percentUsed: 92, typicalRise: 16 },
        });
    });

    test('assumes the default rise before measured rises agree on more', async () => {
        expect((await (await guardWithFiveHourReadings(97)).verdictFor('s1')).verdict).toBe(Verdict.Proceed);
        expect((await (await guardWithFiveHourReadings(98)).verdictFor('s1')).verdict).toBe(Verdict.Refuse);
    });

    test('one large jump, such as usage from another device, does not raise the typical rise', async () => {
        const guard = await guardWithFiveHourReadings(40, 72);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Proceed);
        expect((await guard.status('s1')).gauges[0]).toMatchObject({ typicalRise: 2 });
    });

    test('tiny rises never shrink the typical rise below the default', async () => {
        const guard = await guardWithFiveHourReadings(99.3, 99.4, 99.5);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Refuse);
    });

    test('a stale reading from an idle session never lowers the gauge', async () => {
        const guard = await guardWithFiveHourReadings(60, 76, 92, 40);
        expect((await guard.status('s1')).gauges[0]).toMatchObject({ percentUsed: 92, typicalRise: 16 });
    });

    test('a newer window replaces the old one, keeps the typical rise, and is not itself a rise', async () => {
        const guard = await guardWithFiveHourReadings(60, 70, 80);
        await guard.recordReadings('s1', [{ window: UsageWindow.FiveHour, percentUsed: 95, resetsAtSeconds: WINDOW_RESET + 18000 }]);
        expect((await guard.status('s1')).gauges[0]).toMatchObject({ percentUsed: 95, typicalRise: 10 });
    });

    test('a window past its reset time counts as empty', async () => {
        const guard = new SpendGuard(new MemoryGuardRepository(), () => NOW);
        await guard.recordReadings('s1', [{ window: UsageWindow.Weekly, percentUsed: 99, resetsAtSeconds: NOW - 60 }]);
        expect(await guard.verdictFor('s1')).toEqual({ verdict: Verdict.Proceed });
        expect((await guard.status('s1')).gauges).toEqual([]);
    });

    test('a reset time that wobbles still names the same window', async () => {
        const guard = await guardWithFiveHourReadings(60, 76);
        await guard.recordReadings('s1', [{ window: UsageWindow.FiveHour, percentUsed: 92, resetsAtSeconds: WINDOW_RESET - 1 }]);
        expect((await guard.status('s1')).gauges[0]).toMatchObject({ percentUsed: 92, typicalRise: 16 });
    });

    test('a session knows when its own status line last reached the guard', async () => {
        const guard = await guardWithFiveHourReadings(50);
        expect((await guard.status('s1')).statusLineSeenAtSeconds).toBe(NOW);
        expect((await guard.status('s2')).statusLineSeenAtSeconds).toBeUndefined();
        await guard.recordReadings('s2', []);
        expect((await guard.status('s2')).statusLineSeenAtSeconds).toBe(NOW);
    });

    test('headroom is kept for one reply from each session active in the last ten minutes', async () => {
        const guard = await guardWithFiveHourReadings(60, 76, 84);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Proceed);
        await guard.recordReadings('s2', []);
        expect(await guard.verdictFor('s1')).toMatchObject({ verdict: Verdict.Refuse, activeSessions: 2 });
    });

    test('a session idle for more than ten minutes takes no headroom', async () => {
        let now = NOW;
        const guard = new SpendGuard(new MemoryGuardRepository(), () => now);
        await guard.recordReadings('s2', []);
        now += 11 * 60;
        for (const percentUsed of [60, 76, 84]) {
            await guard.recordReadings('s1', [{ window: UsageWindow.FiveHour, percentUsed, resetsAtSeconds: WINDOW_RESET }]);
        }
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Proceed);
    });

    test('turning the guard off applies to one session only', async () => {
        const guard = await guardWithFiveHourReadings(60, 76, 92);
        expect((await guard.setMode('s1', GuardMode.Off)).mode).toBe(GuardMode.Off);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Proceed);
        expect((await guard.verdictFor('s2')).verdict).toBe(Verdict.Refuse);
        await guard.setMode('s1', GuardMode.On);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Refuse);
    });

    test('turning the guard off for all sessions applies to every session, current and future', async () => {
        const guard = await guardWithFiveHourReadings(60, 76, 92);
        await guard.setMode('s1', GuardMode.On);
        const status = await guard.setModeForAll('s1', GuardMode.Off);
        expect(status.mode).toBe(GuardMode.Off);
        expect(status.allSessions).toBe(GuardMode.Off);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Proceed);
        expect((await guard.verdictFor('new')).verdict).toBe(Verdict.Proceed);
    });

    test('a session choice overrides the setting for all sessions in that session only', async () => {
        const guard = await guardWithFiveHourReadings(60, 76, 92);
        await guard.setModeForAll('s1', GuardMode.Off);
        await guard.setMode('s1', GuardMode.On);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Refuse);
        expect((await guard.verdictFor('s2')).verdict).toBe(Verdict.Proceed);
        expect((await guard.status('s2')).allSessions).toBe(GuardMode.Off);
        await guard.setModeForAll('s1', GuardMode.On);
        expect((await guard.verdictFor('s1')).verdict).toBe(Verdict.Refuse);
        expect((await guard.verdictFor('s2')).verdict).toBe(Verdict.Refuse);
    });
});
