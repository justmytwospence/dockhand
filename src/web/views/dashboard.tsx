import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import type { ScannedService } from '../../compose/scan.ts'
import { Layout, Banner, Empty, Table } from './layout.tsx'
import { displayName } from '../../images/ref.ts'

export const Dashboard: FC<{
  policy: Policy
  policyError?: string
  services: ScannedService[]
  recent: Record<string, unknown>[]
  blackout: boolean
}> = ({ policy, policyError, services, recent, blackout }) => {
  const watched = services.filter((s) => s.watched)
  const unwatchable = services.filter((s) => s.unwatchable)
  const candidates = services.filter((s) => s.ref && !s.watched && !s.unwatchable)

  return (
    <Layout title="Dashboard" path="/">
      {policyError && <Banner kind="error">{policyError}</Banner>}
      {blackout && (
        <Banner kind="info">
          Inside a blackout window &mdash; git and deploy operations are queued, not dropped.
        </Banner>
      )}
      {!policyError && watched.length === 0 && (
        <Banner kind="warn">
          No services carry <code>dockhand.watch: "true"</code> yet. Run the label migration
          (<code>npm run migrate-labels</code>) to derive them from the existing{' '}
          <code>wud.*</code> labels.
        </Banner>
      )}

      <section class="tiles">
        <div class="tile">
          <span class="num">{watched.length}</span>
          <span class="lbl">watched</span>
        </div>
        <div class="tile">
          <span class="num">{candidates.length}</span>
          <span class="lbl">unlabelled</span>
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

      <h2>Pending updates</h2>
      <Empty>
        Detection is not enabled yet (milestone M1). Once the registry poller runs, new tags
        appear here grouped by policy tier.
      </Empty>

      <h2>Watched services</h2>
      {watched.length === 0 ? (
        <Empty>None yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Stack</th>
              <th>Service</th>
              <th>Image</th>
              <th>Tag</th>
              <th>Pattern</th>
              <th>Policy</th>
            </tr>
          </thead>
          <tbody>
            {watched.map((s) => (
              <tr>
                <td>{s.stack}</td>
                <td>{s.service}</td>
                <td class="mono">{s.ref ? displayName(s.ref) : ''}</td>
                <td class="mono">{s.ref?.tag ?? ''}</td>
                <td>{s.pattern ?? <span class="warn-text">missing</span>}</td>
                <td>{s.policyLabel ?? defaultTier(policy)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

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

function defaultTier(policy: Policy): string {
  return `${policy.defaults.patch}/${policy.defaults.minor}`
}
