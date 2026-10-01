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
| `/spend-guard resend on` | Sends a blocked prompt again after the reset, in every session. Off by default. |
| `/spend-guard resend off` | Leaves a blocked prompt in the input box for you to send |
| `/spend-guard check` | Learns the live usage now, with a one-word Haiku reply |
| `/spend-guard reset` | Forgets the recorded usage after a reset spend-guard did not see. Work goes on, and the next reply refills the gauges. |
| `/spend-guard` | Show usage, whether the guard is on, and whether blocked prompts are sent again |

The reply appears under "UserPromptExpansion operation blocked by hook", followed by the same text as a system message. That is how Claude Code shows a hook answering a prompt. It is expected, and it is the only way a plugin can reply without spending a turn. A device connected through Remote Control receives only the system message, so there every reply and every stop shows up as one line.

Without `all`, a command changes its own session only. With `all`, it sets every session at once and stays in force for new ones until you send the opposite. A session can still choose for itself afterwards. `resend` is one setting for every session.

## Sending blocked prompts again

A blocked prompt stays in the input box in the terminal, but a device connected through Remote Control loses it. With `/spend-guard resend on`, spend-guard hands the prompt to Claude Code's own scheduler instead: it writes a one-shot task to `.claude/scheduled_tasks.json` in the project folder, the same file `/schedule` uses, and Claude Code sends the prompt into the same session in the first minute after the reset. The block message names the time.

- A prompt already waiting for the reset is not scheduled twice. Sending it again only repeats the time.
- Resends of one session are two minutes apart, so each reply reports its usage before the next prompt is checked. A resent prompt goes through the guard like any other and is blocked again if the limit is still near.
- A session has at most 3 prompts waiting. Further ones are refused with a note, and you send them yourself after the reset.
- The session has to be open at that time. Claude Code only lists a task whose session has ended as missed.
- The prompt text sits in that file in plain text until it is sent. The file belongs to Claude Code and may be shared with your project.

## How it decides

- Claude Code sends your 5-hour and weekly usage to the status line after every reply. spend-guard records each reading.
- From the readings it learns the typical rise: how much usage grows between two readings. It takes the median of the recent rises, never below 2 points, so one odd jump, like usage from another device, does not move it.
- Before each prompt and each tool call it checks: usage plus one typical rise for every session active in the last 10 minutes. If that reaches 100%, the next reply may bill usage credits.
- Then it holds the prompt before it reaches Claude, or stops a running turn before its next tool call. The message names the limit, the reset time, and how to go on.
- A lower reading in the same window is ignored, because idle sessions keep re-sending old gauges. The exception is a session whose own gauge fell since it last reported: only a real drop does that, so it replaces the recorded usage.
- When it refuses, it also starts a usage check, at most once in 5 minutes: Claude Code answers the word "ping" with Haiku in print mode, one turn, no tools, and reports the live gauges with that reply. The answer replaces the recorded usage, so a reset the sessions had not heard of lifts the block when you send the prompt again a few seconds later. The reply costs a little usage; at the limit it is refused and costs nothing.

## When the limit reset but spend-guard still stops

Claude Code learns the gauges from each reply. A session that spend-guard keeps stopping sends no request, so on its own it never hears of a reset that comes before the time it recorded, and its block message says so. The usage check above covers most of this, and `/spend-guard check` runs it at once. When the check cannot run, the `/spend-guard` status says why. Then run `/usage` yourself, and if the limit has reset, send `/spend-guard reset`: the recorded usage is forgotten, the next prompt goes through, and its reply brings fresh gauges. If the limit had not reset after all, that one reply may bill usage credits.

The check runs the `claude` command found in `CLAUDE_CODE_EXECPATH` or on your `PATH`, in a temporary folder, with no tools, no MCP servers, no slash commands, and nothing saved to disk. It signs in as you, the same way any `claude -p` run does, and spend-guard never touches your login token. Hooks from your own settings still run in that session; spend-guard's own stand aside.

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
- A prompt that cannot be scheduled, for example when the tasks file cannot be written, is still blocked. The message says so, and you send it yourself after the reset.

## Uninstall

1. Run `/spend-guard:restore`. It puts your original status line command back and removes the `/spend-guard` command. The guard never stops its own setup or restore, whatever the usage.
2. `claude plugin uninstall spend-guard@spend-guard`

To stop the hooks without a Claude session, run `claude plugin disable spend-guard` in a terminal and restart your sessions.

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
