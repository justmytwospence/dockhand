import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { env, loadPolicy, inBlackout } from '../config.ts'
import { getDb } from '../db.ts'
import { scanRepo } from '../compose/scan.ts'
import { Dashboard } from './views/dashboard.tsx'
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
    const recent = db
      .prepare(`SELECT * FROM events ORDER BY at DESC LIMIT 10`)
      .all() as Record<string, unknown>[]
    return c.html(
      Dashboard({
        policy,
        policyError: error,
        services,
        recent,
        blackout: inBlackout(policy),
      }) as string,
    )
  })

  app.get('/images', (c) => {
    const { policy } = loadPolicy()
    const services = scanRepo(env.homelabRepo, policy.exclude_stacks)
    return c.html(ImagesPage({ services, filter: c.req.query('filter') ?? 'all' }) as string)
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
      }) as string,
    )
  })

  return app
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
