# spend-guard

<img src="docs/logo.svg" alt="" width="96" align="right">

Stops a Claude Code session just before a reply would bill usage credits, until you send `/spend-guard off`.

Claude Code reports how much of the 5-hour and weekly plan windows is used after every reply. spend-guard watches those gauges from every session, learns how much one reply usually costs, and refuses the next prompt or tool call when one more reply would reach 100%. A refusal says why and how to go on:

```
spend-guard: 5-hour limit at 97%, 2 sessions active. The next reply may bill usage credits.
Wait for the reset at 11:30 PM, or send /spend-guard off to bill them anyway.
```

## Install

1. `claude plugin marketplace add chislin/spend-guard`
2. `claude plugin install spend-guard@spend-guard`

Nothing else. spend-guard is a mod: it runs inside Claude Code, in the terminal, the desktop app, VS Code and `claude -p` alike. A session started after the install is guarded from its first reply.

Upgrading from 1.x: run `/spend-guard:disconnect` in a 1.x session first, or delete `~/.claude/commands/spend-guard.md` and put your own command back under `statusLine.command` in `~/.claude/settings.json`. The 2.x mod wraps nothing.

## Use

| Send | Effect |
| --- | --- |
| `/spend-guard off` | This session may bill usage credits. |
| `/spend-guard on` | This session is guarded again. |
| `/spend-guard off all`, `/spend-guard on all` | The same for every session, current and future. A session may still choose its own mode afterwards. |
| `/spend-guard resend on`, `/spend-guard resend off` | Whether a refused prompt is sent again, as your own, in the first minute after the reset, in the session that typed it if it is still open. At most three per session, two minutes apart. |
| `/spend-guard reset` | Forget the recorded usage after a reset spend-guard did not see. The next reply brings fresh gauges. |
| `/spend-guard` | The mode, the gauges, what one reply adds, and when each window resets. |

The line under the prompt shows the fullest window and its reset time, or `spend-guard off`.

## How it decides

- Each session reports its gauges after every reply. The highest reading per window wins; a reading that fell since the same session last sent it means the account's usage really dropped and replaces the record.
- The typical rise of a window is the lower median of the recent rises and a floor of 2 points, so one jump from another device never inflates it.
- Headroom is kept for one reply from every session that reported in the last ten minutes.
- A window past its reset time counts as empty.

## Limits

spend-guard lowers the chance of billing usage credits. It cannot rule it out.

- The gauges arrive after a reply, so the first reply of a fresh account window is never measured in advance.
- Claude Code also keeps weekly limits per model (Opus, Sonnet) that it does not report. spend-guard cannot see those.
- On an API key there are no plan gauges, and spend-guard stops nothing.
- A fault in spend-guard never stops your work: Claude Code skips a hook that fails and goes on. `claude --debug` names the hook and the reason.

## Uninstall

`claude plugin uninstall spend-guard@spend-guard`. Nothing is left behind but spend-guard's own store under your Claude Code configuration directory.

## Layout

| Path | Holds |
| --- | --- |
| `src/domain/` | `UsageLedger` aggregate, `SpendGuard` service, the `Store` port, and their types |
| `src/mod/` | The hooks module that speaks to Claude Code, and every sentence the user reads |
| `hooks/hooks.json` | Names the hooks module |
| `types/claude-code.d.ts` | Claude Code's declaration of the mod API, as the engine wrote it |
| `tests/` | Run by `claude plugin test .`: the domain against a store in memory, the mod against the engine |

`bun run test` typechecks, validates the manifest and runs the tests.
