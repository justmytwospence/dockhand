import { env, loadPolicy } from '../config.ts'
import { logEvent } from '../db.ts'
import * as email from './email.ts'

/**
 * Delivery, and which channel gets what.
 *
 * Two kinds of message, established in digest.ts and not configurable: **alerts** are
 * things that went wrong and always go out at once; **routine** is what dockhand did as
 * intended, which batches. Orthogonal to that, each channel says what it wants to
 * receive -- so "push for what is broken, email for the morning summary" is
 * `ntfy: alerts` plus `email: routine`, and "both, everywhere" is the default.
 *
 * A channel that is not configured is skipped whatever the policy says, which is why
 * `all` is a safe default on a deployment with neither set up.
 */

export type Priority = 1 | 2 | 3 | 4 | 5

/** Whether a message is about something that went wrong, or something that went right. */
export type Kind = 'alert' | 'routine'

export interface Message {
  title: string
  body: string
  priority?: Priority
  tags?: string[]
  click?: string
  /** Defaults to `alert` -- the conservative choice, since alerts reach every channel. */
  kind?: Kind
  /** Richer body for channels that can render one. Ignored by ntfy. */
  html?: string
}

/** Does a channel set to `mode` want a message of this kind? */
export function wants(mode: 'all' | 'alerts' | 'routine' | 'off', kind: Kind): boolean {
  if (mode === 'off') return false
  if (mode === 'all') return true
  return mode === (kind === 'alert' ? 'alerts' : 'routine')
}

export async function notify(opts: Message): Promise<void> {
  const { policy } = loadPolicy()
  const kind = opts.kind ?? 'alert'

  // Sent in parallel and awaited together: a slow SMTP server should not delay the push,
  // and neither failing should stop the other. Both swallow their own errors.
  await Promise.all([
    wants(policy.notify.ntfy, kind) ? sendNtfy(opts) : undefined,
    wants(policy.notify.email, kind) && email.configured() ? sendEmail(opts) : undefined,
  ])
}

/**
 * ntfy push. The server is deny-all, so the topic needs an explicit grant:
 *   docker exec ntfy ntfy access <user> container-updates write
 *
 * Metadata travels as HTTP headers, which must be ASCII -- a stray em dash in a title
 * gets the whole request rejected, so titles are transliterated.
 */
async function sendNtfy(opts: Message): Promise<void> {
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

async function sendEmail(opts: Message): Promise<void> {
  await email.send({
    subject: opts.title,
    // The click target is a header on ntfy and has nowhere else to live in a plain-text
    // mail, so it goes at the end where a signature would.
    text: opts.click ? `${opts.body}\n\n${opts.click}` : opts.body,
    html: opts.html,
  })
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

export async function notifyOnce(
  channel: string,
  reason: string,
  opts: Message,
): Promise<void> {
  if (lastReason.get(channel) === reason) return
  lastReason.set(channel, reason)
  await notify(opts)
}

/** Clear the dedupe memory when a channel returns to normal. */
export function clearNotifyState(channel: string): void {
  lastReason.delete(channel)
}

/** Which channels would actually receive a message of this kind, for the UI. */
export function activeChannels(kind: Kind): string[] {
  const { policy } = loadPolicy()
  const out: string[] = []
  if (env.ntfyToken && wants(policy.notify.ntfy, kind)) out.push('ntfy')
  if (email.configured() && wants(policy.notify.email, kind)) out.push('email')
  return out
}
