import type { FC } from 'hono/jsx'
import { Layout, Empty, Table, type MissingSetting } from './layout.tsx'

export const KINDS = ['scan', 'policy', 'pr', 'analysis', 'deploy', 'sync', 'system'] as const

export interface ActivityFilter {
  kind: string
  level: string
}

export const ActivityPage: FC<{
  rows: Record<string, unknown>[]
  filter: ActivityFilter
  repo: string
  missing?: MissingSetting[]
}> = ({ rows, filter, repo, missing }) => (
  <Layout
    title="Activity"
    path="/activity"
    missing={missing}
    subtitle="Every recorded event, newest first."
  >
    <ul class="nav nav-pills filters mb-3">
      <li class="nav-item">
        <a
          href="/activity"
          class={`nav-link${filter.kind === 'all' && filter.level === 'all' ? ' active' : ''}`}
        >
          All
        </a>
      </li>
      {KINDS.map((k) => (
        <li class="nav-item">
          {/* --k must stay on the element that contains the dot; the dot reads it. */}
          <a
            href={`/activity?kind=${k}${filter.level !== 'all' ? `&level=${filter.level}` : ''}`}
            class={`nav-link${filter.kind === k ? ' active' : ''}`}
            style={`--k: var(--k-${k})`}
          >
            <span class="kdot"></span>
            {k}
          </a>
        </li>
      ))}
      <li class="nav-item ms-auto">
        <a
          href={`/activity?level=problems${filter.kind !== 'all' ? `&kind=${filter.kind}` : ''}`}
          class={`nav-link problems${filter.level === 'problems' ? ' active' : ''}`}
        >
          problems only
        </a>
      </li>
    </ul>

    <div id="activity-table">
      <ActivityTable rows={rows} repo={repo} />
    </div>
  </Layout>
)

export const ActivityTable: FC<{ rows: Record<string, unknown>[]; repo: string }> = ({
  rows,
  repo,
}) =>
  rows.length === 0 ? (
    <Empty>Nothing matches this filter.</Empty>
  ) : (
    <Table>
      <thead>
        <tr>
          <th>When</th>
          <th>Kind</th>
          <th>Target</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const kind = String(r.kind)
          const level = String(r.level)
          return (
            <tr class={level === 'error' ? 'row-error' : level === 'warn' ? 'row-warn' : ''}>
              <td class="mono nowrap">{String(r.at).replace('T', ' ').slice(0, 19)}</td>
              <td class="nowrap">
                <span class="kchip" style={`--k: var(--k-${kind}, var(--k-system))`}>
                  <span class="kdot"></span>
                  {kind}
                </span>
              </td>
              <td class="mono">
                {r.stack ? `${String(r.stack)}${r.service ? `/${String(r.service)}` : ''}` : '—'}
              </td>
              <td>
                {linkify(String(r.message), repo)}
                {r.detail ? <div class="detail">{linkify(String(r.detail), repo)}</div> : null}
              </td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )

/**
 * Turn `#123` into a link to the pull request. Event messages are written by the PR
 * engine ("superseded by #41"), and a bare number there is a dead end otherwise.
 */
function linkify(text: string, repo: string): unknown {
  const parts: unknown[] = []
  const re = /(^|[^\w#])#(\d{1,6})\b/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index + m[1]!.length))
    parts.push(
      <a href={`https://github.com/${repo}/pull/${m[2]}`} target="_blank" rel="noopener">
        #{m[2]}
      </a>,
    )
    last = m.index + m[0]!.length
  }
  if (parts.length === 0) return text
  parts.push(text.slice(last))
  return parts
}
