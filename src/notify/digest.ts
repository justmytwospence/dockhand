import { loadPolicy, env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from './index.ts'

/**
 * One notification per batch, not one per thing dockhand did.
 *
 * The split this rests on is between two kinds of message, and it is deliberately not
 * configurable:
 *
 *   **Alerts** — a deploy failed, a service came up unhealthy, sync is stuck, a rebase
 *   conflicted. Something is wrong *now* and waiting until morning makes it worse. These
 *   always send immediately, whatever the digest settings say, so turning digests on can
 *   never cause a failure to be missed. That guarantee is worth more than the flexibility
 *   of being able to batch them.
 *
 *   **Routine** — a pull request opened, one merged, a deploy succeeded, a verdict held
 *   something back, config changes were drafted. Each is a fact worth knowing and none is
 *   worth interrupting for. Individually they are a stream of pushes nobody reads; a
 *   dozen of them in one message is a morning summary. These are what batch.
 *
 * Items are recorded at the moment they happen and rendered when the digest fires, so a
 * restart in between loses nothing. Nothing is sent when nothing happened -- a daily
 * "0 things" push is how a person learns to ignore the channel.
 */

export type Category = 'opened' | 'merged' | 'deployed' | 'held' | 'drafted'

export interface DigestItem {
  category: Category
  summary: string
  stack?: string
  service?: string
  detail?: string
  url?: string
}

/**
 * Headings, in the order an update travels. Reading the digest top to bottom then tells
 * the same story as the pipeline: what appeared, what landed, what is waiting on you.
 */
const SECTIONS: { category: Category; heading: (n: number) => string }[] = [
  { category: 'opened', heading: (n) => `${n} pull request${s(n)} opened` },
  { category: 'merged', heading: (n) => `${n} merged` },
  { category: 'deployed', heading: (n) => `${n} deployed` },
  { category: 'drafted', heading: (n) => `${n} carried drafted config changes` },
  { category: 'held', heading: (n) => `${n} waiting on you` },
]

const s = (n: number) => (n === 1 ? '' : 's')

/** Beyond this per section the digest stops being readable and starts being a log. */
const MAX_PER_SECTION = 12

/**
 * Record something routine.
 *
 * In `immediate` mode it also sends straight away, which is the old behaviour and stays
 * available -- some people want the stream. In `off` nothing is recorded at all, so the
 * table does not grow forever collecting messages that will never be sent.
 */
export async function routine(item: DigestItem): Promise<void> {
  const { policy } = loadPolicy()
  if (policy.notify.routine === 'off') return

  getDb()
    .prepare(
      `INSERT INTO digest_items (at, category, stack, service, summary, detail, url, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      item.category,
      item.stack ?? null,
      item.service ?? null,
      item.summary,
      item.detail ?? null,
      item.url ?? null,
      // Immediate mode marks it sent as it writes it, so a later flush cannot repeat it.
      policy.notify.routine === 'immediate' ? new Date().toISOString() : null,
    )

  if (policy.notify.routine === 'immediate') {
    await notify({
      title: `dockhand: ${item.summary}`,
      body: item.detail ?? item.summary,
      tags: ['package'],
      click: item.url,
    })
  }
}

interface Row {
  id: number
  at: string
  category: Category
  stack: string | null
  service: string | null
  summary: string
  detail: string | null
  url: string | null
}

export function pending(): Row[] {
  return getDb()
    .prepare(`SELECT * FROM digest_items WHERE sent_at IS NULL ORDER BY id`)
    .all() as Row[]
}

/**
 * Render the digest. Pure, and exported so the UI can show exactly what would go out.
 *
 * Returns null for an empty batch rather than an empty string, so "nothing to send" is a
 * state the caller has to handle rather than a message it might accidentally send.
 */
export function render(rows: Row[]): { title: string; body: string } | null {
  if (rows.length === 0) return null

  const parts: string[] = []
  for (const section of SECTIONS) {
    const mine = rows.filter((r) => r.category === section.category)
    if (mine.length === 0) continue
    parts.push(section.heading(mine.length))
    for (const r of mine.slice(0, MAX_PER_SECTION)) {
      const where = r.stack ? `${r.stack}${r.service ? `/${r.service}` : ''}: ` : ''
      parts.push(`  ${where}${r.summary}`)
    }
    if (mine.length > MAX_PER_SECTION) {
      parts.push(`  ...and ${mine.length - MAX_PER_SECTION} more`)
    }
    parts.push('')
  }

  // A count in the title is what makes the notification worth expanding or not.
  const title =
    rows.length === 1 ? `dockhand: ${rows[0]!.summary}` : `dockhand: ${rows.length} updates`
  return { title, body: parts.join('\n').trimEnd() }
}

export interface FlushResult {
  sent: number
  skipped?: string
}

/**
 * Send everything waiting, and mark it sent.
 *
 * Marked sent only after the transport returns, and marked regardless of whether it
 * succeeded: `notify` already swallows and logs its own failures, and a batch that
 * retried forever would eventually push a hundred-line message about a week of history.
 * A missed digest is a missed digest; the Activity page still has all of it.
 */
export async function flush(trigger: 'cron' | 'manual'): Promise<FlushResult> {
  const rows = pending()
  if (rows.length === 0) return { sent: 0, skipped: 'nothing pending' }

  const message = render(rows)
  if (!message) return { sent: 0, skipped: 'nothing pending' }

  await notify({
    ...message,
    tags: ['package'],
    click: env.githubRepo ? `https://github.com/${env.githubRepo}/pulls` : undefined,
  })

  const now = new Date().toISOString()
  const mark = getDb().prepare(`UPDATE digest_items SET sent_at = ? WHERE id = ?`)
  getDb().transaction(() => {
    for (const r of rows) mark.run(now, r.id)
  })()

  logEvent({
    level: 'info',
    kind: 'system',
    message: `digest sent: ${rows.length} item(s)`,
    detail: trigger === 'manual' ? 'sent on request' : undefined,
  })
  return { sent: rows.length }
}

/** Old sent items are history nobody reads; keep a fortnight so a digest can be re-read. */
export function prune(): void {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
  getDb().prepare(`DELETE FROM digest_items WHERE sent_at IS NOT NULL AND sent_at < ?`).run(cutoff)
}
