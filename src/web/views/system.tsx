import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import { Layout, Banner, Empty, Table, type MissingSetting } from './layout.tsx'
import { env } from '../../config.ts'
import type { ScanInfo } from './dashboard.tsx'

export interface SpendRow {
  model: string
  purpose: string
  calls: number
  cost: number
  tokens_in: number
  tokens_out: number
  cached: number
}

export interface DeployRow {
  stack: string
  services: string
  strategy: string
  ok: number
  healthy: number
  detail: string | null
  created_at: string
}

export const SystemPage: FC<{
  spend?: SpendRow[]
  deploys?: DeployRow[]
  policy: Policy
  policyError?: string
  budgets: Record<string, unknown>[]
  version: string
  blackout: boolean
  scan: ScanInfo
  missing?: MissingSetting[]
}> = ({ policy, policyError, budgets, spend, deploys, version, blackout, scan, missing }) => (
  <Layout title="System" path="/system" missing={missing}>
    {policyError && <Banner kind="error">{policyError}</Banner>}

    <h2>Configuration</h2>
    <Table kv>
      <tbody>
        <tr>
          <th>version</th>
          <td class="mono">{version}</td>
        </tr>
        <tr>
          <th>repository checkout</th>
          <td class="mono">{env.repoDir}</td>
        </tr>
        <tr>
          <th>target repo</th>
          <td class="mono">{env.githubRepo}</td>
        </tr>
        <tr>
          <th>merge method</th>
          <td class="mono">{policy.merge_method}</td>
        </tr>
        <tr>
          <th>push main</th>
          <td class="mono">{String(policy.sync.push_main)}</td>
        </tr>
        <tr>
          <th>blackout</th>
          <td class="mono">
            {policy.sync.blackout.join(', ') || '—'}
            {blackout ? ' (active now)' : ''}
          </td>
        </tr>
        <tr>
          <th>scan schedule</th>
          <td class="mono">
            {policy.scan.cron} ({env.tz})
          </td>
        </tr>
        <tr>
          <th>claude</th>
          <td class="mono">
            {policy.claude.mode} &middot; {policy.claude.model}
          </td>
        </tr>
        <tr>
          <th>settings</th>
          <td>
            <a href="/settings">edit policy.yaml &rarr;</a>
          </td>
        </tr>
        <tr>
          <th>excluded stacks</th>
          <td class="mono">{policy.exclude_stacks.join(', ')}</td>
        </tr>
      </tbody>
    </Table>

    <h2>Last scan</h2>
    <Table kv>
      <tbody>
        <tr>
          <th>ran</th>
          <td class="mono">{scan.lastAt ?? 'never'}</td>
        </tr>
        <tr>
          <th>duration</th>
          <td class="mono">{scan.durationS !== null ? `${scan.durationS}s` : '—'}</td>
        </tr>
        <tr>
          <th>outcomes</th>
          <td class="mono">
            {scan.counts
              ? Object.entries(scan.counts)
                  .map(([k, v]) => `${k}=${v}`)
                  .join('  ')
              : '—'}
          </td>
        </tr>
      </tbody>
    </Table>

    <h2>Credentials</h2>
    <p class="sub">Presence only &mdash; values are never read into the UI.</p>
    <Table kv>
      <tbody>
        <Cred name="GITHUB_TOKEN" set={!!env.githubToken} />
        <Cred name="ANTHROPIC_API_KEY" set={!!env.anthropicApiKey} />
        <Cred name="NTFY_TOKEN" set={!!env.ntfyToken} />
        <Cred name="DOCKER_HUB_LOGIN" set={!!env.dockerHubLogin} />
      </tbody>
    </Table>

    <h2>Recent deploys</h2>
    {!deploys || deploys.length === 0 ? (
      <Empty>
        Nothing deployed yet. Merged changes are synced into the checkout; whether they
        are brought up automatically is the <code>deploy.mode</code> setting.
      </Empty>
    ) : (
      <Table>
        <thead>
          <tr>
            <th>When</th>
            <th>Stack</th>
            <th>Services</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {deploys.map((d) => (
            <tr>
              <td class="sub">{d.created_at.replace('T', ' ').slice(0, 16)}</td>
              <td class="mono">{d.stack}</td>
              <td class="mono">
                {d.services}
                {d.strategy === 'rm-first' && <span class="pill muted">rm-first</span>}
              </td>
              <td>
                {d.ok && d.healthy ? (
                  <span class="pill ok">healthy</span>
                ) : d.ok ? (
                  // Started but not healthy is the one that looks fine and is not.
                  <span class="pill error">unhealthy</span>
                ) : (
                  <span class="pill error">failed</span>
                )}{' '}
                <span class="sub">{d.detail}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    )}

    <h2>Model spend this month</h2>
    {!spend || spend.length === 0 ? (
      <Empty>No model calls yet this month.</Empty>
    ) : (
      <>
        <Table>
          <thead>
            <tr>
              <th>Model</th>
              <th>For</th>
              <th class="num">Calls</th>
              <th class="num">In</th>
              <th class="num">Cached</th>
              <th class="num">Out</th>
              <th class="num">Cost</th>
              <th class="num">Avg</th>
            </tr>
          </thead>
          <tbody>
            {spend.map((s) => (
              <tr>
                <td class="mono">{s.model}</td>
                <td>{s.purpose}</td>
                <td class="num">{s.calls}</td>
                <td class="num">{fmtTokens(s.tokens_in)}</td>
                <td class="num" title="served from cache at a tenth of the input price">
                  {pct(s.cached, s.tokens_in)}
                </td>
                <td class="num">{fmtTokens(s.tokens_out)}</td>
                <td class="num">${s.cost.toFixed(2)}</td>
                <td class="num">${(s.cost / Math.max(1, s.calls)).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p class="sub">
          Cached input bills at a tenth of the normal rate, so a high percentage there is
          the cheap column, not a warning.
        </p>
      </>
    )}

    <h2>Budgets</h2>
    {budgets.length === 0 ? (
      <Empty>
        No budget counters yet &mdash; they populate once the registry poller and analyzer run.
      </Empty>
    ) : (
      <Table kv>
        <tbody>
          {budgets.map((b) => (
            <tr>
              <th class="mono">{String(b.key)}</th>
              <td class="mono">
                {String(b.value)}
                {b.window ? ` (${String(b.window)})` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    )}
  </Layout>
)

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function pct(part: number, whole: number): string {
  if (!whole) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

const Cred: FC<{ name: string; set: boolean }> = ({ name, set }) => (
  <tr>
    <th class="mono">{name}</th>
    <td>
      {set ? <span class="pill ok">set</span> : <span class="pill warn">missing</span>}
    </td>
  </tr>
)
