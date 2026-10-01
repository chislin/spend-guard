// How main.ts is invoked: `bun main.ts <entry point>`. plugin.json and the wrapped status line command spell these out.
export enum EntryPoint {
    Hook = 'hook',
    StatusLine = 'statusline',
    Connect = 'connect',
    Disconnect = 'disconnect',
    // Runs the usage ping and records its answer; started in the background by a hook or the check command.
    Ping = 'ping',
}

// The parts of the user's settings.json the plugin touches. Everything else is kept as it is.
export interface ClaudeSettings {
    statusLine?: StatusLineSetting;
    [otherKey: string]: unknown;
}

export interface StatusLineSetting {
    type: 'command';
    command: string;
    [otherField: string]: unknown;
}
