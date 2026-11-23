# Prompt Queue for Claude Code

Queue up your next prompts and slash commands while Claude is still working. Run them later, by hand or automatically one by one.

Claude Code's own queue sends your message into the running task. This mod holds prompts back until you want them.

Tested with Claude Code 2.1.322. It is a Claude Mod (a plugin with a hooks module), so it needs a Claude Code build that runs mods.

## Design goal

`/queue` is the person's own instrument, so the session must not see it. The typed line, its arguments, its output, the panel and the band following the prompt belong to the person alone. The one exception is delivery: when the queue pushes an entry, that entry reaches the model exactly as the person's own words would.

The plugin meets this: a `/queue` run answers the engine with nothing, so no command echo and no output is recorded for the model, and everything you would have read as the command's output is printed as a dim notice the model never reads. The up-arrow history keeps the whole line you typed, arguments included. [What the model can see](#what-the-model-can-see) records how that is done, the probe behind it, and the few cases the plugin cannot reach.

## Install

At the Claude Code prompt:

```
/plugin install prompt-queue --marketplace kuzmany/claude-code-prompt-queue
```

Type `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install prompt-queue --marketplace kuzmany/claude-code-prompt-queue
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kuzmany/claude-code-prompt-queue`, then **Add plugin**.

Update to the latest version:

```
claude plugin marketplace update prompt-queue
claude plugin update prompt-queue@prompt-queue
```

Remove it:

```
claude plugin uninstall prompt-queue@prompt-queue
```

## Use

| Command | What it does |
| --- | --- |
| `/queue` | Open the queue panel: edit, move up or down, run (▶, prompts and commands only) or remove (✕) each entry, and add new ones. |
| `/queue <text>` | Park a prompt. Works while Claude is busy. |
| `/queue /name [args]` | Park a slash command to run as if you typed it. |
| `/queue hold <time>` | Park a wait: nothing behind it starts until the time is up. |
| `/queue list` | Show parked entries. |
| `/queue status` | Print the queue state without opening the panel. |
| `/queue run [n]` | Send entry n now (default 1). A hold sends nothing, so it is refused. |
| `/queue drop <n>` | Remove entry n. |
| `/queue clear` | Remove all entries. |
| `/queue auto` | Toggle auto mode. With the default setting the choice lasts for this session. |
| `/queue unblock` | Stop waiting on background jobs and holds. |

A parked prompt does not reach the model until the queue sends it: the queue submits it as the person's own words. A `/queue` run itself reaches no one but you: the command answers the engine with nothing, and its output — including what `list`, `status`, `run` and `drop` show — is printed as a dim notice under `prompt-queue:`, which the model never reads. [What the model can see](#what-the-model-can-see) has the details.

**Auto mode** is off by default. When on, the next entry starts only after the current task ends **and** every background job or agent it started has finished. Then the next, until the queue is empty. Auto stays on until you toggle it off. Pressing Esc turns it off too. Whether `/queue auto`'s choice lasts past the session is up to the **Auto mode** setting.

`/queue status` prints the same state the panel shows, in one line plus the entries, and exits — no panel, no buttons:

```
2 queued · auto off (session)
1. fix the failing tests
2. /review-pr 123
```

A parked slash command runs through `$.command.run`, so it reaches the same command, arguments and hooks as typing it, with a plugin origin rather than the person's. The next entry waits until that command's turn has started, or a short while if it starts none.

**A hold** is an entry that sends nothing. When auto reaches it, it starts its clock and the entries behind it wait; when the time is up, it leaves the queue and the next entry goes. So with `a`, `hold 1h`, `c` parked in auto mode, `c` starts an hour after `a` ended:

```
/queue a
/queue hold 1h
/queue c
/queue auto
```

Durations take `s`, `m` and `h` or their words (`1h`, `1hour`, `1 hour`, `90m`, `1 min`, `1s`, `0.5h`, `1h30m`). Anything else is refused with a message and nothing is parked. The clock is the wall's: it keeps running while auto is off or the plugin reloads, and a machine that slept fires it late. `/queue drop n`, `/queue clear` and `/queue unblock` cancel it; `/queue status` shows `hold 1h · until 14:30 · 42m left`, and the band above the prompt shows `auto · hold until 14:30`. The queue belongs to the session, so closing the session ends a hold with it.

Text that starts with `/` but names no command (`/Users/me/x.md look at this`) is refused when you queue it: a prompt cannot start with `/`, and no such command exists.

If a prompt cannot be sent, it stays in the queue: auto entries return to the front and auto turns off with a toast; a manual run puts it back where it was. `/queue auto` resumes. A slash command that cannot run (an unknown name, a command that fails) is removed with a toast instead, so it does not block the entries behind it.

Above the prompt, each queued entry shows on its own soft amber line, as `#1 <text>` (first 5, then `+N more`). In auto mode a dim line below them shows the state, for example `auto · waiting on 1 bg` or `auto · hold until 14:30`. With the queue empty it draws nothing, even while auto is on, so the row stays free for other mods. Other mods can add to the same row.

`/queue help` lists the commands.

The queue belongs to the current session.

If auto keeps waiting on a job that already ended (for example one a subagent started), run `/queue unblock`; it also cancels any hold and lets the entries behind it go.

## What the model can see

The design goal says the session must not see `/queue` at all. This section records how the plugin meets it, the probe behind it, and the few cases it cannot reach.

### How the engine treats a slash command

Claude Code records a command's run in the transcript and sends it to the model as user text on the next request. Probed on 2.1.316 with a throwaway plugin whose command printed a line and one that printed nothing:

| The `command.run` hook answers | What the transcript holds, and what the model reads |
| --- | --- |
| `{ text }` | `<command-name>/loud</command-name>`, `<command-message>loud</command-message>`, `<command-args></command-args>`, then `<local-command-stdout>quiet-probe: LOUD-OUTPUT</local-command-stdout>` — the model reads all of it |
| `{}` (no `text`, no `context`) | no command row and no text in the request; a `$.ui.log` line is a separate dim notice, and the model does not read that either |

Three facts follow:

- Returning any `text` makes the engine record the echo, arguments included, and the output under the plugin's name (`prompt-queue: …`). There is no API that shows a command's text to the person and not the model.
- Returning no `text` is the only way to keep a run out of the model's context, and it does not cost the up-arrow history: the typed line is stored whole.
- Only a line the engine dispatches as a command reaches `command.run`. A `/queue …` line inside a multi-line prompt (one typed as a continuation, or pasted with the prompt) is ordinary text: the hook never runs, and the model reads the line as typed. `immediate: true`, which this plugin sets, lets a dispatched command run mid-turn, but the plugin cannot mask a line the engine never dispatches.

The prompt history has a rule of its own: the typed line is kept only while the modules hooking the command hold **one** `command.run` registration in total. A second registration in the same module silently withholds every `/queue …` line from the up-arrow history, which is why `register.tsx` serves `/queue` and every alias from a single any-of registration.

### How the plugin answers

Every path — the panel, a parked prompt, `list`, `status`, `run`, `drop`, `clear`, `auto`, `hold`, `unblock`, `help`, a refusal, an alias — answers the engine with nothing (`{}`, no `text`, no `context`), so neither the echo nor anything else is recorded for the model. What would have been the command's output is printed through `$.ui.log`, one dim notice per line under `prompt-queue:`, which the transcript draws and the model never reads. Errors and send failures also raise a toast. The hook does not call `next`, so the engine's own command handling and the hooks beneath it never see the line either.

So `/queue list`, `/queue status`, `/queue run n`, `/queue drop n` and every confirmation show the entries to you and none of them to the model. The up-arrow history keeps the whole line you typed, arguments included; 0.2.7 masked the arguments instead, so a parked prompt's line was recalled as `/queue ` with the text cut away. Refusing a line for its leading slash prints the refusal the same way.

### What the probe showed

The probe ran this checkout in a real 2.1.316 session and read back the session's own request records:

- `/queue SECRET-ARG-1`, `/queue list` (once with the session idle, once while a pushed prompt's turn was running) and `/queue status` left no `/queue`, no argument and no output in any API request.
- `history.jsonl` kept `/queue SECRET-ARG-1` whole.
- The queue pushed `SECRET-ARG-1` and, after that turn ended, a second entry on its own; each reached the model as a plain user message holding the entry's text and nothing else.

### What still reaches the model

- A delivered entry is read as the person's own words by design (`asUser: true`), with no "the plugin sent a message" frame.
- The transcript still records a delivered entry with `{ kind: 'plugin', name: 'prompt-queue' }` as its origin, and every hook sees that rather than the person.
- `@file` mentions and pasted images are not expanded for a plugin's prompt, so a parked prompt that mentions a file does not carry the file the way a typed one would.
- A `/queue …` line the engine never dispatches — the continuation line of a multi-line prompt — is ordinary text and reaches the model as typed. The plugin is not called for it and cannot mask it.
- A parked slash command runs through `$.command.run` with a plugin origin. Commands that require the person's own invocation may refuse it, and a parked `/queue …` entry cannot run at all: `$.command.run` skips the calling hook, which is the only hook serving `/queue`.
- The session's transcript file keeps the notices and the parked text in clear, as it keeps the rest of the conversation. The model's requests do not carry them, but anything that reads that file does. The band, the panel and toasts leave the transcript and the model both untouched.
- The probe and the table above were read on 2.1.316; a build that changes when a `command.run` answer becomes a user turn would need the same check again.

## Rewind and the prompt history

`/rewind` lists only the prompts you typed into the prompt box. A `/queue …` run is not one of its checkpoints, and neither is the entry the queue later delivers: the queue submits it as your words and the model reads it, but its origin is the plugin, and the menu leaves it out. Checked on 2.1.316: with a typed prompt and a delivered entry in the same session — both turns completed — the menu listed the typed prompt alone, and a session whose only prompt arrived through the queue said "Nothing to rewind to yet". Nor does returning `text` help: a command's recorded row is left out too. Nothing the plugin can write is both a checkpoint and hidden from the model — a notice is a row you see and the model does not, but rewind ignores notices, and every user-role row is read.

What does work: Ctrl+R, the prompt history, finds the whole `/queue …` line you typed, arguments included, and every confirmation or listing the queue prints is a dim notice in the transcript that names the entry — `Queued #1: fix the failing tests`, then `1. fix the failing tests` from `/queue list` — so what you parked can be read back there before it is sent.

## Settings

The plugin's fields are rows in `/config`, under **Auto mode** and **Subcommand aliases**.

**Auto mode** sets auto's starting state and where `/queue auto` saves the toggle:

| Value | Starts | `/queue auto` writes the setting |
| --- | --- | --- |
| `global-true` | on | yes |
| `global-false` | off | yes |
| `session-true` | on | no, this session only |
| `session-false` (default) | off | no, this session only |

The default keeps auto off and the toggle in this session, as before the setting existed. The setting is read once when a session starts; a reload keeps the value you toggled in that session, and a new session reads the setting again.

**Subcommand aliases** adds other spellings for the subcommands, as comma-separated `sub=alias` pairs. A bare word adds another `/queue` subcommand; a leading `/` registers a top-level command:

```
list=ls, status=/qs, auto=/queue-auto
```

With that, `/queue ls`, `/qs` and `/queue-auto` all work. `/queue` is the only command the plugin registers without this setting: the older top-level `/queue-auto` and `/queue-run` are gone, and `auto=/queue-auto, run=/queue-run` brings them back.

An alias whose name is already taken (`/config`, another plugin's command) says so once and stays off for the session.

Aliases show in `/queue help`.

## Example

```
> run the full test suite in the background
/queue fix the failing tests
/queue /review-pr 123
/queue update the changelog
/queue auto
```

Claude finishes the test run, then fixes the tests, then reviews the PR, then updates the changelog.

## Development

```
git clone https://github.com/kuzmany/claude-code-prompt-queue
cd claude-code-prompt-queue
claude plugin validate .
claude plugin test
claude --plugin-dir .
```

`claude plugin test` runs `hooks/queue.test.tsx` with no session and no network. `claude --plugin-dir .` loads your checkout; saving `hooks/register.tsx` reloads it.

## License

MIT
