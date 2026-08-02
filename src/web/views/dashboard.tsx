import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import type { ScannedService } from '../../compose/scan.ts'
import { Layout, Banner, Empty, Table, type MissingSetting } from './layout.tsx'

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
  pr_number: number | null
  recommendation: string | null
  confidence: string | null
  pr_scope: string | null
}

export interface ScanInfo {
  lastAt: string | null
  durationS: number | null
  counts: Record<string, number> | null
  running: boolean
}

const VERDICT: Record<string, { cls: string; icon: string; label: string }> = {
  approve: { cls: 'ok', icon: '\u2713', label: 'safe to apply' },
  caution: { cls: 'warn', icon: '\u26a0', label: 'read first' },
  block: { cls: 'err', icon: '\u2298', label: 'breaking changes' },
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
  repo: string
  missing?: MissingSetting[]
}> = ({ policyError, services, pending, recent, blackout, scan, repo, missing }) => {
  const watched = services.filter((s) => s.watched)
  const unwatchable = services.filter((s) => s.unwatchable)

  return (
    <Layout title="Dashboard" path="/" missing={missing}>
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
        <button hx-post="/scan" hx-target="#scan-status" hx-swap="innerHTML" hx-disabled-elt="this">
          Scan now
        </button>
        <span id="scan-status" hx-get="/scan/status" hx-trigger="load">
          <ScanStatus scan={scan} />
        </span>
      </div>

      {/* Polls only while a scan is running: the status fragment emits #scan-running,
          and the trigger filter checks for it, so an idle dashboard makes no requests. */}
      <div
        id="pending"
        hx-get="/fragments/pending"
        hx-trigger="every 10s [document.getElementById('scan-running')]"
        hx-swap="innerHTML"
      >
        <PendingSections pending={pending} repo={repo} />
      </div>

      <h2>Recent activity</h2>
      {recent.length === 0 ? (
        <Empty>Nothing logged yet.</Empty>
      ) : (
        <Table>
          <tbody>
            {recent.map((r) => (
              <tr>
                <td class="mono nowrap">{String(r.at).replace('T', ' ').slice(0, 19)}</td>
                <td class="nowrap">
                  <span class={`kchip`} style={`--k: var(--k-${String(r.kind)}, var(--k-system))`}>
                    <span class="kdot"></span>
                    {String(r.kind)}
                  </span>
                </td>
                <td>{String(r.message)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Layout>
  )
}

export const SCOPE_FILTERS = [
  ['all', 'All'],
  ['tag-only', 'Tag only'],
  ['proposed', 'With config changes'],
  ['edited', 'Edited'],
] as const

export const PendingSections: FC<{
  pending: PendingRow[]
  repo: string
  scopeFilter?: string
}> = ({ pending, repo, scopeFilter = 'all' }) => {
  const rolling = pending.filter((p) => p.detail === 'rolling')
  const held = pending.filter((p) => p.state === 'held')
  const review = pending.filter(
    (p) => p.detail !== 'rolling' && p.state !== 'held' && p.tier !== 'auto',
  )
  const auto = pending.filter(
    (p) => p.detail !== 'rolling' && p.state !== 'held' && p.tier === 'auto',
  )
  const anyPrs = pending.some((p) => p.pr_number)
  return (
    <>
      {anyPrs && (
        <nav class="filters scopefilters">
          {SCOPE_FILTERS.map(([key, label]) => (
            <a
              href="#"
              class={scopeFilter === key ? 'active' : ''}
              hx-get={`/fragments/pending?prscope=${key}`}
              hx-target="#pending"
              hx-swap="innerHTML"
            >
              {label}
            </a>
          ))}
          <span class="sub filters-note">
            &ldquo;+ config&rdquo; carries changes dockhand drafted; &ldquo;edited&rdquo; carries yours.
            Neither can merge automatically.
          </span>
        </nav>
      )}
      <Section
        title="Needs review"
        caption="Majors, gated infrastructure, and anything else a human merges."
        rows={review}
        empty="Nothing waiting on you."
        repo={repo}
      />
      <Section
        title="Held"
        caption="Datastores. A tag bump alone cannot apply these — a postgres major refuses the old datadir — so each is a deliberate migration. Open a PR when you are ready to do one."
        rows={held}
        empty="No held updates."
        action="open-pr"
        repo={repo}
      />
      <Section
        title="Rolling tags moved"
        caption="The tag still points somewhere new. Nothing to change in git; redeploy to adopt."
        rows={rolling}
        empty="No rolling images have moved."
        action="dismiss"
        repo={repo}
      />
      <Section
        title="Applied automatically"
        caption="These roll out on the nightly cycle without review; rows clear once the new version is running."
        rows={auto}
        empty="Nothing queued."
        repo={repo}
      />
    </>
  )
}

const Section: FC<{
  title: string
  caption: string
  rows: PendingRow[]
  empty: string
  repo: string
  action?: 'open-pr' | 'dismiss'
}> = ({ title, caption, rows, empty, action, repo }) => (
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
            <th>Service</th>
            <th>Change</th>
            <th>Kind</th>
            <th>Analysis</th>
            <th>PR</th>
            {action && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td class="nowrap">
                <span class="svc-stack">{r.stack}</span>
                <span class="svc-name">{r.service}</span>
              </td>
              <td>
                {/* Native <details> so the toggle needs no JS; htmx fetches the diff
                    once, on first open. */}
                <details class="diffbox">
                  <summary>
                    <span class="mono">
                      {shorten(r.from_tag)} &rarr; {shorten(r.to_tag)}
                    </span>
                  </summary>
                  <div
                    class="diff-body"
                    hx-get={`/updates/${r.id}/diff`}
                    hx-trigger="toggle once from:closest details"
                    hx-swap="innerHTML"
                  >
                    <span class="sub">loading diff&hellip;</span>
                  </div>
                </details>
              </td>
              <td>
                <span class={`pill ${MAGNITUDE_CLASS[r.magnitude] ?? 'muted'}`}>{r.magnitude}</span>
              </td>
              <td class="nowrap">
                {r.recommendation && VERDICT[r.recommendation] ? (
                  <span
                    class={`pill ${VERDICT[r.recommendation]!.cls}`}
                    title={`${VERDICT[r.recommendation]!.label} (${r.confidence} confidence)`}
                  >
                    {VERDICT[r.recommendation]!.icon} {r.recommendation}
                  </span>
                ) : (
                  <span class="sub">&mdash;</span>
                )}
              </td>
              <td class="nowrap">
                {r.pr_number ? (
                  <>
                    <a
                      class="ext"
                      href={`https://github.com/${repo}/pull/${r.pr_number}`}
                      target="_blank"
                      rel="noopener"
                    >
                      #{r.pr_number} &#8599;
                    </a>
                    {r.pr_scope === 'modified' ? (
                      <span
                        class="pill warn scope"
                        title="someone pushed changes beyond the image tag; this always needs a human"
                      >
                        edited
                      </span>
                    ) : r.pr_scope === 'proposed' ? (
                      <span
                        class="pill accent scope"
                        title="dockhand drafted config changes to accompany this bump — review both commits"
                      >
                        + config
                      </span>
                    ) : (
                      <span class="pill muted scope" title="only the image tag changes">
                        tag only
                      </span>
                    )}
                  </>
                ) : (
                  <span class="sub">&mdash;</span>
                )}
              </td>
              {action && (
                <td>
                  <button
                    class="linkish"
                    hx-post={`/updates/${r.id}/${action === 'open-pr' ? 'open-pr' : 'dismiss'}`}
                    hx-target="closest tr"
                    hx-swap="outerHTML"
                    hx-disabled-elt="this"
                  >
                    {action === 'open-pr' ? 'Open PR' : 'Dismiss'}
                  </button>
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
  if (scan.running) {
    // The id is the poll condition for the pending region -- present only while
    // scanning, so nothing polls at rest.
    return (
      <span class="sub" id="scan-running" hx-get="/scan/status" hx-trigger="every 3s">
        scanning&hellip;
      </span>
    )
  }
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
