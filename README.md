# Prompt Queue for Claude Code

Queue up your next prompts while Claude is still working. Run them later, by hand or automatically one by one.

Claude Code's own queue sends your message into the running task. This mod holds prompts back until you want them.

This is a fork of [kuzmany/claude-code-prompt-queue](https://github.com/kuzmany/claude-code-prompt-queue) with these changes:

- **Auto is on by default.** `/queue <text>` runs as soon as the session is idle, with no toggle to remember each session.
- **Slash commands can be queued.** `/queue /review-pr 123` runs the command as if you typed it, and a leading `/` is enough to tell it apart from a prompt.
- **Settings.** Auto's starting state and whether the toggle is saved for later sessions live in `/config`; subcommands can be aliased, `/queue-auto` among them.
- **`/queue status`.** Print the queue state without opening the panel.

It also keeps a prompt that could not be sent instead of dropping it, and stops auto with a toast so the queue does not silently lose it; a command that cannot run is dropped with a toast so the entries behind it still go.

## Install

At the Claude Code prompt:

```
/plugin marketplace add qurakchin/claude-code-prompt-queue
/plugin install prompt-queue@qurakchin-prompt-queue
```

Type `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin marketplace add qurakchin/claude-code-prompt-queue
claude plugin install prompt-queue@qurakchin-prompt-queue
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `qurakchin/claude-code-prompt-queue`, then **Add plugin**.

If you already installed the upstream plugin as `prompt-queue@prompt-queue`, remove it first:

```
/plugin uninstall prompt-queue@prompt-queue
/plugin marketplace remove prompt-queue
```

## Uninstall

```
/plugin uninstall prompt-queue@qurakchin-prompt-queue
/plugin marketplace remove qurakchin-prompt-queue
```

## Use

| Command | What it does |
| --- | --- |
| `/queue` | Open the queue panel: edit, move up or down, run (▶) or remove (✕) each entry, and add new ones. |
| `/queue <text>` | Park a prompt. Works while Claude is busy. |
| `/queue /name [args]` | Park a slash command to run as if you typed it. |
| `/queue list` | Show parked entries. |
| `/queue status` | Print the queue state without opening the panel. |
| `/queue run [n]` | Send entry n now (default 1). |
| `/queue drop <n>` | Remove entry n. |
| `/queue clear` | Remove all entries. |
| `/queue auto` | Toggle auto mode. With the default setting the choice is saved for later sessions. |
| `/queue unblock` | Stop waiting on background jobs. |

**Auto mode is on by default.** The next entry starts only after the current task ends **and** every background job or agent it started has finished. Then the next, until the queue is empty. No setup per session: park and go.

`/queue auto` turns it off; whether that choice lasts past the session is up to the **Auto mode** setting. Pressing Esc during a task turns it off too, when something is still parked.

`/queue status` prints the same state the panel shows, in one line plus the entries, and exits — no panel, no buttons:

```
2 queued · auto off (session)
1. fix the failing tests
2. /review-pr 123
```

A parked slash command runs through `$.command.run`, so it reaches the same command, arguments and hooks as typing it. The next entry waits until that command's turn has started, or a short while if it starts none.

Text that starts with `/` but names no command (`/Users/me/x.md look at this`) is refused when you queue it: a prompt cannot start with `/`, and no such command exists.

If a prompt cannot be sent, it stays in the queue: auto entries return to the front and auto turns off with a toast; a manual run puts it back where it was. `/queue auto` resumes. A slash command that cannot run (an unknown name, a command that fails) is removed with a toast instead, so it does not block the entries behind it.

A dim line above the prompt shows the state, for example `3 queued: /review-pr 12 · auto · waiting on 1 bg`. Other mods can add to the same row.

`/queue help` lists the commands.

The queue belongs to the current session.

If auto keeps waiting on a job that already ended (for example one a subagent started), run `/queue unblock`.

## Settings

The plugin's fields are rows in `/config`, under **Auto mode** and **Subcommand aliases**.

**Auto mode** sets auto's starting state and where `/queue auto` saves the toggle:

| Value | Starts | `/queue auto` writes the setting |
| --- | --- | --- |
| `global-true` (default) | on | yes |
| `global-false` | off | yes |
| `session-true` | on | no, this session only |
| `session-false` | off | no, this session only |

The setting is read once when a session starts; a reload keeps the value you toggled in that session, and a new session reads the setting again.

**Subcommand aliases** adds other spellings for the subcommands, as comma-separated `sub=alias` pairs. A bare word adds another `/queue` subcommand; a leading `/` registers a top-level command:

```
list=ls, status=/qs, auto=/queue-auto
```

With that, `/queue ls`, `/qs` and `/queue-auto` all work. `/queue-auto` is not a command unless you alias it, and `/queue auto` is the default spelling.

An alias whose name is already taken (`/config`, another plugin's command) says so once and stays off for the session.

Aliases show in `/queue help`.

## Example

```
> run the full test suite in the background
/queue fix the failing tests
/queue /review-pr 123
/queue update the changelog
```

Claude finishes the test run, then fixes the tests, then reviews the PR, then updates the changelog.

## Differences from upstream

| | Upstream | This fork |
| --- | --- | --- |
| Auto | Off by default, `/queue-auto` each session | On by default, `/queue auto`, saved per the setting |
| Entries | Prompts only | Prompts and slash commands |
| Failed send | Entry removed, auto stays on | Prompt kept, auto off with a toast; command dropped with a toast |
| State | Panel only | Panel, `/queue status` and the band above the prompt |
| Spellings | Fixed | Subcommand aliases in settings, `/queue-auto` among them |

Everything else (panel, background-job tracking, Esc, band above the prompt) is the upstream work by [Zdeno Kuzmany](https://github.com/kuzmany), under MIT.

## License

MIT
