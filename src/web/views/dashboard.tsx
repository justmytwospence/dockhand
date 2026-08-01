import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import type { ScannedService } from '../../compose/scan.ts'
import { Layout, Banner, Empty, Table } from './layout.tsx'

export interface PendingRow {
  id: number
  stack: string
  service: string
  image: string
  from_tag: string
  to_tag: string
  magnitude: string
  tier: string
  state: string
  detail: string | null
}

export interface ScanInfo {
  lastAt: string | null
  durationS: number | null
  counts: Record<string, number> | null
  running: boolean
}

const MAGNITUDE_CLASS: Record<string, string> = {
  major: 'err',
  minor: 'warn',
  patch: 'muted',
  digest: 'muted',
}

export const Dashboard: FC<{
  policy: Policy
  policyError?: string
  services: ScannedService[]
  pending: PendingRow[]
  recent: Record<string, unknown>[]
  blackout: boolean
  scan: ScanInfo
}> = ({ policyError, services, pending, recent, blackout, scan }) => {
  const watched = services.filter((s) => s.watched)
  const unwatchable = services.filter((s) => s.unwatchable)

  const rolling = pending.filter((p) => p.detail === 'rolling')
  const held = pending.filter((p) => p.state === 'held')
  const review = pending.filter(
    (p) => p.detail !== 'rolling' && p.state !== 'held' && p.tier !== 'auto',
  )
  const auto = pending.filter(
    (p) => p.detail !== 'rolling' && p.state !== 'held' && p.tier === 'auto',
  )

  return (
    <Layout title="Dashboard" path="/">
      {policyError && <Banner kind="error">{policyError}</Banner>}
      {blackout && (
        <Banner kind="info">
          Inside a blackout window &mdash; git and deploy operations are queued, not dropped.
        </Banner>
      )}

      <section class="tiles">
        <div class="tile">
          <span class="num">{pending.length}</span>
          <span class="lbl">pending</span>
        </div>
        <div class="tile">
          <span class="num">{watched.length}</span>
          <span class="lbl">watched</span>
        </div>
        <div class="tile">
          <span class="num">{unwatchable.length}</span>
          <span class="lbl">not watchable</span>
        </div>
        <div class="tile">
          <span class="num">{services.length}</span>
          <span class="lbl">services</span>
        </div>
      </section>

      <div class="scanbar">
        <button hx-post="/scan" hx-target="#scan-status" hx-swap="innerHTML">
          Scan now
        </button>
        <span id="scan-status" hx-get="/scan/status" hx-trigger="load, every 10s">
          <ScanStatus scan={scan} />
        </span>
      </div>

      <Section
        title="Needs review"
        caption="Majors, gated infrastructure, and anything else a human merges."
        rows={review}
        empty="Nothing waiting on you."
      />

      <Section
        title="Held"
        caption="Datastores. A tag bump alone cannot apply these — a postgres major refuses the old datadir — so each is a deliberate migration. Open a PR when you are ready to do one."
        rows={held}
        empty="No held updates."
        action="open-pr"
      />

      <Section
        title="Rolling tags moved"
        caption="The tag still points somewhere new. Nothing to change in git; redeploy to adopt."
        rows={rolling}
        empty="No rolling images have moved."
        action="dismiss"
      />

      <Section
        title="Auto tier"
        caption="WUD applies these itself overnight while both tools run; rows clear themselves once it does."
        rows={auto}
        empty="Nothing queued."
      />

      <h2>Recent activity</h2>
      {recent.length === 0 ? (
        <Empty>Nothing logged yet.</Empty>
      ) : (
        <Table>
          <tbody>
            {recent.map((r) => (
              <tr>
                <td class="mono nowrap">{String(r.at).replace('T', ' ').slice(0, 19)}</td>
                <td>{String(r.kind)}</td>
                <td>{String(r.message)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Layout>
  )
}

const Section: FC<{
  title: string
  caption: string
  rows: PendingRow[]
  empty: string
  action?: 'open-pr' | 'dismiss'
}> = ({ title, caption, rows, empty, action }) => (
  <>
    <h2>
      {title} {rows.length > 0 && <span class="count">{rows.length}</span>}
    </h2>
    <p class="sub">{caption}</p>
    {rows.length === 0 ? (
      <Empty>{empty}</Empty>
    ) : (
      <Table>
        <thead>
          <tr>
            <th>Stack</th>
            <th>Service</th>
            <th>Change</th>
            <th>Kind</th>
            {action && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>{r.stack}</td>
              <td>{r.service}</td>
              <td class="mono">
                {shorten(r.from_tag)} &rarr; {shorten(r.to_tag)}
              </td>
              <td>
                <span class={`pill ${MAGNITUDE_CLASS[r.magnitude] ?? 'muted'}`}>{r.magnitude}</span>
              </td>
              {action && (
                <td>
                  {action === 'open-pr' ? (
                    <button
                      class="linkish"
                      hx-post={`/updates/${r.id}/open-pr`}
                      hx-target="closest tr"
                      hx-swap="outerHTML"
                    >
                      Open PR
                    </button>
                  ) : (
                    <button
                      class="linkish"
                      hx-post={`/updates/${r.id}/dismiss`}
                      hx-target="closest tr"
                      hx-swap="outerHTML"
                    >
                      Dismiss
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    )}
  </>
)

export const ScanStatus: FC<{ scan: ScanInfo }> = ({ scan }) => {
  if (scan.running) return <span class="sub">scanning&hellip;</span>
  if (!scan.lastAt) return <span class="sub">never scanned</span>
  const counts = scan.counts
    ? Object.entries(scan.counts)
        .filter(([k]) => k !== 'unchanged' && k !== 'up-to-date')
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')
    : ''
  return (
    <span class="sub">
      last scan {ago(scan.lastAt)}
      {scan.durationS !== null ? ` in ${scan.durationS}s` : ''}
      {counts ? ` — ${counts}` : ''}
    </span>
  )
}

/** Digest refs are unreadable at full length; keep the tag and 12 hex. */
function shorten(ref: string): string {
  const at = ref.indexOf('@sha256:')
  return at === -1 ? ref : `${ref.slice(0, at)}@${ref.slice(at + 8, at + 20)}`
}

function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (secs < 90) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 90) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
