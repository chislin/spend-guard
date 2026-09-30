// How main.ts is invoked: `bun main.ts <entry point>`. plugin.json and the wrapped status line command spell these out.
export enum EntryPoint {
    Hook = 'hook',
    StatusLine = 'statusline',
    Setup = 'setup',
    Restore = 'restore',
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
