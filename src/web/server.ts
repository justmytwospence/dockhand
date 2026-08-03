import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configured, env, loadPolicy, inBlackout } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { buildUpdateDiff, type DiffHunk } from '../diff.ts'
import { parseImageRef } from '../images/ref.ts'
import { refLinks } from '../links.ts'
import { isScanning, scanOne } from '../scan.ts'
import { runScanNow } from '../scheduler.ts'
import { runProposePass } from '../propose/run.ts'
import { runAutoMerge } from '../gitops/automerge.ts'
import { PROMPTS, prompt, savePrompt, resetPrompt, isCustomised, type PromptName } from '../prompts/index.ts'
import {
  Dashboard,
  PendingSections,
  ScanStatus,
  type PendingRow,
  type ScanInfo,
} from './views/dashboard.tsx'
import { DiffView } from './views/diff.tsx'
import { ImagesPage, ImagesTable, ImageRow, type StatusRow } from './views/images.tsx'
import { COLUMNS, RowNote } from './views/layout.tsx'
import { ActivityPage, ActivityTable, KINDS } from './views/activity.tsx'
import { SettingsPage, SettingsForm, RawPolicy, DigestPreview, PromptEditorFragment } from './views/settings.tsx'
import { AboutPage } from './views/about.tsx'
import { applySettings, SETTINGS } from '../settings.ts'
import { listModels } from '../analyze/models.ts'
import { flush as flushDigest, pending as pendingDigest, render as renderDigest } from '../notify/digest.ts'
import { activeChannels } from '../notify/index.ts'
import { configured as emailConfigured, send as sendEmail, escapeHtml as escapeText } from '../notify/email.ts'
import { rescheduleScan, rescheduleDigest } from '../scheduler.ts'
import { readFileSync as readFile } from 'node:fs'
import { paths } from '../config.ts'
import { SystemPage, MergePreview, type SpendRow, type DeployRow, type ModelTierRow } from './views/system.tsx'

const PENDING_SQL = `
  SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude,
         u.tier, u.state, u.detail, p.number AS pr_number,
         v.recommendation, v.confidence, p.scope AS pr_scope
  FROM updates u
  LEFT JOIN pr_updates pu ON pu.update_id = u.id
  LEFT JOIN prs p ON p.id = pu.pr_id AND p.state = 'open'
  LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag
                      AND v.to_tag = u.to_tag AND v.error IS NULL
  WHERE u.state IN ('detected','pr_open','held')
  ORDER BY CASE u.magnitude WHEN 'major' THEN 0 WHEN 'minor' THEN 1
                            WHEN 'patch' THEN 2 ELSE 3 END, u.stack, u.service`

/** Missing configuration, passed into every page so the banner is unmissable. */
function missing(): { name: string; why: string }[] {
  const s = configured()
  return s.ok ? [] : s.missing
}

export function createApp(): Hono {
  const app = new Hono()

  // Authelia fronts every route (T1 router), so the app itself carries no auth. The
  // health endpoint is the container healthcheck's target and is never routed publicly.
  app.get('/health', (c) => c.json({ ok: true }))

  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }))

  /**
   * The service worker, at the root.
   *
   * Scope is the reason: a worker served from /static/ can only control /static/, which
   * is useless -- it could not see the pages it exists to leave alone. Served here it
   * controls the whole origin. `Service-Worker-Allowed` is belt and braces for the same
   * thing, and `no-cache` means a corrected worker actually reaches the browser.
   */
  app.get('/sw.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    c.header('Service-Worker-Allowed', '/')
    return c.body(swSource())
  })

  app.get('/', (c) => {
    const { policy, error } = loadPolicy()
    const db = getDb()
    const services = scanRepo(env.repoDir, policy.exclude_stacks)
    const pending = db.prepare(PENDING_SQL).all() as PendingRow[]
    const recent = db
      .prepare(`SELECT * FROM events ORDER BY at DESC LIMIT 10`)
      .all() as Record<string, unknown>[]
    return c.html(
      Dashboard({ missing: missing(),
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
    const scopeFilter = c.req.query('prscope') ?? 'all'
    const pending = filterByScope(
      getDb().prepare(PENDING_SQL).all() as PendingRow[],
      scopeFilter,
    )
    return c.html(
      PendingSections({ pending, repo: env.githubRepo, scopeFilter }) as string,
    )
  })

  /** The exact one-line change a PR would make, rendered on first expand. */
  app.get('/updates/:id/diff', (c) => {
    const id = Number(c.req.param('id'))
    const result = buildUpdateDiff(id)
    const db = getDb()
    const pr = db
      .prepare(
        `SELECT p.number, p.scope FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
         WHERE pu.update_id = ? AND p.state = 'open'`,
      )
      .get(id) as { number: number; scope: string } | undefined

    // Links point at the TARGET tag: this panel is where the merge decision happens.
    const row = db
      .prepare(
        `SELECT u.image, u.to_tag, r.source_url FROM updates u
         JOIN images i ON i.stack = u.stack AND i.service = u.service
         LEFT JOIN resolutions r ON r.registry = i.registry AND r.repository = i.repository
         WHERE u.id = ?`,
      )
      .get(id) as { image: string; to_tag: string; source_url: string | null } | undefined

    const proposal = pr
      ? (db
          .prepare(
            `SELECT summary, notes, changed, error, model, hunks FROM proposals
             WHERE pr_id = (SELECT id FROM prs WHERE number = ?) ORDER BY id DESC LIMIT 1`,
          )
          .get(pr.number) as
          | {
              summary: string
              notes: string
              changed: string
              error: string | null
              model: string
              hunks: string | null
            }
          | undefined)
      : undefined

    return c.html(
      DiffView({
        result,
        links: row ? refLinks(parseImageRef(row.image), row.to_tag, row.source_url) : undefined,
        prNumber: pr?.number ?? null,
        prUrl: pr ? `https://github.com/${env.githubRepo}/pull/${pr.number}` : null,
        prScope: pr?.scope ?? null,
        proposal: proposal
          ? {
              summary: proposal.summary,
              notes: JSON.parse(proposal.notes) as string[],
              changed: JSON.parse(proposal.changed ?? '[]') as string[],
              error: proposal.error,
              model: proposal.model,
              hunks: JSON.parse(proposal.hunks ?? '[]') as DiffHunk[],
            }
          : undefined,
        canPropose: !!pr && pr.scope === 'tag-only',
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

  /** `?poll=0` for the mobile More sheet -- same text, no self-refreshing id. */
  app.get('/scan/status', (c) =>
    c.html(ScanStatus({ scan: scanInfo(), poll: c.req.query('poll') !== '0' }) as string),
  )

  /** Rolling-tag movement acknowledged: nothing to change in git, so just clear it. */
  app.post('/updates/:id/dismiss', (c) => {
    const id = Number(c.req.param('id'))
    getDb()
      .prepare(
        `UPDATE updates SET state = 'superseded', detail = 'dismissed', updated_at = ?
         WHERE id = ? AND state IN ('detected','held')`,
      )
      .run(new Date().toISOString(), id)
    return c.html(
      RowNote({ cols: COLUMNS.pending, cls: 'dismissed', children: 'dismissed' }) as string,
    )
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
      return c.html(RowNote({ cols: COLUMNS.pending, children: 'no longer held' }) as string)
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
      RowNote({
        cols: COLUMNS.pending,
        children: 'queued \u2014 a PR opens on the next cycle',
      }) as string,
    )
  })

  /** Draft config changes for one pull request on demand. */
  app.post('/prs/:number/propose', async (c) => {
    const number = Number(c.req.param('number'))
    const r = await runProposePass(number)
    if (r.drafted > 0) {
      return c.html('<span class="sub">drafted — reload to see the changes</span>')
    }
    if (r.failed > 0) return c.html('<span class="sub">could not draft; see the activity log</span>')
    return c.html('<span class="sub">nothing to draft for this pull request</span>')
  })

  /** What auto-merge would do right now, decided by the code that does it. */
  /**
   * What auto-merge would do right now, decided by the code that actually does it.
   *
   * Reachable from the System page. It was an orphan endpoint for a while -- no view
   * linked to it -- which is how its markup drifted out of step with everything else.
   */
  app.get('/merge/preview', async (c) => {
    const r = await runAutoMerge(true)
    const { policy } = loadPolicy()
    return c.html(MergePreview({ decisions: r.decisions, auto: policy.merge.auto }) as string)
  })

  app.get('/images', (c) => {
    const { policy } = loadPolicy()
    const filter = c.req.query('filter') ?? 'all'
    const q = (c.req.query('q') ?? '').trim()
    const grouped = c.req.query('group') === 'stack'
    const statusMap = statuses()
    const shown = filterServices(
      scanRepo(env.repoDir, policy.exclude_stacks),
      filter,
      q,
      statusMap,
    )
    // htmx requests want just the table; a normal navigation wants the whole page.
    if (c.req.header('hx-request')) {
      return c.html(ImagesTable({ services: shown, statusMap, grouped }) as string)
    }
    return c.html(
      ImagesPage({ missing: missing(), services: shown, filter, q, grouped, statusMap }) as string,
    )
  })

  /** Re-check one service, so a label edit can be confirmed without a 150s sweep. */
  app.post('/images/:stack/:service/check', async (c) => {
    const { policy } = loadPolicy()
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    // The row swaps itself in place, so it has to be rendered in the same shape the
    // table around it is using -- grouped rows carry no stack prefix.
    const grouped = c.req.query('group') === 'stack'
    const svc = scanRepo(env.repoDir, policy.exclude_stacks).find(
      (s) => s.stack === stack && s.service === service,
    )
    // Five columns, not six: this row lands in the images table, which has no
    // Analysis or PR column. It claimed six for months.
    if (!svc) {
      return c.html(RowNote({ cols: COLUMNS.images, children: 'no such service' }) as string, 404)
    }
    if (svc.watched) await scanOne(svc, policy)
    return c.html(
      ImageRow({ svc, status: statuses().get(`${stack}/${service}`), grouped }) as string,
    )
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
    return c.html(ActivityPage({ missing: missing(), rows, filter: { kind, level }, repo: env.githubRepo }) as string)
  })

  const promptStates = () =>
    (Object.keys(PROMPTS) as PromptName[]).map((name) => ({
      name,
      body: prompt(name),
      customised: isCustomised(name),
    }))

  app.get('/settings', async (c) => {
    const { policy } = loadPolicy()
    return c.html(
      SettingsPage({
        missing: missing(),
        policy,
        models: await listModels(),
        prompts: promptStates(),
      }) as string,
    )
  })

  /** Prompts live in the database, not policy.yaml -- saved and reset on their own. */
  app.post('/settings/prompt/:name', async (c) => {
    const name = c.req.param('name') as PromptName
    if (!(name in PROMPTS)) return c.text('unknown prompt', 404)
    const form = await c.req.parseBody()
    savePrompt(name, typeof form.body === 'string' ? form.body : '')
    const state = { name, body: prompt(name), customised: isCustomised(name) }
    return c.html(PromptEditorFragment({ state }) as string)
  })

  app.post('/settings/prompt/:name/reset', (c) => {
    const name = c.req.param('name') as PromptName
    if (!(name in PROMPTS)) return c.text('unknown prompt', 404)
    resetPrompt(name)
    const state = { name, body: prompt(name), customised: false }
    return c.html(PromptEditorFragment({ state }) as string)
  })

  app.post('/settings', async (c) => {
    const form = await c.req.parseBody()
    const changes: Record<string, string> = {}
    for (const def of SETTINGS) {
      const v = form[def.path]
      if (typeof v === 'string') changes[def.path] = v
    }
    const result = applySettings(changes)
    // A schedule change should not wait for the old schedule to fire before applying.
    if (result.ok && result.applied.includes('scan.cron')) rescheduleScan()
    if (result.ok && result.applied.includes('notify.cron')) rescheduleDigest()
    const { policy } = loadPolicy()
    return c.html(SettingsForm({ policy, models: await listModels(), result }) as string)
  })

  /**
   * What the next digest would say, and a way to send it now.
   *
   * A batched notification is invisible until it fires, which makes it hard to trust and
   * hard to tune -- so the exact message is renderable on demand, by the same code that
   * sends it.
   */
  app.get('/settings/digest', (c) => {
    const { policy } = loadPolicy()
    const rows = pendingDigest()
    return c.html(
      DigestPreview({
        rows,
        message: renderDigest(rows),
        policy,
        channels: {
          alert: activeChannels('alert'),
          routine: activeChannels('routine'),
        },
        emailConfigured: emailConfigured(),
      }) as string,
    )
  })

  app.post('/settings/digest/send', async (c) => {
    const r = await flushDigest('manual')
    return c.html(
      r.sent > 0
        ? `<span class="sub">sent ${r.sent} item(s)</span>`
        : `<span class="sub">${r.skipped ?? 'nothing to send'}</span>`,
    )
  })

  /**
   * Prove the mail path end to end.
   *
   * SMTP is the one piece of this that fails silently and for reasons nothing else can
   * observe -- a wrong port, a relay that refuses the sender, TLS that only works on 465.
   * A button that reports the server's own error beats reading logs after the fact.
   */
  app.post('/settings/email/test', async (c) => {
    if (!emailConfigured()) {
      return c.html(
        '<span class="sub">SMTP_URL and MAIL_TO are not both set — nothing to test.</span>',
      )
    }
    const r = await sendEmail({
      subject: 'dockhand: test message',
      text: 'If you are reading this, dockhand can send you email.\n\nSent from the Settings page.',
    })
    return c.html(
      r.ok
        ? '<span class="sub">sent — check the inbox</span>'
        : `<span class="warn-text">${escapeText(r.error ?? 'failed')}</span>`,
    )
  })

  /** The mental model. Reads the live policy so it describes this deployment. */
  app.get('/about', (c) => {
    const { policy } = loadPolicy()
    return c.html(AboutPage({ missing: missing(), policy, repo: env.githubRepo }) as string)
  })

  app.get('/settings/raw', (c) => {
    try {
      return c.html(RawPolicy({ missing: missing(), text: readFile(paths.policy, 'utf8') }) as string)
    } catch (err) {
      return c.html(RawPolicy({ text: '', error: (err as Error).message }) as string)
    }
  })

  app.get('/system', (c) => {
    const { policy, error } = loadPolicy()
    const budgets = getDb().prepare(`SELECT * FROM budgets`).all() as Record<string, unknown>[]
    // Itemised from the per-call ledger: a single total says how much, never why.
    const spend = getDb()
      .prepare(
        `SELECT model, purpose, COUNT(*) AS calls, SUM(cost_usd) AS cost,
                SUM(input_tokens + cache_write_tokens + cache_read_tokens) AS tokens_in,
                SUM(output_tokens) AS tokens_out,
                SUM(cache_read_tokens) AS cached
         FROM llm_calls
         WHERE created_at >= ?
         GROUP BY model, purpose ORDER BY cost DESC`,
      )
      .all(new Date().toISOString().slice(0, 7) + '-01') as SpendRow[]
    const deploys = getDb()
      .prepare(
        `SELECT stack, services, strategy, ok, healthy, detail, created_at
         FROM deploys ORDER BY id DESC LIMIT 15`,
      )
      .all() as DeployRow[]
    // The track record for model-decided updates: what it would have done, and why not
    // when it declined.
    const modelTier = getDb()
      .prepare(
        `SELECT stack, service, from_tag, to_tag, magnitude, static_tier,
                promote, reason, enforced, created_at
         FROM model_tier_decisions ORDER BY id DESC LIMIT 25`,
      )
      .all() as ModelTierRow[]
    return c.html(
      SystemPage({ missing: missing(),
        policy,
        policyError: error,
        budgets,
        spend,
        deploys,
        modelTier,
        version: readPackageVersion(),
        blackout: inBlackout(policy),
        scan: scanInfo(),
      }) as string,
    )
  })

  return app
}

/** Read once: the file cannot change without the container restarting. */
let swCache: string | null = null

function swSource(): string {
  if (swCache === null) {
    try {
      swCache = readFileSync(join('./public', 'sw.js'), 'utf8')
    } catch {
      // Serving an empty worker is safe -- no fetch handler means no interception.
      swCache = ''
    }
  }
  return swCache
}

function statuses(): Map<string, StatusRow> {
  const rows = getDb()
    .prepare(
      // One join for every row's source repo, rather than a lookup per rendered cell.
      `SELECT i.stack, i.service, i.last_status, i.last_detail, i.constrained_from,
              r.source_url
       FROM images i
       LEFT JOIN resolutions r ON r.registry = i.registry AND r.repository = i.repository`,
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

/**
 * Rows without a pull request are never "edited" -- there is nothing to have edited --
 * so they stay visible under both All and Tag only.
 */
function filterByScope(rows: PendingRow[], filter: string): PendingRow[] {
  if (filter === 'edited') return rows.filter((r) => r.pr_scope === 'modified')
  if (filter === 'proposed') return rows.filter((r) => r.pr_scope === 'proposed')
  if (filter === 'tag-only') {
    return rows.filter((r) => r.pr_scope !== 'modified' && r.pr_scope !== 'proposed')
  }
  return rows
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
