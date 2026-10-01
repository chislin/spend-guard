import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { COMMAND_NAME } from './adapters/messages.ts';
import { SpendGuard } from './domain/spend-guard.ts';
import { CommandFile } from './infrastructure/command-file.ts';
import { ScheduledTasksFile } from './infrastructure/scheduled-tasks-file.ts';
import { SettingsFile } from './infrastructure/settings-file.ts';
import { SqliteGuardRepository } from './infrastructure/sqlite-guard-repository.ts';
import { StableCopy } from './infrastructure/stable-copy.ts';
import { StatusLineWrapper } from './infrastructure/status-line-wrapper.ts';
import { PING_ENV, UsagePing } from './infrastructure/usage-ping.ts';
import { EntryPoint } from './infrastructure/types.ts';

const sourceDir = import.meta.dir;
const dataDir = StableCopy.dataDir(Bun.env.CLAUDE_PLUGIN_DATA, sourceDir);
const configDir = Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const guard = new SpendGuard(new SqliteGuardRepository(join(dataDir, 'guard.db')));
const stableCopy = new StableCopy(sourceDir, dataDir);
const wrapper = new StatusLineWrapper(stableCopy.entryFile);
const settings = new SettingsFile(join(configDir, 'settings.json'));
const commandFile = new CommandFile(join(configDir, 'commands', `${COMMAND_NAME}.md`));
const ping = new UsagePing(Bun.env.CLAUDE_CODE_EXECPATH || 'claude');
const adapter = new ClaudeCodeAdapter(guard, stableCopy, wrapper, settings, commandFile, new ScheduledTasksFile(), ping);

switch (Bun.argv[2]) {
    case EntryPoint.Hook:
        // The usage ping's own session is let through untouched, and never counted.
        if (!Bun.env[PING_ENV]) {
            await Bun.write(Bun.stdout, await adapter.runHook(await Bun.stdin.text()));
        }
        break;
    case EntryPoint.Ping:
        await adapter.runPing();
        break;
    case EntryPoint.StatusLine:
        process.exitCode = await adapter.runStatusLine(await Bun.stdin.text());
        break;
    case EntryPoint.Setup:
        console.log(await adapter.setup());
        break;
    case EntryPoint.Restore:
        console.log(await adapter.restore());
        break;
    default:
        throw new Error(`Unknown entry point: ${Bun.argv[2]}`);
}

// A check that outlasted its deadline may still be running; the answer is out, so the process ends here rather than waiting for it.
process.exit();
