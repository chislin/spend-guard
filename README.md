<p align="center">
  <img src="docs/logo.svg" width="96" alt="">
</p>

<h1 align="center">spend-guard</h1>

<p align="center">
  A Claude Code plugin for Pro and Max plans.<br>
  It stops your session just before a reply would bill usage credits, until you send <code>/spend-guard off</code>.
</p>

```
spend-guard: 5-hour limit at 97%. The next reply may bill usage credits.
Wait for the reset at 11:30 PM, or send /spend-guard off to bill them anyway.
```

## What you need

- A Claude Pro or Max plan. Claude Code shares the usage gauges only on those plans.
- [Bun](https://bun.sh) on your `PATH`. Claude Code does not bring it.
- `sh`: macOS, Linux, or Windows with Git Bash. PowerShell alone cannot run it. Windows is untested.

## Install

1. `claude plugin marketplace add chislin/spend-guard`
2. `claude plugin install spend-guard@spend-guard`
3. Start a new session and run `/spend-guard:setup` once. It wraps your status line command in your user settings and adds the `/spend-guard` command to `~/.claude/commands`. Your status line looks the same as before, and your original command stays readable in the settings file.
4. Start another new session and work there. spend-guard protects it from the first reply.

## Use

Every session starts guarded. These commands are answered by spend-guard before they reach Claude, so they cost nothing.

| Command | Effect |
| :- | :- |
| `/spend-guard on` | Stops this session before a reply bills usage credits. The default. |
| `/spend-guard off` | Lets this session bill usage credits |
| `/spend-guard on all` | Guards every session, current and future |
| `/spend-guard off all` | Lets every session bill usage credits, current and future |
| `/spend-guard` | Show usage and whether the guard is on |

The reply appears under "UserPromptExpansion operation blocked by hook". That is how Claude Code shows a hook answering a prompt. It is expected, and it is the only way a plugin can reply without spending a turn.

Without `all`, a command changes its own session only. With `all`, it sets every session at once and stays in force for new ones until you send the opposite. A session can still choose for itself afterwards.

## How it decides

- Claude Code sends your 5-hour and weekly usage to the status line after every reply. spend-guard records each reading.
- From the readings it learns the typical rise: how much usage grows between two readings. It takes the median of the recent rises, never below 2 points, so one odd jump, like usage from another device, does not move it.
- Before each prompt and each tool call it checks: usage plus one typical rise for every session active in the last 10 minutes. If that reaches 100%, the next reply may bill usage credits.
- Then it holds the prompt before it reaches Claude, or stops a running turn before its next tool call. The message names the limit, the reset time, and how to go on.

## What it cannot do

spend-guard lowers the chance of billing usage credits. It cannot rule it out.

- A reply that is already streaming can still cross the limit. The gauges are only as fresh as the last reply.
- Near the limit it stops slightly early and leaves the last few percent of the window unused, unless you send `/spend-guard off`.
- Claude Code also keeps weekly limits per model (Opus, Sonnet) but does not send them to the status line. spend-guard cannot see those.
- A session without a status line (`claude -p`, the Agent SDK) sends no readings. spend-guard then relies on what other sessions last reported.
- A project settings file with its own status line hides that session the same way. The `spend` prompt tells you when this session's status line has not reached spend-guard.
- Until setup runs, or after the status line was changed by hand, spend-guard sees no usage and stops nothing. Every session start and the `spend` prompt tell you so.

## When something goes wrong

- A hook that fails stops the turn and shows the cause, including Bun missing from your `PATH`. Nothing passes silently.
- A check that takes longer than 4 seconds stops the turn. Only a hook that hangs past Claude Code's own 10-second cut-off lets the turn continue.
- A damaged state file is replaced by an empty one and refills with the next reply.
- Your own status line command keeps running whatever happens inside spend-guard.
- A session left untouched for 30 days starts guarded again.

## Uninstall

1. Run `/spend-guard:restore`. It puts your original status line command back and removes the `/spend-guard` command.
2. `claude plugin uninstall spend-guard@spend-guard`

If you uninstall without restoring, your original status line still works: the wrapping command falls back to it once the plugin's files are gone. Edit `statusLine.command` in your user settings to tidy up.

## Layout

| Path | Role |
| :- | :- |
| `src/domain/` | `UsageLedger` aggregate, `SpendGuard` service, the `GuardRepository` port, and their types |
| `src/infrastructure/` | The repository in SQLite, the stable source copy, the status line wrapper, the settings file |
| `src/adapters/` | Everything that speaks Claude Code's JSON or runs its commands, and every sentence the user reads |
| `src/main.ts` | Entry point: `hook`, `statusline`, `setup`, `restore` |

Types and interfaces live in `types.ts`, `ports.ts` and `*.types.ts` next to the code that uses them.

## Development

- `bun install`
- `bun run test`: typecheck, then the test suite
