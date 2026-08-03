import { env } from '../config.ts'
import { logEvent } from '../db.ts'

/**
 * ntfy push. The server is deny-all, so the topic needs an explicit grant:
 *   docker exec ntfy ntfy access <user> container-updates write
 *
 * Metadata travels as HTTP headers, which must be ASCII -- a stray em dash in a title
 * gets the whole request rejected, so titles are transliterated.
 */

export type Priority = 1 | 2 | 3 | 4 | 5

export async function notify(opts: {
  title: string
  body: string
  priority?: Priority
  tags?: string[]
  click?: string
}): Promise<void> {
  if (!env.ntfyToken) return
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${env.ntfyToken}`,
      title: ascii(opts.title),
      priority: String(opts.priority ?? 3),
    }
    if (opts.tags?.length) headers.tags = ascii(opts.tags.join(','))
    if (opts.click) headers.click = opts.click

    const res = await fetch(`${env.ntfyUrl}/${env.ntfyTopic}`, {
      method: 'POST',
      headers,
      body: opts.body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      logEvent({
        level: 'warn',
        kind: 'system',
        message: 'ntfy rejected a notification',
        detail: `${res.status} ${await res.text().catch(() => '')}`.slice(0, 200),
      })
    }
  } catch (err) {
    // A missed notification must never break the operation that triggered it.
    logEvent({
      level: 'warn',
      kind: 'system',
      message: 'ntfy unreachable',
      detail: (err as Error).message,
    })
  }
}

function ascii(s: string): string {
  return s
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e]/g, '')
}

/**
 * Notify once per distinct reason. The sync loop can refuse on every cycle for the same
 * cause; the first one is information and the rest are noise.
 */
const lastReason = new Map<string, string>()

export async function notifyOnce(channel: string, reason: string, opts: {
  title: string
  body: string
  priority?: Priority
  tags?: string[]
}): Promise<void> {
  if (lastReason.get(channel) === reason) return
  lastReason.set(channel, reason)
  await notify(opts)
}

/** Clear the dedupe memory when a channel returns to normal. */
export function clearNotifyState(channel: string): void {
  lastReason.delete(channel)
}
