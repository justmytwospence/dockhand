import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { env, loadPolicy, inBlackout } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { buildUpdateDiff } from '../diff.ts'
import { isScanning, scanOne } from '../scan.ts'
import { runScanNow } from '../scheduler.ts'
import {
  Dashboard,
  PendingSections,
  ScanStatus,
  type PendingRow,
  type ScanInfo,
} from './views/dashboard.tsx'
import { DiffView } from './views/diff.tsx'
import { ImagesPage, ImagesTable, ImageRow, type StatusRow } from './views/images.tsx'
import { ActivityPage, ActivityTable, KINDS } from './views/activity.tsx'
import { SystemPage } from './views/system.tsx'

const PENDING_SQL = `
  SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude,
         u.tier, u.state, u.detail, p.number AS pr_number,
         v.recommendation, v.confidence
  FROM updates u
  LEFT JOIN pr_updates pu ON pu.update_id = u.id
  LEFT JOIN prs p ON p.id = pu.pr_id AND p.state = 'open'
  LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag
                      AND v.to_tag = u.to_tag AND v.error IS NULL
  WHERE u.state IN ('detected','pr_open','held')
  ORDER BY CASE u.magnitude WHEN 'major' THEN 0 WHEN 'minor' THEN 1
                            WHEN 'patch' THEN 2 ELSE 3 END, u.stack, u.service`

export function createApp(): Hono {
  const app = new Hono()

  // Authelia fronts every route (T1 router), so the app itself carries no auth. The
  // health endpoint is the container healthcheck's target and is never routed publicly.
  app.get('/health', (c) => c.json({ ok: true }))

  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }))

  app.get('/', (c) => {
    const { policy, error } = loadPolicy()
    const db = getDb()
    const services = scanRepo(env.homelabRepo, policy.exclude_stacks)
    const pending = db.prepare(PENDING_SQL).all() as PendingRow[]
    const recent = db
      .prepare(`SELECT * FROM events ORDER BY at DESC LIMIT 10`)
      .all() as Record<string, unknown>[]
    return c.html(
      Dashboard({
        policy,
        policyError: error,
        services,
        pending,
        recent,
        blackout: inBlackout(policy),
        scan: scanInfo(),
        repo: env.githubRepo,
      }) as string,
    )
  })

  /** The pending region alone, so it can refresh itself while a scan runs. */
  app.get('/fragments/pending', (c) => {
    const pending = getDb().prepare(PENDING_SQL).all() as PendingRow[]
    return c.html(PendingSections({ pending, repo: env.githubRepo }) as string)
  })

  /** The exact one-line change a PR would make, rendered on first expand. */
  app.get('/updates/:id/diff', (c) => {
    const id = Number(c.req.param('id'))
    const result = buildUpdateDiff(id)
    const pr = getDb()
      .prepare(
        `SELECT p.number FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
         WHERE pu.update_id = ? AND p.state = 'open'`,
      )
      .get(id) as { number: number } | undefined
    return c.html(
      DiffView({
        result,
        prNumber: pr?.number ?? null,
        prUrl: pr ? `https://github.com/${env.githubRepo}/pull/${pr.number}` : null,
      }) as string,
    )
  })

  app.post('/scan', async (c) => {
    const result = await runScanNow()
    if (result.status === 'already-running') {
      return c.html('<span class="sub">a scan is already running&hellip;</span>')
    }
    return c.html(ScanStatus({ scan: scanInfo() }) as string)
  })

  app.get('/scan/status', (c) => c.html(ScanStatus({ scan: scanInfo() }) as string))

  /** Rolling-tag movement acknowledged: nothing to change in git, so just clear it. */
  app.post('/updates/:id/dismiss', (c) => {
    const id = Number(c.req.param('id'))
    getDb()
      .prepare(
        `UPDATE updates SET state = 'superseded', detail = 'dismissed', updated_at = ?
         WHERE id = ? AND state IN ('detected','held')`,
      )
      .run(new Date().toISOString(), id)
    return c.html('<tr class="dismissed"><td colspan="6" class="sub">dismissed</td></tr>')
  })

  /**
   * Promote a held update so the PR engine will pick it up. Held rows are the
   * datastores: their migrations are deliberate, so the PR only exists once a human
   * has decided to do one.
   */
  app.post('/updates/:id/open-pr', (c) => {
    const id = Number(c.req.param('id'))
    const row = getDb()
      .prepare(`SELECT stack, service FROM updates WHERE id = ? AND state = 'held'`)
      .get(id) as { stack: string; service: string } | undefined
    if (!row) {
      return c.html('<tr><td colspan="6" class="sub">no longer held</td></tr>')
    }
    getDb()
      .prepare(
        `UPDATE updates SET state = 'detected', tier = 'manual', updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id)
    logEvent({
      level: 'info',
      kind: 'pr',
      stack: row.stack,
      service: row.service,
      message: 'held update released for PR by operator',
    })
    return c.html(
      '<tr><td colspan="6" class="sub">queued &mdash; a PR opens on the next cycle</td></tr>',
    )
  })

  app.get('/images', (c) => {
    const { policy } = loadPolicy()
    const filter = c.req.query('filter') ?? 'all'
    const q = (c.req.query('q') ?? '').trim()
    const statusMap = statuses()
    const shown = filterServices(
      scanRepo(env.homelabRepo, policy.exclude_stacks),
      filter,
      q,
      statusMap,
    )
    // htmx requests want just the table; a normal navigation wants the whole page.
    if (c.req.header('hx-request')) {
      return c.html(ImagesTable({ services: shown, statusMap }) as string)
    }
    return c.html(ImagesPage({ services: shown, filter, q, statusMap }) as string)
  })

  /** Re-check one service, so a label edit can be confirmed without a 150s sweep. */
  app.post('/images/:stack/:service/check', async (c) => {
    const { policy } = loadPolicy()
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    const svc = scanRepo(env.homelabRepo, policy.exclude_stacks).find(
      (s) => s.stack === stack && s.service === service,
    )
    if (!svc) return c.html('<tr><td colspan="6" class="sub">no such service</td></tr>', 404)
    if (svc.watched) await scanOne(svc, policy)
    return c.html(ImageRow({ svc, status: statuses().get(`${stack}/${service}`) }) as string)
  })

  app.get('/activity', (c) => {
    const kind = c.req.query('kind') ?? 'all'
    const level = c.req.query('level') ?? 'all'
    const where: string[] = []
    const args: string[] = []
    if ((KINDS as readonly string[]).includes(kind)) {
      where.push('kind = ?')
      args.push(kind)
    }
    if (level === 'problems') where.push(`level IN ('warn','error')`)
    const rows = getDb()
      .prepare(
        `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY at DESC LIMIT 200`,
      )
      .all(...args) as Record<string, unknown>[]
    if (c.req.header('hx-request')) {
      return c.html(ActivityTable({ rows, repo: env.githubRepo }) as string)
    }
    return c.html(ActivityPage({ rows, filter: { kind, level }, repo: env.githubRepo }) as string)
  })

  app.get('/system', (c) => {
    const { policy, error } = loadPolicy()
    const budgets = getDb().prepare(`SELECT * FROM budgets`).all() as Record<string, unknown>[]
    return c.html(
      SystemPage({
        policy,
        policyError: error,
        budgets,
        version: readPackageVersion(),
        blackout: inBlackout(policy),
        scan: scanInfo(),
      }) as string,
    )
  })

  return app
}

function statuses(): Map<string, StatusRow> {
  const rows = getDb()
    .prepare(
      `SELECT stack, service, last_status, last_detail, constrained_from FROM images
       WHERE last_status IS NOT NULL OR constrained_from IS NOT NULL`,
    )
    .all() as StatusRow[]
  return new Map(rows.map((s) => [`${s.stack}/${s.service}`, s]))
}

function filterServices(
  services: ScannedService[],
  filter: string,
  q: string,
  statusMap: Map<string, StatusRow>,
): ScannedService[] {
  const needle = q.toLowerCase()
  return services.filter((s) => {
    if (filter === 'watched' && !s.watched) return false
    if (filter === 'unlabelled' && (s.watched || s.unwatchable)) return false
    if (filter === 'unwatchable' && !s.unwatchable) return false
    if (filter === 'attention' && !statusMap.get(`${s.stack}/${s.service}`)?.last_status) return false
    if (!needle) return true
    return `${s.stack} ${s.service} ${s.imageRaw ?? ''}`.toLowerCase().includes(needle)
  })
}

function scanInfo(): ScanInfo {
  const rows = getDb()
    .prepare(`SELECT key, value, window FROM budgets WHERE key LIKE 'scan.%'`)
    .all() as { key: string; value: number; window: string | null }[]
  const by = new Map(rows.map((r) => [r.key, r]))
  const lastAt = by.get('scan.last_at')?.window ?? null
  const durationS = by.get('scan.last_duration_s')?.value ?? null
  let counts: Record<string, number> | null = null
  const raw = by.get('scan.last_counts')?.window
  if (raw) {
    try {
      counts = JSON.parse(raw) as Record<string, number>
    } catch {
      counts = null
    }
  }
  return { lastAt, durationS, counts, running: isScanning() }
}

function readPackageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as
      { version: string }).version
  } catch {
    return 'unknown'
  }
}

export function startServer(): void {
  const app = createApp()
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[system] dockhand listening on :${info.port}`)
  })
}
