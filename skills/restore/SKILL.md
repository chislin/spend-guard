---
name: restore
description: Disconnect spend-guard from the Claude Code status line and put the user's original status line command back. Use when the user invokes /spend-guard:restore.
disable-model-invocation: true
---

# spend-guard restore

Undoes `/spend-guard:setup`. Run it before uninstalling the plugin, so the settings hold the user's own status line command again and the `/spend-guard` command is gone.

1. Run:

   ```bash
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" bun "${CLAUDE_PLUGIN_ROOT}/src/main.ts" restore
   ```

2. Tell the user, in plain words:
   - What the command printed, including the status line command now in their settings.
   - spend-guard no longer sees usage, so it stops nothing until `/spend-guard:setup` runs again.
