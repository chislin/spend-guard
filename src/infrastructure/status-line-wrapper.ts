import { EntryPoint } from './types.ts';

// The wrapping command carries the user's own command in this variable, so the settings file stays the only copy of it.
const USER_COMMAND_VARIABLE = 'SPEND_GUARD_USER_STATUS_LINE';
const PREFIX = `${USER_COMMAND_VARIABLE}='`;

// Runs the stable copy. Without it (plugin uninstalled) or without Bun, the user's own command runs instead.
const SCRIPT = [
    `if [ -f "$1" ] && command -v bun >/dev/null 2>&1; then`,
    `exec bun "$1" ${EntryPoint.StatusLine};`,
    `else eval "$${USER_COMMAND_VARIABLE}"; fi`,
].join(' ');

// The status line command that runs the guard in front of the user's own command: <prefix><user command, ' escaped>'<suffix>.
// This class is the only place that knows the shape.
export class StatusLineWrapper {
    private readonly suffix: string;

    constructor(guardEntryFile: string) {
        this.suffix = ` sh -c '${SCRIPT}' sh "${guardEntryFile}"`;
    }

    wrapping(userCommand: string): string {
        const escaped = userCommand.replaceAll("'", `'\\''`);
        return `${PREFIX}${escaped}'${this.suffix}`;
    }

    isWrapping(command: string | undefined): command is string {
        return command !== undefined && command.startsWith(PREFIX) && command.endsWith(this.suffix);
    }

    // The user's command as wrapping() embedded it; undefined when there was none.
    userCommandOf(wrappingCommand: string): string | undefined {
        const closingQuote = wrappingCommand.length - this.suffix.length - 1;
        const escaped = wrappingCommand.slice(PREFIX.length, closingQuote);
        const userCommand = escaped.replaceAll(`'\\''`, "'");
        return userCommand === '' ? undefined : userCommand;
    }

    // Inside the wrapping command: runs the user's own command the way Claude Code ran it before, with the input on stdin.
    // Returns its exit code; 0 when there is no such command.
    async runUserCommand(input: string): Promise<number> {
        const userCommand = Bun.env[USER_COMMAND_VARIABLE];
        if (!userCommand) {
            return 0;
        }
        const child = Bun.spawn(['sh', '-c', userCommand], { stdin: new Blob([input]), stdout: 'inherit', stderr: 'inherit' });
        return child.exited;
    }
}
