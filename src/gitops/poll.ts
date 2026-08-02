import { Octokit } from 'octokit'
import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from '../notify.ts'
import { withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'
import { deployForPr, type DeployTarget } from '../deploy/run.ts'

/**
 * Watching for merges.
 *
 * Polling rather than a webhook: it needs no inbound exposure, no shared secret, and no
 * replay handling, and 60 seconds of latency between merging and deploying is not worth
 * any of that. GitHub's authenticated budget makes the request cost irrelevant.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

export interface PollResult {
  merged: number
  closed: number
  checked: number
}

export async function pollPrs(): Promise<PollResult> {
  const out: PollResult = { merged: 0, closed: 0, checked: 0 }
  if (!env.githubToken) return out

  const open = getDb()
    .prepare(
      `SELECT id, number, branch, group_key, head_sha_pushed, scope, scope_sha
       FROM prs WHERE state = 'open'`,
    )
    .all() as {
    id: number
    number: number
    branch: string
    head_sha_pushed: string
    scope: string
    scope_sha: string | null
  }[]
  if (open.length === 0) return out

  const [owner, repo] = env.githubRepo.split('/') as [string, string]

  for (const pr of open) {
    out.checked++
    let data
    try {
      data = (await gh().rest.pulls.get({ owner, repo, pull_number: pr.number })).data
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'pr',
        message: `could not read pull request #${pr.number}`,
        detail: (err as Error).message,
      })
      continue
    }

    // A head that no longer matches what we pushed means a human edited the branch.
    // From then on it is theirs: never force-pushed, never regenerated. Restoring it
    // to dockhand's own commit hands ownership back, since there is nothing of theirs
    // left on it.
    const owned = data.head.sha !== pr.head_sha_pushed
    getDb().prepare(`UPDATE prs SET user_owned = ? WHERE id = ?`).run(owned ? 1 : 0, pr.id)

    // Re-classify whenever the head has moved since the last classification -- in
    // either direction, so an edit that is later reverted stops being reported as one.
    if (data.state === 'open' && data.head.sha !== pr.scope_sha) {
      await classifyScope(pr.id, pr.number, pr.scope, data.head.sha, !owned)
    }

    if (data.state === 'open') continue

    if (data.merged_at) {
      out.merged++
      await onMerged(pr.id, pr.number)
    } else {
      out.closed++
      onClosed(pr.id, pr.number)
    }
  }

  return out
}

/**
 * Does this pull request still contain only the image-tag change dockhand wrote?
 *
 * Called when a branch's head has moved past what dockhand pushed. Some updates
 * genuinely require more than a tag bump -- an upstream that renames its image, say --
 * and a branch carrying that work must be visibly different from a clean bump, because
 * nothing has reviewed the extra changes.
 *
 * Errs toward `modified`: mislabelling an edited PR as clean is the expensive direction,
 * since auto-merge will one day trust this field.
 */
export function classifyPatch(
  files: { filename: string; patch?: string }[],
  truncated: boolean,
): 'tag-only' | 'modified' {
  if (truncated) return 'modified'
  for (const f of files) {
    if (!f.filename.endsWith('docker-compose.yaml')) return 'modified'
    for (const line of (f.patch ?? '').split('\n')) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue
      // Same test the editor and the repo's own commit script use.
      if (!/^[+-]\s*image:\s/.test(line)) return 'modified'
    }
  }
  return 'tag-only'
}

async function classifyScope(
  prId: number,
  number: number,
  was: string,
  headSha: string,
  dockhandOwns: boolean,
): Promise<void> {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  let scope: 'tag-only' | 'modified' | 'proposed'
  try {
    const res = await gh().rest.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 })
    scope = classifyPatch(res.data, res.data.length >= 100)
    // dockhand's own drafted config changes are not a human edit. The patch test cannot
    // tell them apart -- both are "more than an image line" -- so ownership decides:
    // the head is still exactly what dockhand pushed, and a proposal was recorded
    // against it. Without this the next poll relabels every proposal as `modified` and
    // the distinction disappears within one cycle.
    if (dockhandOwns && scope === 'modified' && hasProposal(prId)) scope = 'proposed'
  } catch {
    // Unknown is not the same as clean; leave whatever was there rather than guessing,
    // and do not record the sha, so the next poll retries.
    return
  }

  getDb().prepare(`UPDATE prs SET scope = ?, scope_sha = ? WHERE id = ?`).run(scope, headSha, prId)
  if (scope === was) return
  logEvent({
    level: 'info',
    kind: 'pr',
    message:
      scope === 'modified'
        ? `#${number} now contains changes beyond the image tag`
        : scope === 'proposed'
          ? `#${number} carries dockhand's drafted config changes`
          : `#${number} is back to an image-tag change only`,
    detail: scope === 'tag-only' ? undefined : 'it will always need a human to merge',
  })
}

/** Did dockhand successfully draft config changes onto this pull request? */
function hasProposal(prId: number): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM proposals WHERE pr_id = ? AND error IS NULL LIMIT 1`)
    .get(prId)
}

async function onMerged(prId: number, number: number): Promise<void> {
  const { policy } = loadPolicy()
  const db = getDb()
  const now = new Date().toISOString()
  const members = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.to_tag FROM updates u
       JOIN pr_updates pu ON pu.update_id = u.id WHERE pu.pr_id = ?`,
    )
    .all(prId) as { id: number; stack: string; service: string; to_tag: string }[]

  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'merged', merged_at = ? WHERE id = ?`).run(now, prId)
    const mark = db.prepare(`UPDATE updates SET state = 'merged', updated_at = ? WHERE id = ?`)
    for (const m of members) mark.run(now, m.id)
  })()

  // Land it in the live checkout so the deploy runs against merged content.
  const sync = await withGitLock('post-merge-sync', () => syncMain())

  const stack = members[0]?.stack ?? 'unknown'
  const services = members.map((m) => m.service).join(' ')
  const command = `docker compose -f ${stack}/docker-compose.yaml up -d ${services}`

  if (sync.status === 'paused' || sync.status === 'refused') {
    logEvent({
      level: 'warn',
      kind: 'pr',
      stack,
      message: `#${number} merged, but the checkout could not be updated`,
      detail: sync.reason,
    })
    await notify({
      title: `dockhand: #${number} merged, sync blocked`,
      body: `${sync.reason}\n\nOnce resolved, deploy with:\n${command}`,
      priority: 4,
      tags: ['warning'],
    })
    return
  }

  logEvent({
    level: 'info',
    kind: 'pr',
    stack,
    message: `#${number} merged and synced`,
    detail: policy.deploy.mode === 'auto' ? 'deploying' : `deploy with: ${command}`,
  })

  if (policy.deploy.mode !== 'auto') {
    // Not deploying: the notification carries the exact command so it is one paste
    // rather than a lookup.
    await notify({
      title: `dockhand: #${number} merged`,
      body: `${stack}: ${services}\n\nDeploy with:\n${command}`,
      tags: ['white_check_mark'],
      click: `https://github.com/${env.githubRepo}/pull/${number}`,
    })
    return
  }

  const target: DeployTarget = {
    stack,
    services: [...new Set(members.map((m) => m.service))],
    // rm-first if any member asked for it: the strategy applies to the whole compose
    // invocation, and the safer of the two wins.
    strategy: members.some((m) => deployLabelFor(m.stack, m.service) === 'rm-first')
      ? 'rm-first'
      : 'up',
  }
  const outcome = await deployForPr(number, target);

  if (outcome.ok && outcome.healthy) {
    await notify({
      title: `dockhand: #${number} merged and deployed`,
      body: `${stack}: ${outcome.detail}`,
      tags: ['white_check_mark'],
      click: `https://github.com/${env.githubRepo}/pull/${number}`,
    })
  }
  // Failures notify from deployForPr, which knows how they failed.
}

/** The service's `dockhand.deploy` label, as recorded by the last scan. */
function deployLabelFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT deploy_label FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { deploy_label: string | null } | undefined
  return row?.deploy_label ?? null
}

function onClosed(prId: number, number: number): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(prId)
    db.prepare(
      `UPDATE updates SET state = 'superseded', detail = 'pr-closed', updated_at = ?
       WHERE id IN (SELECT update_id FROM pr_updates WHERE pr_id = ?)`,
    ).run(now, prId)
  })()
  logEvent({
    level: 'info',
    kind: 'pr',
    message: `#${number} was closed without merging`,
    detail: 'the update will be re-detected on the next scan unless the tag moves on',
  })
}

/** True while any dockhand PR is open, which is what decides the poll cadence. */
export function hasOpenPrs(): boolean {
  return (
    (getDb().prepare(`SELECT COUNT(*) c FROM prs WHERE state = 'open'`).get() as { c: number }).c > 0
  )
}

export function pollIntervalMs(): number {
  const { policy } = loadPolicy()
  return (hasOpenPrs() ? policy.sync.poll_active_s : policy.sync.poll_idle_s) * 1000
}
