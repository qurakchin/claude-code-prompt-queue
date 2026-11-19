import { test, expect, mock } from 'claude-code/testing'

// A test registers its hooks before its first call on $, which loads the plugin:
// these two stand for the engine beneath it, and raise the session's start.
const start = async ($: any, on: any) => {
  on('command.register', (_: any, e: any) => ({ value: e.name }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('parks prompts and sends one on run', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'first task' })
  await $.command.run({ command: 'queue', args: 'second task' })
  expect(sent).toEqual([])

  const list = await $.command.run({ command: 'queue', args: 'list' })
  expect(list.text).toBe('1. first task\n2. second task')

  await $.command.run({ command: 'queue', args: 'run' })
  await clock.advance(1)
  expect(sent).toEqual(['first task'])

  await $.command.run({ command: 'queue', args: 'drop 1' })
  await $.command.run({ command: 'queue', args: 'list the files' })
  const parked = await $.command.run({ command: 'queue', args: 'list' })
  expect(parked.text).toBe('1. list the files')
  await $.command.run({ command: 'queue', args: 'clear' })
  const empty = await $.command.run({ command: 'queue', args: 'list' })
  expect(empty.text).toBe('Queue is empty.')
})

test('a leading slash parks a command and runs it as a command', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  const ran: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('command.run', { command: 'review-pr' }, ($, e) => {
    ran.push(e.args)
    return { text: 'reviewed' }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: '/review-pr 123' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(ran).toEqual(['123'])
  expect(sent).toEqual([])

  await $.turn.start({ turnId: 't' } as never)
  await $.command.run({ command: 'queue', args: '/review-pr 456' })
  const list = await $.command.run({ command: 'queue', args: 'list' })
  expect(list.text).toBe('1. /review-pr 456')

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(1)
  expect(ran).toEqual(['123', '456'])
  expect(sent).toEqual([])
})

test('a command that starts no turn lets the queue move on', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[] = []
  on('command.run', { command: 'ping' }, () => {
    ran.push('ping')
    return { text: 'pong' }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: '/ping' })
  await $.command.run({ command: 'queue', args: '/ping' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  await clock.advance(1000)
  expect(ran).toEqual(['ping', 'ping'])
})

test('a command whose turn starts after it resolves keeps the next entry back', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  const ran: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', { command: 'review-pr' }, ($, e) => {
    ran.push(e.args)
    return { text: 'reviewed' }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: '/review-pr 123' })
  await $.command.run({ command: 'queue', args: 'fix tests' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(ran).toEqual(['123'])
  expect(sent).toEqual([])

  // The engine raises the command's turn only after command.run resolved.
  await $.turn.start({ turnId: 't' } as never)
  await clock.advance(1000)
  expect(sent).toEqual([])

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(1)
  expect(sent).toEqual(['fix tests'])
})

test('auto sends all prompts one by one and stays on', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  await start($, on)
  for (const t of ['a', 'b', 'c']) await $.command.run({ command: 'queue', args: t })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  await endTurn()
  await clock.advance(1)
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a', 'b', 'c'])

  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a', 'b', 'c'])
  await $.command.run({ command: 'queue', args: 'd' })
  await clock.advance(1)
  expect(sent).toEqual(['a', 'b', 'c', 'd'])
})

test('hold reads plain durations and refuses anything else', async ($, on) => {
  await start($, on)
  const cases: [string, string][] = [
    ['1h', '1h'],
    ['1hour', '1h'],
    ['1 h', '1h'],
    ['1 min', '1m'],
    ['1s', '1s'],
    ['0.5h', '30m'],
    ['90m', '1h30m'],
    ['1h30m', '1h30m'],
  ]
  for (const [i, [arg, shown]] of cases.entries()) {
    const out = await $.command.run({ command: 'queue', args: `hold ${arg}` })
    expect(out.text).toBe(`Queued #${i + 1}: hold ${shown}.`)
  }

  const bad = await $.command.run({ command: 'queue', args: 'hold 1x' })
  expect(bad.text).toBe('"1x" is not a duration. Use a duration like 30m, 1h, 0.5h, 1 hour or 1h30m.')
  const empty = await $.command.run({ command: 'queue', args: 'hold' })
  expect(empty.text).toBe('hold needs a duration. Use a duration like 30m, 1h, 0.5h, 1 hour or 1h30m.')
  for (const junk of ['1', '-1h', '0h', '1h junk', '1hh', '1.5x']) {
    const out = await $.command.run({ command: 'queue', args: `hold ${junk}` })
    expect(out.text).toContain(`"${junk}" is not a duration.`)
  }

  // Nothing refused was parked.
  expect((await $.command.run({ command: 'queue', args: 'list' })).text.split('\n')).toHaveLength(cases.length)
})

test('auto sends a and c with an hour between them', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>core</Text>
  })
  const band = async (text: RegExp) => {
    const h = await $.ui.mount({ plugin: 'prompt-queue', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as any)
    const found = await h.find({ type: 'Text', text })
    await h.unmount()
    return !!found
  }
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  await start($, on)
  for (const args of ['a', 'hold 1h', 'c']) await $.command.run({ command: 'queue', args })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  // a ended: the hold starts its hour instead of anything being sent.
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a'])
  expect(await band(/hold until \d\d:\d\d/)).toBe(true)
  const status = await $.command.run({ command: 'queue', args: 'status' })
  expect(status.text).toMatch(/1\. hold 1h · until \d\d:\d\d · 1h left/)
  expect((await $.command.run({ command: 'queue', args: 'list' })).text).toBe('1. hold 1h\n2. c')

  await clock.advance(3600000 - 2)
  expect(sent).toEqual(['a'])
  await clock.advance(2)
  await clock.advance(1)
  expect(sent).toEqual(['a', 'c'])
})

test('dropping the hold lets what follows go', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  await start($, on)
  for (const args of ['a', 'hold 1h', 'c']) await $.command.run({ command: 'queue', args })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  const dropped = await $.command.run({ command: 'queue', args: 'drop 1' })
  expect(dropped.text).toBe('Dropped: hold 1h')
  await clock.advance(1)
  expect(sent).toEqual(['a', 'c'])
})

test('unblock clears background jobs and holds alike', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'hold 30m' })
  await $.command.run({ command: 'queue', args: 'after' })
  await $.command.run({ command: 'queue', args: 'auto' })
  expect((await $.command.run({ command: 'queue', args: 'list' })).text).toBe('1. hold 30m\n2. after')

  const out = await $.command.run({ command: 'queue', args: 'unblock' })
  expect(out.text).toBe('Stopped waiting on background jobs and holds.')
  await clock.advance(1)
  expect(sent).toEqual(['after'])
})

test('run refuses a hold, which sends nothing', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'queue', args: 'hold 30m' })
  const out = await $.command.run({ command: 'queue', args: 'run 1' })
  expect(out.text).toBe('hold 30m sends nothing; it starts when auto reaches it. /queue drop 1 removes it.')
  expect((await $.command.run({ command: 'queue', args: 'list' })).text).toBe('1. hold 30m')
})

test('a reload re-arms the hold clock instead of restarting it', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  const reload = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await start($, on)
  for (const args of ['a', 'hold 1h', 'c']) await $.command.run({ command: 'queue', args })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  // Ten minutes in, the plugin reloads; the hold keeps the time it had left.
  // t=2 then +600000 -> 600002; the hold ends at 3600001.
  await clock.advance(600000)
  await reload()
  await clock.advance(2999998)
  expect(sent).toEqual(['a'])
  await clock.advance(1)
  await clock.advance(1)
  expect(sent).toEqual(['a', 'c'])
})

test('panel edits a hold by its duration and refuses a bad one', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($, on)
  await $.command.run({ command: 'queue', args: 'hold 1h' })
  await $.command.run({ command: 'queue', args: '' })
  const ui = await $.ui.mount({ plugin: 'prompt-queue', surface: 'terminal', component: 'Pane', requestId: 'queue',
    props: { title: 'Queue', isFocused: true, bodyColumns: 100, placement: 'dock' } } as any)
  const list = async () => (await $.command.run({ command: 'queue', args: 'list' })).text

  await ui.input({ key: 'edit-0', text: '2h' })
  expect(await list()).toBe('1. hold 2h')
  await ui.input({ key: 'edit-0', text: 'nope' })
  expect(toasts).toEqual(['"nope" is not a duration. Use a duration like 30m, 1h, 0.5h, 1 hour or 1h30m.'])
  expect(await list()).toBe('1. hold 2h')
  await ui.input({ key: 'edit-0', text: '' })
  expect(await list()).toBe('Queue is empty.')

  // Adding "hold 30m" in the panel parks the same entry the command does.
  await ui.input({ key: 'new', text: 'hold 30m' })
  expect(await list()).toBe('1. hold 30m')
  await ui.input({ key: 'new', text: 'hold nope' })
  expect(toasts.at(-1)).toBe('"nope" is not a duration. Use a duration like 30m, 1h, 0.5h, 1 hour or 1h30m.')
  expect(await list()).toBe('1. hold 30m')
  await ui.unmount()
})

test('toggling auto on mid-task waits for the task to end', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.turn.start({ turnId: 't' } as never)
  await $.command.run({ command: 'queue', args: 'a' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual([])

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  const off = await $.command.run({ command: 'queue', args: 'auto' })
  expect(off.text).toBe('Queue auto is off (session).')
})

test('the auto setting starts the session', { options: { autoMode: 'session-true' } }, async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'go' })
  await clock.advance(1)
  expect(sent).toEqual(['go'])
})

test('session auto keeps the toggle in the session', { options: { autoMode: 'session-true' } }, async ($, on) => {
  const clock = mock.clock(on)
  const saved: string[] = []
  const sent: string[] = []
  on('config.set', ($, e) => {
    saved.push(`${e.key}=${e.value}`)
    return { value: e.value }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  const off = await $.command.run({ command: 'queue', args: 'auto' })
  expect(off.text).toBe('Queue auto is off (session).')
  expect(saved).toEqual([])

  await $.command.run({ command: 'queue', args: 'a' })
  const turnedOn = await $.command.run({ command: 'queue', args: 'auto' })
  expect(turnedOn.text).toBe('Queue auto is on (session).')
  await clock.advance(1)
  expect(sent).toEqual(['a'])
  expect(saved).toEqual([])
})

test('global auto writes the choice back to settings', { options: { autoMode: 'global-false' } }, async ($, on) => {
  const saved: string[] = []
  on('config.set', ($, e) => {
    saved.push(`${e.key}=${e.value}`)
    return { value: e.value }
  })

  await start($, on)
  const turnedOn = await $.command.run({ command: 'queue', args: 'auto' })
  expect(turnedOn.text).toBe('Queue auto is on (global).')
  expect(saved).toEqual(['prompt-queue.autoMode=global-true'])

  const turnedOff = await $.command.run({ command: 'queue', args: 'auto' })
  expect(turnedOff.text).toBe('Queue auto is off (global).')
  expect(saved).toEqual(['prompt-queue.autoMode=global-true', 'prompt-queue.autoMode=global-false'])
})

test('a global toggle sends what is parked once the choice is saved', { options: { autoMode: 'global-false' } }, async ($, on) => {
  const clock = mock.clock(on)
  const order: string[] = []
  const sent: string[] = []
  on('config.set', ($, e) => {
    order.push('save')
    return { value: e.value }
  })
  on('prompt.submit', ($, e) => {
    order.push('send')
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'a' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(order).toEqual(['save', 'send'])
  expect(sent).toEqual(['a'])
})

test('a setting that cannot be saved leaves the toggle to the session', { options: { autoMode: 'global-true' } }, async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const sent: string[] = []
  let how: 'throw' | 'deny' = 'throw'
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('config.set', () => {
    if (how === 'throw') throw new Error('not saved')
    return { deny: 'locked' }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  const off = await $.command.run({ command: 'queue', args: 'auto' })
  expect(off.text).toBe('Queue auto is off (global).')

  await $.command.run({ command: 'queue', args: 'a' })
  how = 'deny'
  const back = await $.command.run({ command: 'queue', args: 'auto' })
  expect(back.text).toBe('Queue auto is on (global).')
  expect(toasts).toEqual([
    'Auto changed for this session only: the setting could not be saved.',
    'Auto changed for this session only: the setting could not be saved.',
  ])
  // A denied write saved nothing, so this send is the only one on its way.
  await clock.advance(1)
  expect(sent).toEqual(['a'])
})

test('only /queue is registered without an alias setting', async ($, on) => {
  const names: string[] = []
  on('command.register', (_: any, e: any) => {
    names.push(e.name)
    return { value: e.name }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(names).toEqual(['queue'])
})

test('aliases move subcommands to /queue words or top-level commands', { options: { aliases: 'list=ls, status=/qs' } }, async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'one' })
  const listed = await $.command.run({ command: 'queue', args: 'ls' })
  expect(listed.text).toBe('1. one')

  const status = await $.command.run({ command: 'qs', args: '' })
  expect(status.text).toBe('1 queued · auto off (session)\n1. one')

  // Turning auto on sends what is parked.
  const toggled = await $.command.run({ command: 'queue', args: 'auto' })
  expect(toggled.text).toBe('Queue auto is on (session).')
  await clock.advance(1)
  expect(sent).toEqual(['one'])
})

test('a taken alias says so and leaves its name to its owner', { options: { aliases: 'status=/qs' } }, async ($, on) => {
  const toasts: string[] = []
  const answered: string[] = []
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_: any, e: any) => {
    if (e.name === 'qs') throw new Error('name taken')
    return { value: e.name }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', { command: 'qs' }, () => {
    answered.push('owner')
    return { text: 'owner answer' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts).toEqual(['/qs is taken; that alias is off for this session.'])

  const out = await $.command.run({ command: 'qs', args: '' })
  expect(out.text).toBe('owner answer')
  expect(answered).toEqual(['owner'])
})

test('an alias refuses arguments the subcommand does not take', { options: { aliases: 'run=/qr' } }, async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'queue', args: 'a' })

  const junk = await $.command.run({ command: 'qr', args: '1 junk' })
  expect(junk.text).toBe('No entry 1 junk. Queue has 1.')
  const one = await $.command.run({ command: 'qr', args: '1' })
  expect(one.text).toBe('Sending: a')
})

test('help lists the aliases', { options: { aliases: 'list=ls, status=/qs' } }, async ($, on) => {
  await start($, on)
  const help = (await $.command.run({ command: 'queue', args: 'help' })).text
  expect(help).toContain('/queue ls')
  expect(help).toContain('/qs')
  expect(help).not.toContain('/queue-auto')
})

test('auto waits for background jobs before the next prompt', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({
    result: { stdout: '' },
    text: 'Command running in background with ID: b123. Output is being written to: /x',
  }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  await start($, on)
  for (const t of ['a', 'b']) await $.command.run({ command: 'queue', args: t })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  await $.tool.call({ tool: 'Bash', command: 'sleep 10', run_in_background: true })
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  await $.prompt.submit({
    text: '<task-notification><task-id>b123</task-id><status>completed</status></task-notification>',
    origin: { kind: 'task-notification' },
  })
  await endTurn()
  await clock.advance(1)
  expect(sent.at(-1)).toBe('b')
})

test('a job notice delivered into a running turn frees the queue', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.attachment', (_: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({
    result: { stdout: '' },
    text: 'Command running in background with ID: b123. Output is being written to: /x',
  }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  await start($, on)
  for (const t of ['a', 'b']) await $.command.run({ command: 'queue', args: t })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  await $.tool.call({ tool: 'Bash', command: 'sleep 10', run_in_background: true })
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual(['a'])

  // A notice that arrives mid-turn rides on the turn as a queued command, so
  // prompt.submit never sees it.
  await $.prompt.attachment({
    type: 'queued_command',
    text: '<task-notification><task-id>b123</task-id><status>completed</status></task-notification>',
    origin: { kind: 'engine' },
  } as never)
  await endTurn()
  await clock.advance(1)
  expect(sent.at(-1)).toBe('b')
})

test('tool output that only quotes job words is not a job', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({
    result: { stdout: '' },
    text: 'agentId: abc and running in background with ID: b9. here',
  }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'auto' })
  await $.tool.call({ tool: 'Bash', command: 'cat notes.txt' })
  await $.command.run({ command: 'queue', args: 'a' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])
})

test('a prompt queued mid-task waits for the task to end', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.turn.start({ turnId: 't' } as never)
  await $.command.run({ command: 'queue', args: 'auto' })
  await $.command.run({ command: 'queue', args: 'a' })
  await clock.advance(1)
  expect(sent).toEqual([])
})

test('a failed send keeps the prompt and stops auto', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  const toasts: string[] = []
  let refuse = true
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    if (refuse) throw new Error('submit refused')
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'a' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  const kept = await $.command.run({ command: 'queue', args: 'list' })
  expect(kept.text).toBe('1. a')
  expect(toasts).toEqual(['Queue paused: could not send "a". /queue auto resumes.'])

  // Auto stopped on its own; turning it back on sends what was kept.
  refuse = false
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])
})

test('a prompt a hook drops stays in the queue and stops auto', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  const sent: string[] = []
  let dropped = true
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    if (dropped) return { drop: 'blocked by policy' }
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'a' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  // A drop starts no turn, so the send has to clear its own flags.
  expect(toasts).toEqual(['Queue paused: could not send "a": blocked by policy. /queue auto resumes.'])
  expect((await $.command.run({ command: 'queue', args: 'list' })).text).toBe('1. a')

  dropped = false
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(sent).toEqual(['a'])
  expect((await $.command.run({ command: 'queue', args: 'list' })).text).toBe('Queue is empty.')
})

test('a command that cannot run leaves the queue and the next prompt goes', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  const toasts: string[] = []
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.run', { command: 'bad-command' }, () => {
    throw new Error('unknown command')
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await start($, on)
  await $.command.run({ command: 'queue', args: '/bad-command' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await clock.advance(1)
  expect(toasts).toEqual(['Could not run "/bad-command". It was removed from the queue.'])
  const empty = await $.command.run({ command: 'queue', args: 'list' })
  expect(empty.text).toBe('Queue is empty.')

  await $.command.run({ command: 'queue', args: '你好' })
  await clock.advance(1)
  expect(sent).toEqual(['你好'])
})

test('a leading slash that names no command is refused when queued', async ($, on) => {
  const out = await $.command.run({ command: 'queue', args: '/Users/me/x.md 看一下这个文件' })
  expect(out.text).toBe('/Users/me/x.md is not a command name, and a prompt cannot start with "/".')
  const bare = await $.command.run({ command: 'queue', args: '/' })
  expect(bare.text).toBe('/ is not a command name, and a prompt cannot start with "/".')
  const list = await $.command.run({ command: 'queue', args: 'list' })
  expect(list.text).toBe('Queue is empty.')
})

test('auto clears agents whose end arrives in another session message', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  let agent = 0
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: '' }, text: `Async agent launched. agentId: a${++agent} (internal ID)` }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const endTurn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  await start($, on)
  await $.command.run({ command: 'queue', args: 'next' })
  await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'one' })
  await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'two' })
  await $.command.run({ command: 'queue', args: 'auto' })
  await endTurn()
  await clock.advance(1)
  expect(sent).toEqual([])

  // A typed prompt that quotes a notice clears nothing.
  await $.prompt.submit({
    text: '<agent-message from="a1">\n  [Subagent hand-back] report',
    origin: { kind: 'composer' },
  })
  await $.prompt.submit({
    text: '<agent-message from="a1">\n  [Subagent hand-back] report\n</agent-message>\n<task-notification><task-id>a2</task-id><status>completed</status></task-notification>',
    origin: { kind: 'peer' },
  })
  await endTurn()
  await clock.advance(1)
  expect(sent.at(-1)).toBe('next')
})

test('panel edits, reorders, runs and removes; state shows above the prompt', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>core</Text>
  })
  const band = async (text: RegExp) => {
    const h = await $.ui.mount({ plugin: 'prompt-queue', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as any)
    const found = await h.find({ type: 'Text', text })
    await h.unmount()
    return !!found
  }
  const list = async () => (await $.command.run({ command: 'queue', args: 'list' })).text

  expect(await band(/queued/)).toBe(false)
  for (const t of ['a', 'b', 'c']) await $.command.run({ command: 'queue', args: t })
  expect((await $.command.run({ command: 'queue', args: '' })).text).toBe('Queue panel opened.')
  expect(await band(/^a$/)).toBe(true)
  expect(await band(/^c$/)).toBe(true)

  const ui = await $.ui.mount({ plugin: 'prompt-queue', surface: 'terminal', component: 'Pane', requestId: 'queue',
    props: { title: 'Queue', isFocused: true, bodyColumns: 100, placement: 'dock' } } as any)
  await ui.press({ key: 'down-0' })
  expect(await list()).toBe('1. b\n2. a\n3. c')
  await ui.input({ key: 'edit-1', text: 'a2' })
  await ui.input({ key: 'new', text: 'd' })
  expect(await list()).toBe('1. b\n2. a2\n3. c\n4. d')
  await ui.press({ key: 'rm-2' })
  await ui.press({ key: 'run-0' })
  await clock.advance(1)
  expect(sent).toEqual(['b'])
  expect(await list()).toBe('1. a2\n2. d')
  await ui.input({ key: 'edit-0', text: '' })
  expect(await list()).toBe('1. d')
  expect(await band(/^d$/)).toBe(true)
  await ui.unmount()
})

test('/queue run sends the next entry', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await start($, on)
  for (const t of ['a', 'b']) await $.command.run({ command: 'queue', args: t })
  expect((await $.command.run({ command: 'queue', args: 'run' })).text).toBe('Sending: a')
  await clock.advance(1)
  expect(sent).toEqual(['a'])
  expect((await $.command.run({ command: 'queue', args: 'list' })).text).toBe('1. b')
  expect((await $.command.run({ command: 'queue', args: 'run 9' })).text).toBe('No entry 9. Queue has 1.')
})

test('the band draws nothing with auto on and the queue empty', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>core</Text>
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const band = async (text: RegExp) => {
    const h = await $.ui.mount({ plugin: 'prompt-queue', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as any)
    const found = await h.find({ type: 'Text', text })
    await h.unmount()
    return !!found
  }

  await start($, on)
  await $.command.run({ command: 'queue', args: 'auto' })
  expect(await band(/auto/)).toBe(false)

  await $.turn.start({ turnId: 't' } as never)
  await $.command.run({ command: 'queue', args: 'a' })
  expect(await band(/auto/)).toBe(true)
})

test('commands carry the argument hint the typeahead shows', { options: { aliases: 'run=/qr' } }, async ($, on) => {
  const hints: Record<string, string | undefined> = {}
  on('command.register', (_: any, e: any) => {
    hints[e.name] = e.argumentHint
    return { value: e.name }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(hints.queue).toBe('[text | /command | help|list|status|run|drop|clear|unblock|auto|hold]')
  expect(hints.qr).toBe('[n]')
  expect(hints['queue-auto']).toBeUndefined()
})

test('status prints the queue without the panel', async ($, on) => {
  await start($, on)
  for (const t of ['a', '/review-pr 2']) await $.command.run({ command: 'queue', args: t })
  const status = await $.command.run({ command: 'queue', args: 'status' })
  expect(status.text).toBe('2 queued · auto off (session)\n1. a\n2. /review-pr 2')
})

test('the panel refuses a leading slash that names no command', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($, on)
  await $.command.run({ command: 'queue', args: 'keep' })
  await $.command.run({ command: 'queue', args: '' })
  const ui = await $.ui.mount({ plugin: 'prompt-queue', surface: 'terminal', component: 'Pane', requestId: 'queue',
    props: { title: 'Queue', isFocused: true, bodyColumns: 100, placement: 'dock' } } as any)
  const list = async () => (await $.command.run({ command: 'queue', args: 'list' })).text
  const refused = '/Users/me/x.md is not a command name, and a prompt cannot start with "/".'

  await ui.input({ key: 'new', text: '/Users/me/x.md look at this' })
  expect(toasts).toEqual([refused])
  expect(await list()).toBe('1. keep')

  await ui.input({ key: 'edit-0', text: '/Users/me/x.md' })
  expect(toasts).toEqual([refused, refused])
  expect(await list()).toBe('1. keep')
  await ui.unmount()
})
