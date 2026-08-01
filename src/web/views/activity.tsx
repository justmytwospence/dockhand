import type { FC } from 'hono/jsx'
import { Layout, Empty, Table } from './layout.tsx'

export const ActivityPage: FC<{ rows: Record<string, unknown>[] }> = ({ rows }) => (
  <Layout title="Activity" path="/activity">
    <h2>Activity log</h2>
    {rows.length === 0 ? (
      <Empty>Nothing logged yet.</Empty>
    ) : (
      <Table>
        <thead>
          <tr>
            <th>When</th>
            <th>Level</th>
            <th>Kind</th>
            <th>Target</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr class={r.level === 'error' ? 'row-error' : r.level === 'warn' ? 'row-warn' : ''}>
              <td class="mono nowrap">{String(r.at).replace('T', ' ').slice(0, 19)}</td>
              <td>{String(r.level)}</td>
              <td>{String(r.kind)}</td>
              <td class="mono">
                {r.stack ? `${String(r.stack)}${r.service ? `/${String(r.service)}` : ''}` : '—'}
              </td>
              <td>
                {String(r.message)}
                {r.detail ? <div class="detail">{String(r.detail)}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    )}
  </Layout>
)
