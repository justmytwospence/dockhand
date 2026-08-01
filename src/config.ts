import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/**
 * Process-level constants come from the environment; everything the operator tunes
 * lives in the tracked policy.yaml inside the homelab repo. Per-service data and
 * exceptions live as `dockhand.*` labels on the services themselves -- read from the
 * compose files, never from running containers.
 */

export const env = {
  /** The live homelab checkout. Mounted at the identical path inside the container so
   *  `docker compose` resolves relative volume paths and the project name the same way
   *  a host-side invocation would. */
  homelabRepo: process.env.HOMELAB_REPO ?? '/home/spencer/homelab',
  dataDir: process.env.DATA_DIR ?? '/data',
  port: Number(process.env.PORT ?? 8080),
  tz: process.env.TZ ?? 'UTC',

  githubToken: process.env.GITHUB_TOKEN ?? '',
  githubRepo: process.env.GITHUB_REPO ?? 'justmytwospence/homelab',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  ntfyUrl: process.env.NTFY_URL ?? 'http://ntfy:80',
  ntfyTopic: process.env.NTFY_TOPIC ?? 'container-updates',
  ntfyToken: process.env.NTFY_TOKEN ?? '',
  dockerHubLogin: process.env.DOCKER_HUB_LOGIN ?? '',
  dockerHubPassword: process.env.DOCKER_HUB_PASSWORD ?? '',
} as const

export const paths = {
  db: join(env.dataDir, 'dockhand.db'),
  /** The tool's own clone. All branch/edit/commit/push work happens here so the user's
   *  live checkout -- which habitually carries uncommitted WIP -- is never disturbed. */
  workRepo: join(env.dataDir, 'repo'),
  lock: join(env.dataDir, 'git.lock'),
  policy: join(env.homelabRepo, 'dockhand', 'config', 'policy.yaml'),
} as const

const Tier = z.enum(['auto', 'gated', 'manual', 'skip'])
export type Tier = z.infer<typeof Tier>

/** "HH:MM-HH:MM", may wrap past midnight. */
const Window = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)

const PolicySchema = z.object({
  // Must match what the GitHub repo settings actually allow, or the merge API 405s.
  merge_method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  sync: z
    .object({
      // Kill-switch. false => the tool never pushes main, which also means it can never
      // open a PR (a branch based on a stale origin/main would silently revert local
      // commits when merged). Degrades to alert-only.
      push_main: z.boolean().default(true),
      blackout: z.array(Window).default([]),
      poll_active_s: z.number().int().positive().default(60),
      poll_idle_s: z.number().int().positive().default(600),
    })
    .prefault({}),
  scan: z
    .object({
      // Cron with seconds field (croner). Default 03:00 -- clear of WUD's 01:00 watch
      // and the blackout window that covers it.
      cron: z.string().default('0 0 3 * * *'),
    })
    .prefault({}),
  defaults: z
    .object({
      patch: Tier.default('auto'),
      minor: Tier.default('auto'),
      // Majors are forced to manual by the policy engine regardless of what is set
      // here; the key exists so the intent is legible in the file.
      major: Tier.default('manual'),
      digest: Tier.default('manual'),
      soak: z.string().default('0h'),
    })
    .prefault({}),
  claude: z
    .object({
      // advisory: a verdict can demote an auto-merge to hold, never promote. Absence of
      // a verdict degrades to the static policy (fail-open) -- that is today's trusted
      // WUD behaviour, so an API outage must not freeze every update.
      mode: z.enum(['advisory', 'off']).default('advisory'),
      block_on: z.array(z.enum(['block', 'caution'])).default(['block', 'caution']),
      min_confidence: z.enum(['low', 'medium', 'high']).default('medium'),
      model: z.string().default('claude-haiku-4-5-20251001'),
      monthly_budget_usd: z.number().positive().default(10),
    })
    .prefault({}),
  prs: z
    .object({
      // wud-coexist: only handle what WUD's auto trigger never touches (majors,
      // digests, non-auto tiers) so the two tools cannot contend for the same file.
      // Switch to `full` when WUD retires at M6.
      scope: z.enum(['wud-coexist', 'full']).default('wud-coexist'),
      // Ceiling on simultaneously open pull requests. A backlog of 21 arriving at once
      // is not a review queue, it is a wall -- and every one of them would need
      // rebasing as the others merge. New PRs open as older ones are merged or closed.
      max_open: z.number().int().positive().default(5),
      // false parks the engine entirely: updates are still detected and shown, but
      // nothing is pushed and no pull request is created.
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  deploy: z
    .object({
      serialize: z.boolean().default(true),
      health_window_s: z.number().int().positive().default(120),
    })
    .prefault({}),
  /** Stacks the tool must never touch. Its own stack is appended unconditionally --
   *  WUD's self-update crash-loop is not a mistake worth repeating. */
  exclude_stacks: z.array(z.string()).default([]),
})

export type Policy = z.infer<typeof PolicySchema>

const FALLBACK: Policy = PolicySchema.parse({})

let cached: { policy: Policy; raw: string } | null = null

/** Reads policy.yaml fresh from the repo. A malformed file is never fatal: the tool
 *  keeps running on the last good config (or defaults) and surfaces the error, because
 *  a syntax error should not take the updater offline. */
export function loadPolicy(): { policy: Policy; error?: string } {
  let raw: string
  try {
    raw = readFileSync(paths.policy, 'utf8')
  } catch {
    return { policy: cached?.policy ?? FALLBACK, error: `policy.yaml not found at ${paths.policy}` }
  }
  if (cached?.raw === raw) return { policy: cached.policy }
  try {
    const parsed = PolicySchema.parse(parseYaml(raw) ?? {})
    parsed.exclude_stacks = [...new Set([...parsed.exclude_stacks, 'dockhand'])]
    cached = { policy: parsed, raw }
    return { policy: parsed }
  } catch (err) {
    return {
      policy: cached?.policy ?? FALLBACK,
      error: `policy.yaml invalid: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** True when `now` falls inside any configured blackout window (local time). Windows
 *  may wrap past midnight. */
export function inBlackout(policy: Policy, now = new Date()): boolean {
  const mins = now.getHours() * 60 + now.getMinutes()
  return policy.sync.blackout.some((w) => {
    const [from, to] = w.split('-') as [string, string]
    const [fh, fm] = from.split(':').map(Number) as [number, number]
    const [th, tm] = to.split(':').map(Number) as [number, number]
    const start = fh * 60 + fm
    const end = th * 60 + tm
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
  })
}

/** "24h", "30m", "2d" -> milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(s.trim())
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2] as 's' | 'm' | 'h' | 'd'
  return n * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[unit]
}
