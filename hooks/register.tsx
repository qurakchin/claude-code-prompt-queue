import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { QueueItem } from '../types'

const items = atom({ plugin: 'prompt-queue', key: 'items' } as const, [], { shape: 'items-2' })
const auto = atom({ plugin: 'prompt-queue', key: 'auto' } as const, false)
// Whether this session read the auto setting in; a reload keeps the toggle's choice.
const initialized = atom({ plugin: 'prompt-queue', key: 'initialized' } as const, false)
// Ids of background tasks and agents the main session started and still waits on.
const waiting = atom({ plugin: 'prompt-queue', key: 'waiting' } as const, [])
// Whether a main-loop turn is running; kept in state so a reload mid-turn remembers it.
const busy = atom({ plugin: 'prompt-queue', key: 'busy' } as const, false)
// Whether a send is on its way and has not started a turn yet. Sends do not
// overlap: one sets busy before its entry leaves the queue (see send) and clears
// it only when the send failed or started no turn.
const sending = atom({ plugin: 'prompt-queue', key: 'sending' } as const, false)

const BASH_STARTED = /running in background with ID: (\S+?)\.?\s/
const AGENT_STARTED = /agentId: ([\w-]+)/
// A finished job's notice; it stays inside its own <task-notification> block.
const FINISHED = /<task-id>([^<]+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?<status>(?!running)/g
// A subagent's final report, sent as a message from that agent.
const HANDED_BACK = /<agent-message from="([^"]+)">\s*\[Subagent hand-back\]/g
// Job notices arrive on their own or inside another session's message, never in a prompt the user typed.
const NOTICE_ORIGINS = ['task-notification', 'peer']

// The ids a notice says ended. A notice arrives as its own prompt when the
// session is idle, and as a queued command inside the running turn when it is
// not: both carry the same block.
const endedIn = (text: string) =>
  [...text.matchAll(FINISHED), ...text.matchAll(HANDED_BACK)].map(match => match[1]!)

const forgetEnded = async ($: Engine, text: string) => {
  const ended = endedIn(text)
  if (ended.length) await update($, waiting, ids => ids.filter(one => !ended.includes(one)))
}

// The task a successful TaskStop ended. Its record names what was stopped, not
// what was asked for (an agent may be stopped by name), and a stop that found
// nothing answers an error, whose result is the error text and no id.
const stoppedId = (ran: { isError?: boolean; result?: unknown }) => {
  if (ran.isError) return undefined
  const id = (ran.result as { task_id?: unknown } | undefined)?.task_id
  return typeof id === 'string' ? id : undefined
}

const PANE = 'queue'

const SUBCOMMANDS = ['help', 'list', 'status', 'run', 'drop', 'clear', 'unblock', 'auto', 'hold'] as const
type Sub = (typeof SUBCOMMANDS)[number]

const isSub = (word: string): word is Sub => (SUBCOMMANDS as readonly string[]).includes(word)

const DESCRIPTIONS: Record<Sub, string> = {
  help: 'List the queue commands',
  list: 'Show parked entries',
  status: 'Print the queue without opening the panel',
  run: 'Send entry n now (default 1)',
  drop: 'Remove entry n',
  clear: 'Remove all entries',
  unblock: 'Stop waiting on background jobs and holds',
  auto: 'Toggle running the queue after each task and its background jobs end',
  hold: 'Park a wait: nothing after it starts until the time is up',
}

// The hint the typeahead and the input box draw dim after the command name.
const ARGUMENTS = `[text | /command | ${SUBCOMMANDS.join('|')}]`
// A top-level alias takes the arguments of the subcommand it stands for.
const HINTS: Partial<Record<Sub, string>> = { run: '[n]', drop: '[n]', hold: '[duration]' }

const HELP = `/queue            open the panel: edit, reorder, run, remove
/queue <text>     park a prompt
/queue /cmd ...   park a slash command to run as if typed
/queue help       list these commands
/queue list       show parked entries
/queue status     print the queue without the panel
/queue run [n]    send entry n now (default 1)
/queue drop <n>   remove entry n
/queue clear      remove all entries
/queue unblock    stop waiting on background jobs and holds
/queue auto       toggle: run the queue after each task and its background jobs end
/queue hold <time> park a wait: 30m, 1h, 0.5h, 1 hour, 1h30m`

type Scope = 'global' | 'session'
type AutoMode = { scope: Scope; value: boolean }
type Aliases = { words: Map<string, Sub>; commands: Map<string, Sub> }

// The settings value names both the initial state and who keeps the toggle's choice.
// Off and session-only is what the plugin did before the setting existed.
const readAutoMode = (raw: unknown): AutoMode => {
  const text = String(raw ?? 'session-false')
  return { scope: text.startsWith('session-') ? 'session' : 'global', value: !text.endsWith('false') }
}

// `list=ls` adds /queue ls; `auto=/queue-auto` registers /queue-auto. Commas or newlines split.
const readAliases = (raw: unknown): Aliases => {
  const words = new Map<string, Sub>()
  // No top-level command is registered unless the setting adds one: /queue is
  // the only command this plugin holds by default.
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
// The alias commands this session registered. A name Claude Code or another
// plugin already holds stays theirs, and only a registered one is answered.
let registered = new Set<string>()

// A leading slash parks a slash command rather than text for the model.
const COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/
// What the engine reads as a command name, as its own dispatch tests it. Text
// with a leading slash that names no such command can be neither run nor sent
// as a prompt ($.prompt.submit refuses a prompt that starts with "/").
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9:_-]*$/

const parseEntry = (text: string): QueueItem => {
  const trimmed = text.trim()
  const found = trimmed.match(COMMAND)
  return found
    ? { kind: 'command', command: found[1]!, args: (found[2] ?? '').trim() }
    : { kind: 'prompt', text: trimmed }
}

// What one unit is worth, in milliseconds. The spellings people type: h, hr,
// hrs, hour, hours; m, min, mins, minute, minutes; s, sec, secs, second, seconds.
const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
}

const DURATION_PART = /^(\d+(?:\.\d+)?)\s*([a-z]+)/

// `30m`, `1h`, `0.5h`, `1 hour`, `1 h 30 min`, `1h30m` -> milliseconds.
// The whole text has to be durations: a leftover word makes it undefined.
const parseDuration = (text: string): number | undefined => {
  let rest = text.trim().toLowerCase()
  if (!rest) return undefined
  let total = 0
  while (rest) {
    const found = rest.match(DURATION_PART)
    if (!found) return undefined
    const unit = UNIT_MS[found[2]!]
    if (unit === undefined) return undefined
    total += Number(found[1]) * unit
    rest = rest.slice(found[0].length).trimStart()
  }
  if (!Number.isFinite(total) || total <= 0) return undefined
  return Math.round(total)
}

// The duration as the shortest common spelling: 90m, 1h30m, 30s.
const formatDuration = (ms: number) => {
  const parts: string[] = []
  let left = Math.round(ms / 1000)
  const hours = Math.floor(left / 3600)
  left -= hours * 3600
  const minutes = Math.floor(left / 60)
  left -= minutes * 60
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (left) parts.push(`${left}s`)
  return parts.join('') || '0s'
}

const HOLD_HINT = 'Use a duration like 30m, 1h, 0.5h, 1 hour or 1h30m.'
const holdRefusal = (arg: string) =>
  arg.trim() ? `"${arg.trim()}" is not a duration. ${HOLD_HINT}` : `hold needs a duration. ${HOLD_HINT}`

// The local time a deadline falls on, for the band and status.
const clockLabel = (ms: number) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

// The token after the slash when the text starts with one that names no command.
const badCommand = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const name = trimmed.match(COMMAND)?.[1]
  if (name !== undefined && COMMAND_NAME.test(name)) return undefined
  return name === undefined ? trimmed.split(/\s+/)[0]! : `/${name}`
}

const REFUSED = (token: string) => `${token} is not a command name, and a prompt cannot start with "/".`

// The plugin answers the person, never the model. A `command.run` hook that
// returns `text` makes the engine record the command echo and that output as a
// user turn, which the model then reads — so the queue command answers nothing
// and prints through `$.ui.log`, a transcript line the model never reads.
const say = ($: Engine, text: string) => {
  for (const line of text.split('\n')) if (line) $.ui.log(line)
  return {}
}

// Refuses text that can never be queued, saying why in a toast.
const refuse = ($: Engine, text: string) => {
  const bad = badCommand(text)
  if (bad !== undefined) $.ui.toast(REFUSED(bad))
  return bad !== undefined
}

// The line a parked entry shows as: its command as typed, its prompt, or its hold.
const textOf = (item: QueueItem) =>
  item.kind === 'prompt'
    ? item.text
    : item.kind === 'hold'
      ? `hold ${formatDuration(item.ms)}`
      : `/${item.command}${item.args ? ` ${item.args}` : ''}`

// The first line of an entry, cut to `width` columns.
const firstLine = (text: string, width: number) => {
  const line = text.split('\n')[0]!
  return line.length > width ? `${line.slice(0, Math.max(width - 1, 1))}…` : line
}

// How many queued prompts the band above the prompt lists before "+N more".
const SHOWN = 5

// The active hold at the front, for the band: an absolute time, since nothing
// redraws per second.
const holdState = (item: QueueItem | undefined) =>
  item?.kind === 'hold' && item.until !== undefined ? `hold until ${clockLabel(item.until)}` : ''

// One entry in the panel's status text: a started hold also says what is left.
const statusLine = (item: QueueItem, now: number) =>
  item.kind === 'hold' && item.until !== undefined
    ? `${textOf(item)} · until ${clockLabel(item.until)} · ${formatDuration(Math.max(item.until - now, 0))} left`
    : textOf(item)

// The state drawn dim in the band above the prompt.
const stateText = async ($: Engine) => {
  const [list, isAuto] = await Promise.all([read($, items), read($, auto)])
  const count = list.length
  // With nothing parked the band stays free for other mods, even while auto is on.
  if (!count) return ''
  const jobs = isAuto ? (await read($, waiting)).length : 0
  return [isAuto && 'auto', holdState(list[0]), isAuto && jobs && `waiting on ${jobs} bg`]
    .filter(Boolean)
    .join(' · ')
}

// The panel's content as text, with no editing or buttons.
const statusText = async ($: Engine) => {
  const [list, isAuto, jobs] = await Promise.all([read($, items), read($, auto), read($, waiting)])
  // The clock is asked only when a hold is counting: status works without one.
  const counting = list.some(item => item.kind === 'hold' && item.until !== undefined)
  const now = counting ? await $.clock.now() : 0
  const head = `${list.length ? `${list.length} queued` : 'Queue is empty'} · auto ${isAuto ? 'on' : 'off'} (${autoMode.scope})`
  const waitingOn = jobs.length ? `waiting on ${jobs.length} background job(s): ${jobs.join(', ')}` : ''
  return [head, waitingOn, ...list.map((item, i) => `${i + 1}. ${statusLine(item, now)}`)].filter(Boolean).join('\n')
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

// Removing the front hold stops its clock; whatever came after it may go.
const dropAt = async ($: Engine, i: number) => {
  const item = (await read($, items))[i]
  const wasActive = item?.kind === 'hold' && item.until !== undefined
  await removeAt($, i)
  if (wasActive) disarmHold()
  await sendIfIdle($)
}

// Empty text removes the entry.
const edit = async ($: Engine, i: number, text: string) => {
  if (!text.trim()) {
    await dropAt($, i)
    return
  }
  await update($, items, list => list.map((item, j) => (j === i ? parseEntry(text) : item)))
}

// A new duration starts the hold over from the moment it reaches the front.
const changeHold = async ($: Engine, i: number, ms: number) => {
  const item = (await read($, items))[i]
  const wasActive = item?.kind === 'hold' && item.until !== undefined
  await update($, items, list => list.map((one, j) => (j === i ? { kind: 'hold', ms } : one)))
  if (wasActive && i === 0) {
    disarmHold()
    await sendIfIdle($)
  }
}

// How long a command that starts no turn holds the queue. The engine raises a
// command's turn after $.command.run resolves, so sending never means "no turn"
// at that point; turn.start clears the flag instead, and only silence moves on.
const COMMAND_GRACE_MS = 250

// Counts sends, so a late check of one does not act on a later send's flags.
let sends = 0

// A hook cannot submit while it holds the turn; send once it has ended.
// `take` removes the entry from the queue, after busy is set: a reload's
// session.start that starts sending finds the queue taken, not one entry short.
// A prompt that could not be sent may go through next time; a command that
// failed (an unknown name, a command that throws) will fail again.
const send = async (
  $: Engine,
  item: QueueItem,
  take: () => Promise<unknown>,
  onPromptFail: (reason?: string) => Promise<unknown>,
) => {
  await update($, busy, () => true)
  await update($, sending, () => true)
  const gen = ++sends
  await take()
  // A failed send started no turn, so nothing else would clear the flags.
  const stop = async () => {
    await update($, busy, () => false)
    await update($, sending, () => false)
  }
  // Whatever was expected never came: the queue has nothing more to wait for.
  const moveOn = async () => {
    await stop()
    await sendIfIdle($)
  }

  $.clock.after(0, async () => {
    try {
      if (item.kind === 'prompt') {
        const out = await $.prompt.submit({ text: item.text, asUser: true })
        // A hook may refuse a prompt without throwing, answering { drop }: no
        // turn starts then, so nothing else would clear the flags.
        if ('drop' in out && gen === sends && (await read($, sending))) {
          await stop()
          await onPromptFail(out.drop)
        }
        return
      }
      await $.command.run({ command: item.command, args: item.args })
      $.clock.after(COMMAND_GRACE_MS, async () => {
        if (gen === sends && (await read($, sending))) await moveOn()
      })
    } catch {
      // A command that cannot run would block every entry behind it, so it
      // leaves the queue and the next entry goes.
      if (item.kind === 'command') {
        $.ui.toast(`Could not run "${textOf(item)}". It was removed from the queue.`)
        await moveOn()
        return
      }
      await stop()
      await onPromptFail()
    }
  })
}

type HoldItem = Extract<QueueItem, { kind: 'hold' }>

// One hold at a time: the entry at the front. The clock is the wall's, so a
// reload re-arms it from `until`, and a machine that slept fires it late.
let holdTimer: { cancel: () => void } | undefined
let holdUntil: number | undefined

const disarmHold = () => {
  holdTimer?.cancel()
  holdTimer = undefined
  holdUntil = undefined
}

const armHold = async ($: Engine, until: number) => {
  if (holdUntil === until && holdTimer !== undefined) return
  disarmHold()
  holdUntil = until
  const wait = until - (await $.clock.now())
  holdTimer = $.clock.after(Math.max(wait, 0), () => void expireHold($, until))
}

// The wait is over: drop the front hold if it is still the same one, and let
// what follows go. A timer whose hold was dropped or re-armed does nothing.
const expireHold = async ($: Engine, until: number) => {
  if (holdUntil !== until) return
  disarmHold()
  const [first] = await read($, items)
  if (first?.kind !== 'hold' || first.until !== until) return
  const now = await $.clock.now()
  if (now < until) {
    await armHold($, until)
    return
  }
  await update($, items, list =>
    list[0]?.kind === 'hold' && list[0].until === until ? list.slice(1) : list,
  )
  await sendIfIdle($)
}

// Reaching a hold starts its clock; it sends nothing itself.
const startHold = async ($: Engine, item: HoldItem) => {
  if (item.until !== undefined) {
    await armHold($, item.until)
    return
  }
  const until = (await $.clock.now()) + item.ms
  await update($, items, list =>
    list[0]?.kind === 'hold' && list[0].until === undefined ? [{ ...list[0], until }, ...list.slice(1)] : list,
  )
  // A concurrent call may have started it first; arm what the entry now says.
  const [first] = await read($, items)
  if (first?.kind === 'hold' && first.until !== undefined) await armHold($, first.until)
}

// Auto sends the next entry only when no turn runs and no background job is left.
const sendIfIdle = async ($: Engine) => {
  if ((await read($, busy)) || !(await read($, auto)) || (await read($, waiting)).length) return
  const [first] = await read($, items)
  if (first === undefined) return
  if (first.kind === 'hold') {
    await startHold($, first)
    return
  }
  await send($, first, () => update($, items, list => list.slice(1)), async reason => {
    // Keep what could not be sent, at the front, and stop trying on its own.
    await update($, items, list => [first, ...list])
    await update($, auto, () => false)
    const why = reason ? `: ${reason}` : ''
    $.ui.toast(`Queue paused: could not send "${firstLine(textOf(first), 30)}"${why}. /queue auto resumes.`)
  })
}

// "hold 1h" typed into the panel is the same entry the command parks.
const HOLD_TEXT = /^hold\s+(.+)$/i

const parkHold = async ($: Engine, ms: number) => {
  const count = (await read($, items)).length
  await update($, items, list => [...list, { kind: 'hold', ms }])
  await sendIfIdle($)
  return count + 1
}

// Parks what `text` names and answers the entry it parked, or nothing when a
// hold's duration could not be read.
const enqueue = async ($: Engine, text: string): Promise<QueueItem | undefined> => {
  const hold = text.trim().match(HOLD_TEXT)
  if (hold) {
    const ms = parseDuration(hold[1]!)
    if (ms === undefined) {
      $.ui.toast(holdRefusal(hold[1]!))
      return undefined
    }
    await parkHold($, ms)
    return { kind: 'hold', ms }
  }
  const item = parseEntry(text)
  await update($, items, list => [...list, item])
  await sendIfIdle($)
  return item
}

// /queue hold <time> parks a wait, refusing a duration it cannot read.
const enqueueHold = async ($: Engine, arg: string) => {
  const ms = parseDuration(arg)
  if (ms === undefined) return holdRefusal(arg)
  const at = await parkHold($, ms)
  return `Queued #${at}: hold ${formatDuration(ms)}.`
}

const runAt = async ($: Engine, i: number, item: QueueItem) => {
  await send($, item, () => removeAt($, i), async reason => {
    await update($, items, list => {
      const at = Math.min(i, list.length)
      return [...list.slice(0, at), item, ...list.slice(at)]
    })
    const why = reason ? `: ${reason}` : ''
    $.ui.toast(`Could not send "${firstLine(textOf(item), 30)}"${why}. It stays in the queue.`)
  })
}

// The index of entry `arg` (1-based, default 1), or an error reply.
const pick = async ($: Engine, arg: string) => {
  const list = await read($, items)
  const n = Number(arg || '1')
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return { i: n - 1, item: list[n - 1]! }
  return { error: `No entry ${arg || '1'}. Queue has ${list.length}.` }
}

// /queue run [n]: send entry n (default 1) now.
const runNth = async ($: Engine, arg: string) => {
  const p = await pick($, arg)
  if ('error' in p) return p.error
  if (p.item.kind === 'hold') {
    return `${textOf(p.item)} sends nothing; it starts when auto reaches it. /queue drop ${p.i + 1} removes it.`
  }
  await runAt($, p.i, p.item)
  return `Sending: ${textOf(p.item)}`
}

// `global-*` keeps the toggle in settings; `session-*` leaves settings alone.
const toggleAuto = async ($: Engine) => {
  const isOn = !(await read($, auto))
  await update($, auto, () => isOn)
  const text = `Queue auto is ${isOn ? 'on' : 'off'} (${autoMode.scope}).`

  if (autoMode.scope === 'session') {
    if (isOn) await sendIfIdle($)
    return text
  }

  try {
    const saved = await $.config.set({
      key: 'prompt-queue.autoMode',
      value: isOn ? 'global-true' : 'global-false',
    })
    // The write usually reloads the module and the reload's session.start
    // sends; where it does not reload, this one does. The busy flag keeps the
    // two from both sending.
    if (!saved.deny) {
      if (isOn) await sendIfIdle($)
      return text
    }
  } catch {
    // The write failed; the toggle still stands for this session.
  }

  $.ui.toast('Auto changed for this session only: the setting could not be saved.')
  if (isOn) await sendIfIdle($)
  return text
}

const runSub = async ($: Engine, sub: Sub, arg: string) => {
  if (sub === 'help') return say($, helpText())
  if (sub === 'status') return say($, await statusText($))
  if (sub === 'auto') return say($, await toggleAuto($))
  if (sub === 'hold') return say($, await enqueueHold($, arg))

  const list = await read($, items)

  if (sub === 'list') {
    return say($, list.map((item, i) => `${i + 1}. ${textOf(item)}`).join('\n') || 'Queue is empty.')
  }

  if (sub === 'clear') {
    disarmHold()
    await update($, items, () => [])
    return say($, `Cleared ${list.length} prompt(s).`)
  }

  if (sub === 'unblock') {
    disarmHold()
    await update($, waiting, () => [])
    await update($, items, entries => entries.filter(item => item.kind !== 'hold'))
    await sendIfIdle($)
    return say($, 'Stopped waiting on background jobs and holds.')
  }

  if (sub === 'run') return say($, await runNth($, arg))

  const p = await pick($, arg)
  if ('error' in p) return say($, p.error)
  await dropAt($, p.i)
  return say($, `Dropped: ${textOf(p.item)}`)
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
      description: 'Park a prompt or command to run later (help, list, status, run, drop, clear, unblock, auto)',
      argumentHint: ARGUMENTS,
      immediate: true,
    })
    registered = new Set()
    for (const [name, sub] of aliases.commands) {
      const argumentHint = HINTS[sub]
      try {
        await $.command.register({
          name,
          description: DESCRIPTIONS[sub],
          ...(argumentHint ? { argumentHint } : {}),
          immediate: true,
        })
        registered.add(name)
      } catch {
        // A name another plugin or Claude Code already uses stays theirs; say
        // so, since the alias silently does nothing otherwise.
        $.ui.toast(`/${name} is taken; that alias is off for this session.`)
      }
    }

    // A hold started before a reload keeps its wall clock: arm what is left of it.
    const [head] = await read($, items)
    if (head?.kind === 'hold' && head.until !== undefined) await armHold($, head.until)

    // A reload after saving a global choice re-runs this; the send it dropped goes here.
    await sendIfIdle($)

    return next(e)
  })

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

    // TaskStop ends a job with no task notification, so nothing else would
    // clear it and auto would wait on it forever: the stop's own record does.
    const stopped = e.tool === 'TaskStop' ? stoppedId(ran) : undefined
    if (stopped) await update($, waiting, ids => ids.filter(one => one !== stopped))

    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (NOTICE_ORIGINS.includes(e.origin.kind)) await forgetEnded($, e.text)

    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    // A notice that arrives while a turn runs is queued into it as a command
    // instead of reaching prompt.submit; without it here, auto waits forever.
    if (e.type === 'queued_command') await forgetEnded($, e.text)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId !== undefined) return ended
    await update($, busy, () => false)

    // Esc turns auto off instead of starting the next prompt.
    if (e.isAborted && (await read($, auto))) {
      await update($, auto, () => false)
      $.ui.toast('Queue auto is off. /queue auto turns it back on.')
    } else {
      await sendIfIdle($)
    }

    return ended
  })

  // /queue and every alias command (the built-in shortcuts and the ones a
  // setting adds) share ONE registration, its matcher an any-of array. The
  // module must keep exactly one `command.run` registration: the engine counts
  // them and, with more than one, silently withholds the typed line from the
  // prompt history (its tyt() gate): "/queue ..." and every alias line then
  // stop being recalled by the up arrow, with no error anywhere. Adding another
  // `on('command.run', ...)` here breaks that the same way.
  on('command.run', { command: ['queue', ...aliases.commands.keys()] }, async ($, e, next) => {
    if (e.command !== 'queue') {
      const sub = aliases.commands.get(e.command)
      // A name that could not be registered belongs to someone else: answer
      // nothing of it and let the command it names run.
      if (sub === undefined || !registered.has(e.command)) return next(e)
      // The arguments go to the subcommand as typed; /queue itself would queue
      // ones the subcommand does not take as a prompt instead.
      return runSub($, sub, e.args.trim())
    }

    const args = e.args.trim()
    if (args === '') {
      await $.ui.open({ id: PANE, title: 'Queue', focus: true, closeOnEscape: true })
      return {}
    }

    // A subcommand matches only in its own form, so "/queue list the files" is queued.
    const [word = '', ...tail] = args.split(/\s+/)
    const sub = aliases.words.get(word) ?? (isSub(word) ? word : undefined)
    if (sub) {
      // hold takes the rest as its duration ("1 h" is one argument).
      if (sub === 'hold') return runSub($, sub, tail.join(' '))
      const takesNumber = sub === 'run' || sub === 'drop'
      const fits = takesNumber
        ? tail.length <= 1 && (tail[0] === undefined || /^\d+$/.test(tail[0]))
        : tail.length === 0
      if (fits) return runSub($, sub, tail[0] ?? '')
    }

    // A leading slash that names no command cannot be run or sent, so it is
    // refused now rather than dropped by a send that cannot work.
    const bad = badCommand(args)

    // Answering no `text` is what keeps the run out of the model's context: the
    // engine records the command echo and the hook's text as a user turn, so
    // either one would be read on the next request. The person's answer goes
    // through `say` instead, and the typed line stays whole in the history.
    if (bad) return say($, REFUSED(bad))

    const list = await read($, items)
    const item = await enqueue($, args)
    if (item === undefined) return {}

    // The notice carries the entry's text: it is the person's transcript, and
    // the one place the entry can be read back before it is sent.
    return say($, `Queued #${list.length + 1}: ${firstLine(textOf(item), 60)}`)
  })

  // Above the prompt: each queued prompt on its own line, then the dim state row,
  // in one row with what other mods draw there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [text, list] = await Promise.all([stateText($), read($, items)])
    if (!text && !list.length) return next(e)
    const width = Math.max((e.props.bodyColumns ?? 80) - 10, 20)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {list.slice(0, SHOWN).map((item, i) => (
          <Box key={`q-${i}`} flexDirection="row">
            <Text color="#b8a77a">{`#${i + 1} `}</Text>
            <Text color="#b8a77a">{firstLine(textOf(item), width)}</Text>
          </Box>
        ))}
        {list.length > SHOWN && <Text dimColor>{`   +${list.length - SHOWN} more · /queue to see all`}</Text>}
        <Box flexDirection="row">
          {text && <Text dimColor>{text}   </Text>}
          {await next(e)}
        </Box>
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
            onSubmit={(v: string) => { if (v.trim() && !refuse($, v)) void enqueue($, v.trim()) }} />
        ) : (
          <Text dimColor>Add with /queue &lt;text&gt;</Text>
        )}
        <Box marginTop={1} flexDirection="column">
          {list.length === 0 && <Text dimColor>Queue is empty.</Text>}
          {list.map((item, i) => (
            <Box key={`row-${i}`} flexDirection="row">
              <Text>{i + 1}. </Text>
              {Input ? (
                item.kind === 'hold' ? (
                  <Input key={`edit-${i}`} value={formatDuration(item.ms)} submitLabel="save"
                    onSubmit={(v: string) => {
                      if (!v.trim()) return void dropAt($, i)
                      const ms = parseDuration(v)
                      if (ms === undefined) $.ui.toast(holdRefusal(v))
                      else void changeHold($, i, ms)
                    }} />
                ) : (
                  <Input key={`edit-${i}`} value={textOf(item)} submitLabel="save"
                    onSubmit={(v: string) => { if (!refuse($, v)) void edit($, i, v) }} />
                )
              ) : (
                <Text>{textOf(item)}</Text>
              )}
              <Text> </Text>
              <Button key={`up-${i}`} label="↑" plain dimColor onPress={() => move($, i, -1)} />
              <Text> </Text>
              <Button key={`down-${i}`} label="↓" plain dimColor onPress={() => move($, i, 1)} />
              <Text> </Text>
              {item.kind === 'hold' ? <Text dimColor> </Text> : (
                <Button key={`run-${i}`} label="▶" plain dimColor
                  onPress={() => void runAt($, i, item)} />
              )}
              <Text> </Text>
              <Button key={`rm-${i}`} label="✕" plain dimColor onPress={() => void dropAt($, i)} />
            </Box>
          ))}
        </Box>
        <Text dimColor>Edit an entry and press Enter to save; empty removes it. A leading / runs as a command. ▶ sends it now; holds start on their own.</Text>
      </Box>
    )
  })
}
