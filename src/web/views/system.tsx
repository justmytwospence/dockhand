import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import { Layout, Banner, Empty } from './layout.tsx'
import { env } from '../../config.ts'

export const SystemPage: FC<{
  policy: Policy
  policyError?: string
  budgets: Record<string, unknown>[]
  version: string
  blackout: boolean
}> = ({ policy, policyError, budgets, version, blackout }) => (
  <Layout title="System" path="/system">
    {policyError && <Banner kind="error">{policyError}</Banner>}

    <h2>Configuration</h2>
    <table class="kv">
      <tbody>
        <tr>
          <th>version</th>
          <td class="mono">{version}</td>
        </tr>
        <tr>
          <th>homelab checkout</th>
          <td class="mono">{env.homelabRepo}</td>
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
          <th>excluded stacks</th>
          <td class="mono">{policy.exclude_stacks.join(', ')}</td>
        </tr>
      </tbody>
    </table>

    <h2>Credentials</h2>
    <p class="sub">Presence only &mdash; values are never read into the UI.</p>
    <table class="kv">
      <tbody>
        <Cred name="GITHUB_TOKEN" set={!!env.githubToken} />
        <Cred name="ANTHROPIC_API_KEY" set={!!env.anthropicApiKey} />
        <Cred name="NTFY_TOKEN" set={!!env.ntfyToken} />
        <Cred name="DOCKER_HUB_LOGIN" set={!!env.dockerHubLogin} />
      </tbody>
    </table>

    <h2>Budgets</h2>
    {budgets.length === 0 ? (
      <Empty>
        No budget counters yet &mdash; they populate once the registry poller and analyzer run.
      </Empty>
    ) : (
      <table class="kv">
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
      </table>
    )}
  </Layout>
)

const Cred: FC<{ name: string; set: boolean }> = ({ name, set }) => (
  <tr>
    <th class="mono">{name}</th>
    <td>
      {set ? <span class="pill ok">set</span> : <span class="pill warn">missing</span>}
    </td>
  </tr>
)
