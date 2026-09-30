import { realpath, rename } from 'node:fs/promises';
import type { ClaudeSettings } from './types.ts';

// The user's settings.json, read whole and written whole.
export class SettingsFile {
    constructor(private readonly path: string) {}

    // A missing file reads as empty settings. A malformed one throws, so the settings are never overwritten from a bad read.
    async read(): Promise<ClaudeSettings> {
        const file = Bun.file(this.path);
        if (!(await file.exists())) {
            return {};
        }
        return file.json();
    }

    // Writes a temporary file and renames it into place, so no reader ever sees half a file.
    // A symlinked path keeps its link: the target is replaced.
    async write(settings: ClaudeSettings): Promise<void> {
        const targetPath = await realpath(this.path).catch(() => this.path);
        const tempPath = `${targetPath}.${process.pid}.tmp`;
        await Bun.write(tempPath, `${JSON.stringify(settings, null, 2)}\n`);
        await rename(tempPath, targetPath);
    }
}
