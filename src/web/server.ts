import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { env, loadPolicy, inBlackout } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo } from '../compose/scan.ts'
import { isScanning } from '../scan.ts'
import { runScanNow } from '../scheduler.ts'
import { Dashboard, ScanStatus, type PendingRow, type ScanInfo } from './views/dashboard.tsx'
import { ImagesPage } from './views/images.tsx'
import { ActivityPage } from './views/activity.tsx'
import { SystemPage } from './views/system.tsx'

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
    const pending = db
      .prepare(
        `SELECT id, stack, service, image, from_tag, to_tag, magnitude, tier, state, detail
         FROM updates WHERE state IN ('detected','pr_open','held')
         ORDER BY CASE magnitude WHEN 'major' THEN 0 WHEN 'minor' THEN 1
                                 WHEN 'patch' THEN 2 ELSE 3 END, stack, service`,
      )
      .all() as PendingRow[]
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
    return c.html('<tr class="dismissed"><td colspan="5" class="sub">dismissed</td></tr>')
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
      return c.html('<tr><td colspan="5" class="sub">no longer held</td></tr>')
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
      '<tr><td colspan="5" class="sub">queued &mdash; a PR opens on the next cycle</td></tr>',
    )
  })

  app.get('/images', (c) => {
    const { policy } = loadPolicy()
    const services = scanRepo(env.homelabRepo, policy.exclude_stacks)
    const statuses = getDb()
      .prepare(`SELECT stack, service, last_status, last_detail FROM images WHERE last_status IS NOT NULL`)
      .all() as { stack: string; service: string; last_status: string; last_detail: string | null }[]
    const statusMap = new Map(statuses.map((s) => [`${s.stack}/${s.service}`, s]))
    return c.html(
      ImagesPage({ services, filter: c.req.query('filter') ?? 'all', statusMap }) as string,
    )
  })

  app.get('/activity', (c) => {
    const rows = getDb()
      .prepare(`SELECT * FROM events ORDER BY at DESC LIMIT 200`)
      .all() as Record<string, unknown>[]
    return c.html(ActivityPage({ rows }) as string)
  })

  app.get('/system', (c) => {
    const { policy, error } = loadPolicy()
    const db = getDb()
    const budgets = db.prepare(`SELECT * FROM budgets`).all() as Record<string, unknown>[]
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
