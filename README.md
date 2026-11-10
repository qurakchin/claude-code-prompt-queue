# Prompt Queue for Claude Code

Queue up your next prompts while Claude is still working. Run them later, by hand or automatically one by one.

Claude Code's own queue sends your message into the running task. This mod holds prompts back until you want them.

This is a fork of [kuzmany/claude-code-prompt-queue](https://github.com/kuzmany/claude-code-prompt-queue) with two changes:

- **Auto is on by default.** `/queue <text>` runs as soon as the session is idle, with no `/queue-auto` to remember each session.
- **Slash commands can be queued.** `/queue /review-pr 123` runs the command as if you typed it, and a leading `/` is enough to tell it apart from a prompt.

It also keeps an entry that could not be sent instead of dropping it, and stops auto with a toast so the queue does not silently lose it.

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
| `/queue run [n]` | Send entry n now (default 1). |
| `/queue drop <n>` | Remove entry n. |
| `/queue clear` | Remove all entries. |
| `/queue-auto` | Toggle auto mode. |
| `/queue unblock` | Stop waiting on background jobs. |

**Auto mode is on by default.** The next entry starts only after the current task ends **and** every background job or agent it started has finished. Then the next, until the queue is empty. No setup per session: park and go.

`/queue-auto` turns it off, and it stays off for the rest of the session. Pressing Esc during a task turns it off too, when something is still parked.

A parked slash command runs through `$.command.run`, so it reaches the same command, arguments and hooks as typing it. A command that starts no turn lets the next entry go by itself.

If an entry cannot be sent, it stays in the queue: auto entries return to the front and auto turns off with a toast; a manual run puts it back where it was. `/queue-auto` resumes.

A dim line above the prompt shows the state, for example `3 queued: /review-pr 12 · auto · waiting on 1 bg`. Other mods can add to the same row.

`/queue help` lists the commands.

The queue belongs to the current session.

If auto keeps waiting on a job that already ended (for example one a subagent started), run `/queue unblock`.

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
| Auto | Off by default, `/queue-auto` each session | On by default |
| Entries | Prompts only | Prompts and slash commands |
| Failed send | Entry removed, auto stays on | Entry kept, auto turns off with a toast |

Everything else (panel, background-job tracking, Esc, band above the prompt) is the upstream work by [Zdeno Kuzmany](https://github.com/kuzmany), under MIT.

## License

MIT
