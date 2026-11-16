/**
 * A parked entry: plain text, a slash command run as if typed, or a hold that
 * gates everything after it for `ms` (and is counting down from `until`, when
 * auto has reached it).
 */
export type QueueItem =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; command: string; args: string }
  | { kind: 'hold'; ms: number; until?: number }

export type QueueItems = QueueItem[]

declare module 'claude-code' {
  interface PluginState {
    'prompt-queue': {
      items: Shaped<QueueItems>
      auto: boolean
      initialized: boolean
      waiting: string[]
      busy: boolean
      sending: boolean
    }
  }
}
