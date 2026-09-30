import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const ENTRY_FILE = 'main.ts';
const SOURCE_FILES = new Bun.Glob('**/*.ts');
const FOLDER = 'app';

// A copy of the plugin's source at a path that survives plugin updates, so the status line command in the user's settings never goes stale.
export class StableCopy {
    constructor(
        private readonly sourceDir: string,
        private readonly dataDir: string,
    ) {}

    // Claude Code names the data folder for hooks and skills. The status line runs the copy without that name,
    // and the copy's own location gives the folder.
    static dataDir(namedDataDir: string | undefined, sourceDir: string): string {
        if (namedDataDir) {
            return namedDataDir;
        }
        if (basename(sourceDir) === FOLDER) {
            return dirname(sourceDir);
        }
        throw new Error('CLAUDE_PLUGIN_DATA is not set, so spend-guard does not know where its data folder is.');
    }

    get entryFile(): string {
        return join(this.folder(), ENTRY_FILE);
    }

    // Runs at every session start, so the copy follows plugin updates, including files an update removed.
    // Only changed files are written, each by an atomic rename: a status line running meanwhile never reads half a file.
    async refresh(): Promise<void> {
        const sourcePaths = new Set(await Array.fromAsync(SOURCE_FILES.scan(this.sourceDir)));
        for (const relativePath of sourcePaths) {
            const source = await Bun.file(join(this.sourceDir, relativePath)).text();
            const copyPath = join(this.folder(), relativePath);
            const copy = Bun.file(copyPath);
            const unchanged = (await copy.exists()) && (await copy.text()) === source;
            if (!unchanged) {
                const tempPath = `${copyPath}.${process.pid}.tmp`;
                await Bun.write(tempPath, source);
                await rename(tempPath, copyPath);
            }
        }
        for await (const relativePath of SOURCE_FILES.scan(this.folder())) {
            if (!sourcePaths.has(relativePath)) {
                await rm(join(this.folder(), relativePath), { force: true });
            }
        }
    }

    private folder(): string {
        return join(this.dataDir, FOLDER);
    }
}
