---
name: setup
description: Connect spend-guard to the Claude Code status line so it can read the plan usage gauges. Use when the user invokes /spend-guard:setup.
disable-model-invocation: true
---

# spend-guard setup

Claude Code sends the 5-hour and weekly usage gauges only to the status line, and a plugin cannot set the status line or add a bare `/spend-guard` command. This one-time step wraps the user's status line command so spend-guard receives the gauges, and adds `/spend-guard` to the user's commands.

1. Run:

   ```bash
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" bun "${CLAUDE_PLUGIN_ROOT}/src/main.ts" setup
   ```

2. Tell the user, in plain words:
   - What the command printed, including their original status line command.
   - Their status line looks the same as before. spend-guard only reads the gauges and passes the input on to their command.
   - Start a new session now and work there. spend-guard protects it from the first reply.
   - `/spend-guard on`, `/spend-guard off`, the same with `all` for every session, and `/spend-guard` are answered by spend-guard and never reach Claude.
   - spend-guard lowers the chance of billing usage credits. It cannot rule it out.
   - To undo, run `/spend-guard:restore`.
