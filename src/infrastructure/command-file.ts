import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// A user command in <config dir>/commands/<name>.md. The plugin owns the file: written whole, removed whole.
export class CommandFile {
    constructor(private readonly path: string) {}

    exists(): Promise<boolean> {
        return Bun.file(this.path).exists();
    }

    async write(text: string): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        await Bun.write(this.path, text);
    }

    remove(): Promise<void> {
        return rm(this.path, { force: true });
    }
}
