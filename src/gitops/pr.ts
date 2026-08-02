import { Octokit } from 'octokit'
import { configured, env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo } from '../compose/scan.ts'
import { parseImageRef, formatImageRef } from '../images/ref.ts'
import { branchFor, groupUpdates, makeLookups, type GroupMember, type UpdateGroup } from '../groups.ts'
import { notify } from '../notify.ts'
import { foldGroupMagnitude, foldGroupTier, shouldOpenPr, type EffectiveTier } from '../policy.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { bumpImage } from './editor.ts'
import { authorArgs, ensureWorkRepo, git, httpsUrl, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'

/**
 * Turning detected updates into pull requests.
 *
 * The PR is the review surface: it carries the diff, the changelog analysis, and the
 * merge decision. Merging one is what makes the change real.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

function repoParts(): { owner: string; repo: string } {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  return { owner, repo }
}

const LABELS: Record<string, string> = {
  'image-update': '0e8a16',
  major: 'b60205',
  minor: 'fbca04',
  patch: 'c2e0c6',
  digest: 'c5def5',
  'needs-analysis': 'd4c5f9',
  'claude-hold': 'fbca04',
  'claude-block': 'b60205',
}

let labelsEnsured = false

async function ensureLabels(): Promise<void> {
  if (labelsEnsured) return
  labelsEnsured = true
  const { owner, repo } = repoParts()
  for (const [name, color] of Object.entries(LABELS)) {
    try {
      await gh().rest.issues.createLabel({ owner, repo, name, color })
    } catch {
      // Already exists, which is the expected case after the first run.
    }
  }
}

export interface PrRunResult {
  opened: number
  skipped: number
  failed: number
  paused?: string
}

/**
 * One pass: sync, group what is eligible, and open a PR per group up to the configured
 * ceiling.
 */
export async function runPrPass(): Promise<PrRunResult> {
  return withGitLock('pr-pass', async () => {
    const { policy } = loadPolicy()
    const out: PrRunResult = { opened: 0, skipped: 0, failed: 0 }

    const setup = configured()
    if (!setup.ok) {
      out.paused = `not configured: ${setup.missing.map((m) => m.name).join(', ')}`
      return out
    }
    if (!env.githubToken) {
      out.paused = 'GITHUB_TOKEN is not set'
      return out
    }

    const sync = await syncMain()
    if (sync.status === 'paused' || sync.status === 'refused') {
      out.paused = sync.reason
      return out
    }

    const groups = eligibleGroups(policy)
    if (groups.length === 0) return out

    const openNow = countOpenPrs()
    const room = Math.max(0, policy.prs.max_open - openNow)
    if (room === 0) {
      logEvent({
        level: 'info',
        kind: 'pr',
        message: `holding ${groups.length} update(s): ${openNow} pull requests already open`,
        detail: `raise prs.max_open to open more at once`,
      })
      out.skipped = groups.length
      return out
    }

    await ensureLabels()
    const repoDir = await ensureWorkRepo()

    for (const group of groups.slice(0, room)) {
      try {
        const created = await openPr(repoDir, group, policy)
        if (created) out.opened++
        else out.skipped++
      } catch (err) {
        out.failed++
        logEvent({
          level: 'error',
          kind: 'pr',
          stack: group.members[0]!.stack,
          message: 'failed to open a pull request',
          detail: (err as Error).message,
        })
      }
    }
    out.skipped += Math.max(0, groups.length - room)

    if (out.opened > 0) {
      await notify({
        title: `dockhand: ${out.opened} pull request(s) opened`,
        body: groups
          .slice(0, out.opened)
          .map((g) => `${g.members[0]!.stack}: ${describe(g)}`)
          .join('\n'),
        tags: ['inbox_tray'],
        click: `https://github.com/${env.githubRepo}/pulls`,
      })
    }
    return out
  })
}

/** Pending updates that policy says deserve a PR, grouped so companions travel together. */
function eligibleGroups(policy: Policy): UpdateGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.detail
       FROM updates u
       WHERE u.state = 'detected'
         AND NOT EXISTS (SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                         WHERE pu.update_id = u.id AND p.state = 'open')
       ORDER BY u.id`,
    )
    .all() as (GroupMember & { detail: string | null })[]

  const candidates = rows.filter((r) =>
    shouldOpenPr({
      scope: policy.prs.scope,
      tier: r.tier as EffectiveTier,
      magnitude: r.magnitude as Magnitude,
      rolling: r.detail === 'rolling',
    }),
  )
  if (candidates.length === 0) return []

  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  const { sourceRepoFor, groupLabelFor } = makeLookups(services)
  return groupUpdates(candidates, sourceRepoFor, groupLabelFor)
}

function countOpenPrs(): number {
  return (getDb().prepare(`SELECT COUNT(*) c FROM prs WHERE state = 'open'`).get() as { c: number })
    .c
}

async function openPr(repoDir: string, group: UpdateGroup, policy: Policy): Promise<boolean> {
  const branch = branchFor(group)
  const members = group.members
  const stack = members[0]!.stack

  // Always cut from the freshly-fetched origin tip, never from whatever the work clone
  // happened to be on.
  await git(repoDir, ['checkout', '-B', branch, 'origin/main'])

  const files = new Map<string, string>()
  for (const m of members) {
    const file = composeFileFor(m.stack, m.service)
    if (!file) return failGroup(group, `no compose file recorded for ${m.stack}/${m.service}`)
    const oldRef = m.image
    const newRef = rewriteRef(oldRef, m.to_tag)
    if (!newRef) return failGroup(group, `cannot build a new reference from "${m.to_tag}"`)

    const edit = await bumpImage({
      repoDir,
      composeFile: file,
      service: m.service,
      expectedOldRef: oldRef,
      newRef,
    })
    if (!edit.ok) return failGroup(group, edit.reason)
    files.set(file, file)
  }

  const title = prTitle(group)
  await git(repoDir, [...authorArgs(), 'commit', '-am', title])
  const sha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout

  const push = await pushBranch(repoDir, branch)
  if (!push.ok) return failGroup(group, push.reason)

  const { owner, repo } = repoParts()
  const created = await gh().rest.pulls.create({
    owner,
    repo,
    base: 'main',
    head: branch,
    title,
    body: prBody(group, policy),
  })
  const number = created.data.number

  await gh().rest.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels: ['image-update', foldGroupMagnitude(members.map((m) => m.magnitude as Magnitude)), 'needs-analysis'],
  })

  recordPr({ number, branch, sha, groupKey: group.key, memberIds: members.map((m) => m.id) })
  logEvent({
    level: 'info',
    kind: 'pr',
    stack,
    service: members.length === 1 ? members[0]!.service : undefined,
    message: `opened #${number}: ${describe(group)}`,
    detail: members.length > 1 ? `${members.length} services move together` : undefined,
  })
  return true
}

async function pushBranch(
  repoDir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const known = getDb()
    .prepare(`SELECT head_sha_pushed, user_owned FROM prs WHERE branch = ? AND state = 'open'`)
    .get(branch) as { head_sha_pushed: string; user_owned: number } | undefined

  const remote = await git(repoDir, ['ls-remote', httpsUrl(), `refs/heads/${branch}`], {
    remote: true,
    allowFail: true,
  })
  const remoteSha = remote.stdout.split('\t')[0] ?? ''

  if (remoteSha) {
    // The branch exists upstream. Only overwrite it if it is still exactly what we last
    // pushed -- anything else means a human has been editing it.
    if (!known || known.head_sha_pushed !== remoteSha || known.user_owned) {
      return {
        ok: false,
        reason: `branch ${branch} has been modified upstream; leaving it alone`,
      }
    }
    const forced = await git(repoDir, ['push', '--force-with-lease', httpsUrl(), branch], {
      remote: true,
      allowFail: true,
    })
    if (forced.exitCode !== 0) return { ok: false, reason: forced.stderr.slice(0, 200) }
    return { ok: true }
  }

  const pushed = await git(repoDir, ['push', '-u', httpsUrl(), branch], {
    remote: true,
    allowFail: true,
  })
  if (pushed.exitCode !== 0) return { ok: false, reason: pushed.stderr.slice(0, 200) }
  return { ok: true }
}

function failGroup(group: UpdateGroup, reason: string): boolean {
  logEvent({
    level: 'warn',
    kind: 'pr',
    stack: group.members[0]!.stack,
    message: 'skipped opening a pull request',
    detail: reason,
  })
  return false
}

function recordPr(opts: {
  number: number
  branch: string
  sha: string
  groupKey: string | null
  memberIds: number[]
}): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    const info = db
      .prepare(
        // Explicitly tag-only: the editor's gates guarantee the commit touched nothing
        // else. A compose-editing feature would set 'modified' here instead.
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at)
         VALUES (?, ?, ?, 'open', ?, 'tag-only', ?)`,
      )
      .run(opts.number, opts.branch, opts.sha, opts.groupKey, now)
    const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    const mark = db.prepare(`UPDATE updates SET state = 'pr_open', updated_at = ? WHERE id = ?`)
    for (const id of opts.memberIds) {
      link.run(info.lastInsertRowid, id)
      mark.run(now, id)
    }
  })()
}

// ------------------------------------------------------------------ rendering

function describe(g: UpdateGroup): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  return `${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}

function prTitle(g: UpdateGroup): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  return `chore(deps): ${m.stack}: bump ${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}

function prBody(g: UpdateGroup, policy: Policy): string {
  const m0 = g.members[0]!
  const magnitude = foldGroupMagnitude(g.members.map((m) => m.magnitude as Magnitude))
  const tier = foldGroupTier(g.members.map((m) => m.tier as EffectiveTier))

  const rows = g.members
    .map((m) => `| \`${m.service}\` | \`${m.image}\` | \`${short(m.from_tag)}\` | \`${short(m.to_tag)}\` |`)
    .join('\n')

  const grouped =
    g.members.length > 1
      ? `\n> These services are pinned to the same version upstream and are bumped together —\n> merging them separately would leave the stack running mismatched versions.\n`
      : ''

  const analysis =
    policy.claude.mode === 'off'
      ? '_Changelog analysis is disabled._'
      : '_Changelog analysis has not run yet._'

  return `**${magnitude}** update · policy tier \`${tier}\`
${grouped}
| Service | Image | From | To |
|---|---|---|---|
${rows}

<!-- dockhand:verdict:start -->
### Changelog analysis

${analysis}
<!-- dockhand:verdict:end -->

---
<sub>Opened by [dockhand](https://github.com/justmytwospence/dockhand). Merging this deploys the change on the host.</sub>
<!-- dockhand: stack=${m0.stack} services=${g.members.map((m) => m.service).join(',')} from=${m0.from_tag} to=${m0.to_tag} -->`
}

function short(ref: string): string {
  const at = ref.indexOf('@sha256:')
  return at === -1 ? ref : `${ref.slice(0, at)}@${ref.slice(at + 8, at + 20)}`
}

function composeFileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  return row?.compose_file ?? null
}

function rewriteRef(currentRef: string, toTag: string): string | null {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at === -1) return formatImageRef(ref, toTag, null)
  const tag = toTag.slice(0, at) || ref.tag
  return formatImageRef(ref, tag, toTag.slice(at + 1))
}
