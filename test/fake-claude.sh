#!/bin/sh
# Stands in for the claude binary in tests: logs the call and the ping marker, prints the prepared output, exits as told.
printf '%s %s\n' "$*" "SPEND_GUARD_PING=${SPEND_GUARD_PING:-unset}" >> "$FAKE_CLAUDE_LOG"
printf '%s' "$FAKE_CLAUDE_OUTPUT"
exit "${FAKE_CLAUDE_EXIT:-0}"
