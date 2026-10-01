// Claude Code's durable scheduled prompts: <project>/.claude/scheduled_tasks.json. Claude Code watches the file and, at the first
// minute matching a one-shot task's cron fields, sends its prompt into the session that created it, then removes the task.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ResendResult, type ResendOutcome, type ResendRequest, type ScheduledTask, type ScheduledTasks } from './scheduled-tasks-file.types.ts';

const TASKS_FILE = join('.claude', 'scheduled_tasks.json');
const ID_PREFIX = 'spend-guard-';
// Resends a session may have waiting for a reset. More are refused, so one busy hour never queues an avalanche of replies.
export const RESEND_LIMIT = 3;
// Minutes between two resends of one session, so each reply reports its usage before the next prompt is checked.
export const RESEND_SPACING_MINUTES = 2;
const MINUTE = 60;

// Adds spend-guard's one-shot tasks to the file and leaves every other task as it is.
export class ScheduledTasksFile {
    constructor(
        private readonly nowSeconds: () => number = () => Date.now() / 1000,
        private readonly newId: () => string = () => ID_PREFIX + crypto.randomUUID().slice(0, 8),
    ) {}

    // Schedules the prompt for the first minute after the given time, behind the session's other pending resends.
    // The same prompt is never scheduled twice, and a session never has more than RESEND_LIMIT resends waiting.
    async scheduleResend(request: ResendRequest): Promise<ResendOutcome> {
        const now = this.nowSeconds();
        const file = join(request.projectDir, TASKS_FILE);
        const tasks = await readTasks(file);
        const pending = tasks
            .map((task) => ({ task, atSeconds: fireTimeOf(task, now) }))
            .filter(({ task, atSeconds }) => isResendOf(task, request.sessionId) && atSeconds > now);
        const same = pending.find(({ task }) => task.prompt === request.prompt);
        if (same) {
            return { result: ResendResult.AlreadyScheduled, atSeconds: same.atSeconds };
        }
        if (pending.length >= RESEND_LIMIT) {
            return { result: ResendResult.LimitReached, pending: pending.length };
        }
        const latest = Math.max(...pending.map(({ atSeconds }) => atSeconds));
        const earliest = Math.max(request.notBeforeSeconds + 1, latest + RESEND_SPACING_MINUTES * MINUTE);
        const atSeconds = Math.ceil(earliest / MINUTE) * MINUTE;
        tasks.push({
            id: this.newId(),
            cron: cronAt(atSeconds),
            prompt: request.prompt,
            createdAt: Math.round(now * 1000),
            createdBySessionId: request.sessionId,
            createdInProject: request.projectDir,
        });
        await mkdir(dirname(file), { recursive: true });
        const contents: ScheduledTasks = { tasks };
        await Bun.write(file, JSON.stringify(contents, null, 2) + '\n');
        return { result: ResendResult.Scheduled, atSeconds };
    }
}

// A missing or unreadable file is an empty list; Claude Code reads it the same way.
async function readTasks(file: string): Promise<ScheduledTask[]> {
    const handle = Bun.file(file);
    if (!(await handle.exists())) {
        return [];
    }
    try {
        const contents: unknown = await handle.json();
        const tasks = (contents as Partial<ScheduledTasks> | null)?.tasks;
        return Array.isArray(tasks) ? tasks.filter((task) => task !== null && typeof task === 'object') : [];
    } catch {
        return [];
    }
}

function isResendOf(task: ScheduledTask, sessionId: string): boolean {
    return typeof task.id === 'string' && task.id.startsWith(ID_PREFIX) && task.createdBySessionId === sessionId;
}

// Claude Code reads the cron fields in local time: minute, hour, day of month, month, any weekday.
function cronAt(seconds: number): string {
    const at = new Date(seconds * 1000);
    return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
}

// The next local time the task's cron fields name; 0 when they are not the pinned form this file writes.
function fireTimeOf(task: ScheduledTask, nowSeconds: number): number {
    const fields = typeof task.cron === 'string' ? task.cron.split(' ').map(Number) : [];
    const [minute, hour, day, month] = fields;
    if (fields.length !== 5 || ![minute, hour, day, month].every(Number.isInteger)) {
        return 0;
    }
    const now = new Date(nowSeconds * 1000);
    const thisYear = new Date(now.getFullYear(), month! - 1, day!, hour!, minute!).getTime() / 1000;
    return thisYear > nowSeconds ? thisYear : new Date(now.getFullYear() + 1, month! - 1, day!, hour!, minute!).getTime() / 1000;
}
