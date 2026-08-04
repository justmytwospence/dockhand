import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import type { ScannedService } from '../../compose/scan.ts'
import { Layout, Banner, Table, type MissingSetting } from './layout.tsx'
import { Help } from './shell.tsx'
import { IconChevronRight } from './icons.tsx'

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

  // A count you cannot click is a fact; one you can is a starting point. `pending` has
  // no destination because it IS the list directly below it.
  const tiles: [number, string, string | null][] = [
    [pending.length, 'pending', null],
    [watched.length, 'watched', '/images?filter=watched'],
    [unwatchable.length, 'not watchable', '/images?filter=unwatchable'],
    [services.length, 'services', '/images'],
  ]

  return (
    <Layout
      title="Dashboard"
      path="/"
      missing={missing}
      // The page's one primary action belongs in the header, not floating in the body.
      fill
      actions={
        <div class="d-flex align-items-center gap-2 flex-wrap justify-content-end">
          <span id="scan-status" hx-get="/scan/status" hx-trigger="load">
            <ScanStatus scan={scan} />
          </span>
          <button
            class="btn btn-primary"
            hx-post="/scan"
            hx-target="#scan-status"
            hx-swap="innerHTML"
            hx-disabled-elt="this"
          >
            Scan now
          </button>
        </div>
      }
    >
      {policyError && <Banner kind="error">{policyError}</Banner>}
      {blackout && (
        <Banner kind="info">
          Inside a blackout window &mdash; git and deploy operations are queued, not dropped.
        </Banner>
      )}

      <div class="row row-deck row-cards mb-3">
        {tiles.map(([n, label, href]) => {
          const body = (
            <div class="card-body">
              <div class="h1 mb-0">{n}</div>
              <div class="sub">{label}</div>
            </div>
          )
          return (
            <div class="col-6 col-sm-3">
              {href ? (
                <a class="card card-sm kpi" href={href}>
                  {body}
                </a>
              ) : (
                <div class="card card-sm">{body}</div>
              )}
            </div>
          )
        })}
      </div>

      {/* Two panes: the worklist owns the height, the feed rides alongside it on wide
          screens and drops underneath below xl. */}
      <div class="row row-cards workspace-row">
        <div class="col-12 col-xl-8 d-flex flex-column">
          {/* Polls only while a scan is running: the status fragment emits
              #scan-running, and the trigger filter checks for it, so an idle dashboard
              makes no requests. */}
          <div
            id="pending"
            class="d-flex flex-column flex-fill"
            hx-get="/fragments/pending"
            hx-trigger="every 10s [document.getElementById('scan-running')]"
            hx-include="#worklist-state"
            hx-swap="innerHTML"
          >
            <PendingSections pending={pending} repo={repo} />
          </div>
        </div>
        <div class="col-12 col-xl-4 d-flex flex-column">
          <div class="card card-fill">
            <div class="card-header">
              <h3 class="card-title mb-0">Recent activity</h3>
              <a class="ms-auto sub" href="/activity">
                All &rarr;
              </a>
            </div>
            <div class="card-body feed">
              {recent.length === 0 ? (
                <p class="nothing mb-0">Nothing logged yet.</p>
              ) : (
                recent.map((r) => (
                  <div class="feed-item" style={`--k: var(--k-${String(r.kind)}, var(--k-system))`}>
                    <span class="kdot"></span>
                    <div class="feed-text">
                      {String(r.message)}
                      <div class="sub">
                        {String(r.kind)} &middot; {String(r.at).replace('T', ' ').slice(5, 16)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Outside #pending on purpose: that region is replaced wholesale every 10s
          while a scan runs, and a drawer inside it would vanish mid-read. */}
      <DetailDrawer />
    </Layout>
  )
}

export const SCOPE_FILTERS = [
  ['all', 'All'],
  ['tag-only', 'Tag only'],
  ['proposed', 'With config changes'],
  ['edited', 'Edited'],
] as const

/**
 * The worklist's buckets.
 *
 * These were four stacked tables, each with a heading and a paragraph of explanation.
 * With ~45 live updates that meant scrolling past everything to find the eight that
 * actually want you. As tabs the counts *are* the dashboard -- you read the shape of
 * your backlog in one line -- and the explanation moves into the (i) beside each label.
 */
export const BUCKETS = [
  {
    key: 'review',
    label: 'Needs review',
    help: 'Majors, gated infrastructure, and anything else a human merges. This is the queue that is actually waiting on you.',
    match: (p: PendingRow) => p.detail !== 'rolling' && p.state !== 'held' && p.tier !== 'auto',
  },
  {
    key: 'held',
    label: 'Held',
    help: 'Datastores. A tag bump alone cannot apply these — a postgres major refuses the old datadir — so each is a deliberate migration. Open a pull request when you are ready to do one.',
    match: (p: PendingRow) => p.state === 'held',
    action: 'open-pr' as const,
  },
  {
    key: 'rolling',
    label: 'Rolling',
    help: 'The tag still points somewhere new. There is nothing to change in git, so redeploy to adopt it, or dismiss to acknowledge.',
    match: (p: PendingRow) => p.detail === 'rolling',
    action: 'dismiss' as const,
  },
  {
    key: 'auto',
    label: 'Automatic',
    help: 'These roll out on the nightly cycle without review. Rows clear once the new version is running.',
    match: (p: PendingRow) => p.detail !== 'rolling' && p.state !== 'held' && p.tier === 'auto',
  },
] as const

export type BucketKey = (typeof BUCKETS)[number]['key']

export const PendingSections: FC<{
  pending: PendingRow[]
  repo: string
  scopeFilter?: string
  bucket?: string
}> = ({ pending, repo, scopeFilter = 'all', bucket = 'review' }) => {
  const counts = Object.fromEntries(
    BUCKETS.map((b) => [b.key, pending.filter(b.match).length]),
  ) as Record<BucketKey, number>
  const active = BUCKETS.find((b) => b.key === bucket) ?? BUCKETS[0]
  const rows = pending.filter(active.match)
  const anyPrs = pending.some((p) => p.pr_number)

  const href = (b: string, scope: string) => `/fragments/pending?bucket=${b}&prscope=${scope}`

  return (
    <div class="card card-fill">
      {/* The poll re-requests this fragment every 10s during a scan. Without carrying
          the open tab and filter it would snap you back to the first bucket mid-read;
          #pending includes these inputs in its request. */}
      <div id="worklist-state" hidden>
        <input type="hidden" name="bucket" value={active.key} />
        <input type="hidden" name="prscope" value={scopeFilter} />
      </div>
      {/* The toolbar belongs to the data, not to the page. */}
      <div class="card-header worklist-bar">
        <ul class="nav nav-tabs card-header-tabs flex-grow-1" role="tablist">
          {BUCKETS.map((b) => (
            <li class="nav-item" role="presentation">
              <a
                href="#"
                role="tab"
                aria-selected={b.key === active.key ? 'true' : 'false'}
                class={`nav-link${b.key === active.key ? ' active' : ''}`}
                hx-get={href(b.key, scopeFilter)}
                hx-target="#pending"
                hx-swap="innerHTML"
              >
                {b.label}
                <span class={`badge ms-2 ${counts[b.key] ? 'bg-secondary-lt' : 'bg-transparent sub'}`}>
                  {counts[b.key]}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {anyPrs && (
          <div class="ms-auto d-flex align-items-center gap-2">
            <label class="sub d-none d-xl-inline" for="prscope">
              Contents
            </label>
            <select
              id="prscope"
              class="form-select form-select-sm w-auto"
              hx-get="/fragments/pending"
              hx-target="#pending"
              hx-swap="innerHTML"
              name="prscope"
              hx-vals={`{"bucket":"${active.key}"}`}
            >
              {SCOPE_FILTERS.map(([key, label]) => (
                <option value={key} selected={scopeFilter === key}>
                  {label}
                </option>
              ))}
            </select>
            <Help
              label="Contents"
              text="“With config changes” carries changes dockhand drafted; “Edited” carries yours. Neither can ever merge automatically."
            />
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div class="card-body">
          <p class="nothing mb-0">Nothing here.</p>
        </div>
      ) : (
        <div class="table-responsive">
          <table class="table card-table table-vcenter table-sticky worklist">
            <thead>
              <tr>
                <th>Service</th>
                <th>Change</th>
                <th>Kind</th>
                <th>Analysis</th>
                <th>PR</th>
                <th class="w-1"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row row={r} repo={repo} action={'action' in active ? active.action : undefined} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * One update.
 *
 * The whole row opens the detail drawer, except where you clicked a button or a link --
 * that is what the `click[...]` event filter is for. Actions stay on the row rather than
 * moving into the drawer: dismissing a rolling tag is one click and should not cost a
 * round trip through a panel.
 */
const Row: FC<{ row: PendingRow; repo: string; action?: 'open-pr' | 'dismiss' }> = ({
  row: r,
  repo,
  action,
}) => (
  <tr
    class="worklist-row"
    hx-get={`/updates/${r.id}/detail`}
    hx-target="#detail-body"
    hx-swap="innerHTML"
    hx-trigger="click[!event.target.closest('button,a')]"
    data-bs-toggle="offcanvas"
    data-bs-target="#detail"
  >
    <td class="nowrap">
      <span class="svc-stack">{r.stack}</span>
      <span class="svc-name">{r.service}</span>
    </td>
    {/* Digest refs run to 20+ characters either side; in an 8-column pane that alone
        pushes the table wider than its card and clips the PR column off the end. */}
    <td class="mono nowrap change">
      {shorten(r.from_tag)} <span class="sub">&rarr;</span> {shorten(r.to_tag)}
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
            <span class="pill warn scope" title="someone pushed changes beyond the image tag">
              edited
            </span>
          ) : r.pr_scope === 'proposed' ? (
            <span class="pill accent scope" title="dockhand drafted config changes to accompany this bump">
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
    <td class="nowrap text-end">
      {action ? (
        <button
          class="btn btn-sm"
          hx-post={`/updates/${r.id}/${action}`}
          hx-target="closest tr"
          hx-swap="outerHTML"
          hx-disabled-elt="this"
        >
          {action === 'open-pr' ? 'Open PR' : 'Dismiss'}
        </button>
      ) : (
        <span class="row-chevron sub">
          <IconChevronRight />
        </span>
      )}
    </td>
  </tr>
)

/**
 * The detail drawer.
 *
 * Rendered in Layout-adjacent position on the dashboard, OUTSIDE `#pending` -- that
 * region's innerHTML is replaced every 10s while a scan runs, and a drawer living
 * inside it would be destroyed mid-read. Body is filled on demand by the row click.
 */
export const DetailDrawer: FC = () => (
  <div class="offcanvas offcanvas-end offcanvas-detail" tabindex={-1} id="detail" aria-labelledby="detail-title">
    <div class="offcanvas-header">
      <h2 class="offcanvas-title h4 mb-0" id="detail-title">
        Update
      </h2>
      <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
    </div>
    <div class="offcanvas-body" id="detail-body">
      <p class="sub">Select an update.</p>
    </div>
  </div>
)

/**
 * `poll` false renders the same text without the self-refreshing element.
 *
 * The More sheet shows scan status too, and `#scan-running` is not decoration -- the
 * dashboard's pending region keys its 10s poll off `document.getElementById`. Two
 * elements with that id on one page would double every request and make the "is a scan
 * running" condition ambiguous, so only the dashboard's copy carries it.
 */
export const ScanStatus: FC<{ scan: ScanInfo; poll?: boolean }> = ({ scan, poll = true }) => {
  if (scan.running && !poll) return <span class="sub">scanning&hellip;</span>
  if (scan.running) {
    // The id is the poll condition for the pending region -- present only while
    // scanning, so nothing polls at rest.
    //
    // outerHTML is load-bearing, not stylistic. htmx defaults to innerHTML, which would
    // swap the finished status *inside* this span and leave the id in the document
    // forever -- so both this 3s poll and the dashboard's 10s pending poll would keep
    // firing until someone reloaded the page. Replacing the element is what lets the
    // id, and with it both polls, actually stop.
    return (
      <span
        class="sub"
        id="scan-running"
        hx-get="/scan/status"
        hx-trigger="every 3s"
        hx-swap="outerHTML"
      >
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
