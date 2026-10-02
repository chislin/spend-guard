// Where the guard keeps what it remembers between calls and across sessions: JSON values under string keys.
// The shape of Claude Code's own plugin store, so the mod hands it over as it is and tests hand over a Map.
export interface Store {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    keys(): Promise<string[]>;
}
