import type { FC } from 'hono/jsx'
import type { ScannedService } from '../../compose/scan.ts'
import { Layout, Empty, Table } from './layout.tsx'
import { displayName } from '../../images/ref.ts'

const FILTERS = [
  ['all', 'All'],
  ['watched', 'Watched'],
  ['unlabelled', 'Unlabelled'],
  ['unwatchable', 'Not watchable'],
] as const

interface StatusRow {
  stack: string
  service: string
  last_status: string
  last_detail: string | null
}

export const ImagesPage: FC<{
  services: ScannedService[]
  filter: string
  statusMap: Map<string, StatusRow>
}> = ({ services, filter, statusMap }) => {
  const shown = services.filter((s) => {
    if (filter === 'watched') return s.watched
    if (filter === 'unlabelled') return s.ref && !s.watched && !s.unwatchable
    if (filter === 'unwatchable') return !!s.unwatchable
    return true
  })

  return (
    <Layout title="Images" path="/images">
      <h2>Image inventory</h2>
      <p class="sub">
        Read directly from the compose files in the working tree &mdash; never from running
        container labels, so a label edit takes effect without recreating anything.
      </p>
      <nav class="filters">
        {FILTERS.map(([key, label]) => (
          <a href={`/images?filter=${key}`} class={filter === key ? 'active' : ''}>
            {label}
          </a>
        ))}
      </nav>
      {shown.length === 0 ? (
        <Empty>Nothing matches this filter.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Stack</th>
              <th>Service</th>
              <th>Image</th>
              <th>Tag</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr>
                <td>{s.stack}</td>
                <td>{s.service}</td>
                <td class="mono">{s.ref ? displayName(s.ref) : s.imageRaw ?? '—'}</td>
                <td class="mono">{s.ref?.tag ?? '—'}</td>
                <td>
                  {(() => {
                    const st = statusMap.get(`${s.stack}/${s.service}`)
                    if (st) {
                      return (
                        <>
                          <span class="pill err">{st.last_status}</span>
                          {st.last_detail ? <div class="detail">{st.last_detail}</div> : null}
                        </>
                      )
                    }
                    if (s.unwatchable) return <span class="pill muted">{s.unwatchable}</span>
                    if (s.watched) return <span class="pill ok">watched</span>
                    return <span class="pill warn">unlabelled</span>
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Layout>
  )
}
