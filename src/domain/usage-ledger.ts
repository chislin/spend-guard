import { UsageWindow, type LedgerRecord, type UsageReading, type WindowGauge } from './types.ts';

// Percentage points a reply is assumed to cost at least; also the estimate until measured rises agree on more.
const DEFAULT_RISE = 2;
const RISES_KEPT = 4;
// Reset times this close name the same window, so a reset time that wobbles never hides a higher reading.
const RESET_JITTER_SECONDS = 60;

// The account's plan usage per window, as the latest readings from any session show it.
export class UsageLedger {
    private constructor(private readonly records: Map<UsageWindow, LedgerRecord>) {}

    static restore(records: readonly LedgerRecord[]): UsageLedger {
        return new UsageLedger(new Map(records.map((record) => [record.window, record])));
    }

    snapshot(): readonly LedgerRecord[] {
        return [...this.records.values()];
    }

    // A reading older than the stored one never lowers it: idle sessions keep re-sending stale gauges.
    record(reading: UsageReading): void {
        const stored = this.records.get(reading.window);
        if (!stored) {
            this.records.set(reading.window, { ...reading, recentRises: [] });
            return;
        }
        const sameWindow = Math.abs(reading.resetsAtSeconds - stored.resetsAtSeconds) <= RESET_JITTER_SECONDS;
        if (!sameWindow) {
            if (reading.resetsAtSeconds > stored.resetsAtSeconds) {
                this.records.set(reading.window, { ...reading, recentRises: stored.recentRises });
            }
            return;
        }
        if (reading.percentUsed <= stored.percentUsed) {
            return;
        }
        const rise = reading.percentUsed - stored.percentUsed;
        const recentRises = [...stored.recentRises, rise].slice(-RISES_KEPT);
        this.records.set(reading.window, { ...reading, recentRises });
    }

    // A window past its reset time is left out.
    liveGauges(nowSeconds: number): WindowGauge[] {
        return [...this.records.values()]
            .filter((record) => record.resetsAtSeconds > nowSeconds)
            .map(({ recentRises, ...reading }) => ({ ...reading, typicalRise: typicalRise(recentRises) }));
    }

    // The first live window where the given number of typical rises reaches 100%.
    windowAboutToBill(nowSeconds: number, pendingReplies: number): WindowGauge | undefined {
        return this.liveGauges(nowSeconds).find((gauge) => gauge.percentUsed + gauge.typicalRise * pendingReplies >= 100);
    }
}

// The lower median of the default and the recent rises, so one outlier (usage from another device, a tiny step) never moves it.
function typicalRise(recentRises: readonly number[]): number {
    const samples = [DEFAULT_RISE, ...recentRises].sort((a, b) => a - b);
    const lowerMedianIndex = Math.floor((samples.length - 1) / 2);
    const median = samples[lowerMedianIndex] ?? DEFAULT_RISE;
    return Math.max(DEFAULT_RISE, median);
}
