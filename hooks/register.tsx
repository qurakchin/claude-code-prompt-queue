import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { QueueItem } from '../types'

const items = atom({ plugin: 'prompt-queue', key: 'items' } as const, [], { shape: 'items-2' })
const auto = atom({ plugin: 'prompt-queue', key: 'auto' } as const, true)
// Whether this session read the auto setting in; a reload keeps the toggle's choice.
const initialized = atom({ plugin: 'prompt-queue', key: 'initialized' } as const, false)
// Ids of background tasks and agents the main session started and still waits on.
const waiting = atom({ plugin: 'prompt-queue', key: 'waiting' } as const, [])
// Whether a main-loop turn is running; kept in state so a reload mid-turn remembers it.
const busy = atom({ plugin: 'prompt-queue', key: 'busy' } as const, false)
// Whether a send is on its way and has not started a turn yet.
const sending = atom({ plugin: 'prompt-queue', key: 'sending' } as const, false)

const BASH_STARTED = /running in background with ID: (\S+?)\.?\s/
const AGENT_STARTED = /agentId: ([\w-]+)/
// A finished job's notice; it stays inside its own <task-notification> block.
const FINISHED = /<task-id>([^<]+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?<status>(?!running)/g
// A subagent's final report, sent as a message from that agent.
const HANDED_BACK = /<agent-message from="([^"]+)">\s*\[Subagent hand-back\]/g
// Job notices arrive on their own or inside another session's message, never in a prompt the user typed.
const NOTICE_ORIGINS = ['task-notification', 'peer']

const PANE = 'queue'

const SUBCOMMANDS = ['help', 'list', 'status', 'run', 'drop', 'clear', 'unblock', 'auto'] as const
type Sub = (typeof SUBCOMMANDS)[number]

const isSub = (word: string): word is Sub => (SUBCOMMANDS as readonly string[]).includes(word)

const DESCRIPTIONS: Record<Sub, string> = {
  help: 'List the queue commands',
  list: 'Show parked entries',
  status: 'Print the queue without opening the panel',
  run: 'Send entry n now (default 1)',
  drop: 'Remove entry n',
  clear: 'Remove all entries',
  unblock: 'Stop waiting on background jobs',
  auto: 'Toggle running the queue after each task and its background jobs end',
}

// The hint the typeahead and the input box draw dim after the command name.
const ARGUMENTS = `[text | /command | ${SUBCOMMANDS.join('|')}]`
// A top-level alias takes the arguments of the subcommand it stands for.
const HINTS: Partial<Record<Sub, string>> = { run: '[n]', drop: '[n]' }

const HELP = `/queue            open the panel: edit, reorder, run, remove
/queue <text>     park a prompt
/queue /cmd ...   park a slash command to run as if typed
/queue help       list these commands
/queue list       show parked entries
/queue status     print the queue without the panel
/queue run [n]    send entry n now (default 1)
/queue drop <n>   remove entry n
/queue clear      remove all entries
/queue unblock    stop waiting on background jobs
/queue auto       toggle: run the queue after each task and its background jobs end`

type Scope = 'global' | 'session'
type AutoMode = { scope: Scope; value: boolean }
type Aliases = { words: Map<string, Sub>; commands: Map<string, Sub> }

// The settings value names both the initial state and who keeps the toggle's choice.
const readAutoMode = (raw: unknown): AutoMode => {
  const text = String(raw ?? 'global-true')
  return { scope: text.startsWith('session-') ? 'session' : 'global', value: !text.endsWith('false') }
}

// `list=ls` adds /queue ls; `auto=/queue-auto` registers /queue-auto. Commas or newlines split.
const readAliases = (raw: unknown): Aliases => {
  const words = new Map<string, Sub>()
  const commands = new Map<string, Sub>()
  for (const entry of String(raw ?? '').split(/[,\n]+/)) {
    const found = entry.trim().match(/^([a-z]+)\s*=\s*(\S+)$/)
    if (!found) continue
    const sub = found[1]!
    if (!isSub(sub)) continue
    const alias = found[2]!
    if (alias.startsWith('/')) {
      const name = alias.slice(1)
      if (name !== 'queue' && /^[A-Za-z0-9_-]+$/.test(name)) commands.set(name, sub)
    } else if (/^[A-Za-z0-9_-]+$/.test(alias)) {
      words.set(alias, sub)
    }
  }
  return { words, commands }
}

let autoMode: AutoMode = readAutoMode(undefined)
let aliases: Aliases = readAliases('')

// A leading slash parks a slash command rather than text for the model.
const COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/

const parseEntry = (text: string): QueueItem => {
  const trimmed = text.trim()
  const found = trimmed.match(COMMAND)
  return found
    ? { kind: 'command', command: found[1]!, args: (found[2] ?? '').trim() }
    : { kind: 'prompt', text: trimmed }
}

// The line a parked entry shows as: its command as typed, or its prompt.
const textOf = (item: QueueItem) =>
  item.kind === 'prompt' ? item.text : `/${item.command}${item.args ? ` ${item.args}` : ''}`

// The first line of a prompt, cut to fit beside the other mods' counts.
const peek = (text: string) => {
  const line = text.split('\n')[0]!
  return line.length > 30 ? `${line.slice(0, 29)}…` : line
}

// The state drawn dim in the band above the prompt.
const stateText = async ($: Engine) => {
  const [list, isAuto] = await Promise.all([read($, items), read($, auto)])
  const count = list.length
  const jobs = isAuto && count ? (await read($, waiting)).length : 0
  return [count && `${count} queued: ${peek(textOf(list[0]!))}`, isAuto && 'auto', isAuto && count && jobs && `waiting on ${jobs} bg`]
    .filter(Boolean)
    .join(' · ')
}

// The panel's content as text, with no editing or buttons.
const statusText = async ($: Engine) => {
  const [list, isAuto, jobs] = await Promise.all([read($, items), read($, auto), read($, waiting)])
  const head = `${list.length ? `${list.length} queued` : 'Queue is empty'} · auto ${isAuto ? 'on' : 'off'} (${autoMode.scope})`
  const waitingOn = jobs.length ? `waiting on ${jobs.length} background job(s): ${jobs.join(', ')}` : ''
  return [head, waitingOn, ...list.map((item, i) => `${i + 1}. ${textOf(item)}`)].filter(Boolean).join('\n')
}

const helpText = () => {
  const lines = [
    ...[...aliases.words].map(([word, sub]) => `/queue ${word}`.padEnd(17) + sub),
    ...[...aliases.commands].map(([name, sub]) => `/${name}`.padEnd(17) + sub),
  ]
  return lines.length ? `${HELP}\n\nAliases:\n${lines.join('\n')}` : HELP
}

const move = ($: Engine, i: number, by: -1 | 1) =>
  update($, items, list => {
    const j = i + by
    if (j < 0 || j >= list.length) return list
    const copy = [...list]
    ;[copy[i], copy[j]] = [list[j]!, list[i]!]
    return copy
  })

const removeAt = ($: Engine, i: number) => update($, items, list => list.filter((_, j) => j !== i))

// Empty text removes the entry.
const edit = ($: Engine, i: number, text: string) =>
  text.trim() ? update($, items, list => list.map((item, j) => (j === i ? parseEntry(text) : item))) : removeAt($, i)

// A hook cannot submit while it holds the turn; send once it has ended.
const send = async ($: Engine, item: QueueItem, onFail: () => Promise<unknown>) => {
  await update($, busy, () => true)
  await update($, sending, () => true)
  $.clock.after(0, async () => {
    try {
      if (item.kind === 'command') await $.command.run({ command: item.command, args: item.args })
      else await $.prompt.submit({ text: item.text, asUser: true })

      // A prompt starts a turn, which clears sending at turn.start; a command
      // may start none, so the queue moves on by itself after one.
      if (item.kind === 'command' && (await read($, sending))) {
        await update($, busy, () => false)
        await update($, sending, () => false)
        await sendIfIdle($)
      }
    } catch {
      // A failed send started no turn, so nothing else would clear the flags.
      await update($, busy, () => false)
      await update($, sending, () => false)
      await onFail()
    }
  })
}

// Auto sends the next entry only when no turn runs and no background job is left.
const sendIfIdle = async ($: Engine) => {
  if ((await read($, busy)) || !(await read($, auto)) || (await read($, waiting)).length) return
  const [first] = await read($, items)
  if (first === undefined) return
  await update($, items, list => list.slice(1))
  await send($, first, async () => {
    // Keep what could not be sent, at the front, and stop trying on its own.
    await update($, items, list => [first, ...list])
    await update($, auto, () => false)
    $.ui.toast(`Queue paused: could not send "${peek(textOf(first))}". /queue auto resumes.`)
  })
}

const enqueue = async ($: Engine, text: string) => {
  await update($, items, list => [...list, parseEntry(text)])
  await sendIfIdle($)
}

const runAt = async ($: Engine, i: number, item: QueueItem) => {
  await removeAt($, i)
  await send($, item, async () => {
    await update($, items, list => {
      const at = Math.min(i, list.length)
      return [...list.slice(0, at), item, ...list.slice(at)]
    })
    $.ui.toast(`Could not send "${peek(textOf(item))}". It stays in the queue.`)
  })
}

// `global-*` keeps the toggle in settings; `session-*` leaves settings alone.
const toggleAuto = async ($: Engine) => {
  const isOn = !(await read($, auto))
  await update($, auto, () => isOn)
  const text = `Queue auto is ${isOn ? 'on' : 'off'} (${autoMode.scope}).`

  if (autoMode.scope === 'session') {
    if (isOn) await sendIfIdle($)
    return { text }
  }

  try {
    const saved = await $.config.set({
      key: 'prompt-queue.autoMode',
      value: isOn ? 'global-true' : 'global-false',
    })
    // The write reloads the module and drops this hook's timers; the send goes
    // after the write, and the reload's session.start makes it.
    if (!saved.deny) return { text }
  } catch {
    // The write failed; the toggle still stands for this session.
  }

  $.ui.toast('Auto changed for this session only: the setting could not be saved.')
  if (isOn) await sendIfIdle($)
  return { text }
}

const runSub = async ($: Engine, sub: Sub, arg: string): Promise<{ text: string }> => {
  if (sub === 'help') return { text: helpText() }
  if (sub === 'status') return { text: await statusText($) }
  if (sub === 'auto') return toggleAuto($)

  const list = await read($, items)

  if (sub === 'list') {
    return { text: list.map((item, i) => `${i + 1}. ${textOf(item)}`).join('\n') || 'Queue is empty.' }
  }

  if (sub === 'clear') {
    await update($, items, () => [])
    return { text: `Cleared ${list.length} prompt(s).` }
  }

  if (sub === 'unblock') {
    await update($, waiting, () => [])
    await sendIfIdle($)
    return { text: 'Stopped waiting on background jobs.' }
  }

  const n = Number(arg || '1')
  const i = Number.isInteger(n) && n >= 1 && n <= list.length ? n - 1 : -1
  if (i < 0) return { text: `No prompt ${arg || '1'}. Queue has ${list.length}.` }

  const item = list[i]!
  await (sub === 'run' ? runAt($, i, item) : removeAt($, i))
  return { text: `${sub === 'run' ? 'Sending' : 'Dropped'}: ${textOf(item)}` }
}

export const register: Register = (on, options) => {
  autoMode = readAutoMode(options.autoMode)
  aliases = readAliases(options.aliases)

  on('session.start', async ($, e, next) => {
    // Read the setting once per session; a reload keeps what a toggle stored.
    if (!(await read($, initialized))) {
      await update($, auto, () => autoMode.value)
      await update($, initialized, () => true)
    }

    await $.command.register({
      name: 'queue',
      description: 'Park a prompt or command, and run the queue after each task (help, list, status, run, drop, clear, unblock, auto)',
      argumentHint: ARGUMENTS,
      immediate: true,
    })
    for (const [name, sub] of aliases.commands) {
      const argumentHint = HINTS[sub]
      try {
        await $.command.register({
          name,
          description: DESCRIPTIONS[sub],
          ...(argumentHint ? { argumentHint } : {}),
          immediate: true,
        })
      } catch {
        // A name another plugin or Claude Code already uses stays theirs.
      }
    }

    // A reload after saving a global choice re-runs this; the send it dropped goes here.
    await sendIfIdle($)

    return next(e)
  })

  for (const [name, sub] of aliases.commands) {
    on('command.run', { command: name }, async ($, e) => {
      const [first] = e.args.trim().split(/\s+/)
      return runSub($, sub, first ?? '')
    })
  }

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, busy, () => true)
      await update($, sending, () => false)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // Only a background Bash call or an Agent call starts a job; other output may quote the words.
    const pattern =
      e.tool === 'Bash' && e.run_in_background ? BASH_STARTED : e.tool === 'Agent' ? AGENT_STARTED : undefined
    const id = pattern && ran.text?.match(pattern)?.[1]
    if (id) await update($, waiting, ids => [...ids.filter(one => one !== id), id])

    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (NOTICE_ORIGINS.includes(e.origin.kind)) {
      const ended = [...e.text.matchAll(FINISHED), ...e.text.matchAll(HANDED_BACK)].map(match => match[1])
      if (ended.length) await update($, waiting, ids => ids.filter(one => !ended.includes(one)))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId !== undefined) return ended
    await update($, busy, () => false)

    // Esc turns auto off instead of starting the next prompt. With nothing
    // parked there is nothing to stop, so an idle queue stays on.
    if (e.isAborted && (await read($, auto)) && (await read($, items)).length) {
      await update($, auto, () => false)
      $.ui.toast('Queue auto is off. /queue auto turns it back on.')
    } else {
      await sendIfIdle($)
    }

    return ended
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    const args = e.args.trim()
    if (args === '') {
      await $.ui.open({ id: PANE, title: 'Queue', focus: true, closeOnEscape: true })
      return { text: 'Queue panel opened.' }
    }

    // A subcommand matches only in its own form, so "/queue list the files" is queued.
    const [word = '', ...tail] = args.split(/\s+/)
    const sub = aliases.words.get(word) ?? (isSub(word) ? word : undefined)
    if (sub) {
      const takesNumber = sub === 'run' || sub === 'drop'
      const fits = takesNumber
        ? tail.length <= 1 && (tail[0] === undefined || /^\d+$/.test(tail[0]))
        : tail.length === 0
      if (fits) return runSub($, sub, tail[0] ?? '')
    }

    const list = await read($, items)
    await enqueue($, args)

    return { text: `Queued #${list.length + 1}.` }
  })

  // The state goes dim in the band above the prompt, in one row with what other mods draw there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = e.props.hasSurvey ? '' : await stateText($)
    if (!text) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Text dimColor>{text}   </Text>
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Surfaces without a text field (vscode, mobile) add through the command.
    const Input = 'Input' in els ? els.Input : undefined
    const list = await read($, items)

    return (
      <Box flexDirection="column">
        {Input ? (
          <Input key="new" label="Add: " placeholder="Enter to queue at the end" value="" submitLabel="queue" autoFocus
            onSubmit={(v: string) => { if (v.trim()) void enqueue($, v.trim()) }} />
        ) : (
          <Text dimColor>Add with /queue &lt;text&gt;</Text>
        )}
        <Box marginTop={1} flexDirection="column">
          {list.length === 0 && <Text dimColor>Queue is empty.</Text>}
          {list.map((item, i) => (
            <Box key={`row-${i}`} flexDirection="row">
              <Text>{i + 1}. </Text>
              {Input ? (
                <Input key={`edit-${i}`} value={textOf(item)} submitLabel="save" onSubmit={(v: string) => void edit($, i, v)} />
              ) : (
                <Text>{textOf(item)}</Text>
              )}
              <Text> </Text>
              <Button key={`up-${i}`} label="↑" plain dimColor onPress={() => move($, i, -1)} />
              <Text> </Text>
              <Button key={`down-${i}`} label="↓" plain dimColor onPress={() => move($, i, 1)} />
              <Text> </Text>
              <Button key={`run-${i}`} label="▶" plain dimColor
                onPress={() => void runAt($, i, item)} />
              <Text> </Text>
              <Button key={`rm-${i}`} label="✕" plain dimColor onPress={() => removeAt($, i)} />
            </Box>
          ))}
        </Box>
        <Text dimColor>Edit an entry and press Enter to save; empty removes it. A leading / runs as a command. ▶ sends it now.</Text>
      </Box>
    )
  })
}
