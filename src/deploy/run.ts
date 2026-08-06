import { execa } from 'execa'
import { join } from 'node:path'
import { env, inBlackout, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from '../notify/index.ts'

/**
 * Bringing a merged change up on the host.
 *
 * A change is not done when it is committed; it is done when it is running. Everything
 * before this point only rearranged text.
 *
 * Four things make this narrower than "run compose and hope":
 *
 * 1. **It must never deploy itself.** `docker compose up -d shipshape` replaces the
 *    container running this code, killing the process mid-command -- so the deploy
 *    reports nothing, the database records nothing, and the operator learns about it
 *    from a gap in the log. Excluded unconditionally, not by policy.
 *
 * 2. **Infrastructure comes up from the repository root.** Services in the root compose
 *    file depend on networks that file defines; running their directory's own compose
 *    fails with "refers to undefined network". They are addressed by service name from
 *    the root instead.
 *
 * 3. **An image bump does not re-read image-provided environment.** `up -d` clones the
 *    running container's config, so a variable baked into the old image survives into
 *    the new one and can point at a file that no longer exists. `shipshape.deploy:
 *    rm-first` forces the remove-then-create that re-reads it.
 *
 * 4. **A deploy that starts is not a deploy that worked.** Compose exits 0 as soon as
 *    the container is created; a service that crash-loops thirty seconds later still
 *    looks like success. Health is checked afterwards, and a failure is loud.
 */

export interface DeployTarget {
  stack: string
  services: string[]
  /** `rm-first` when any service asked for it. */
  strategy: 'up' | 'rm-first'
}

export type DeployOutcome =
  | { ok: true; healthy: boolean; detail: string }
  | { ok: false; reason: string; stderr?: string }

/** Services in the root compose file are addressed from the repository root. */
function isRootStack(stack: string): boolean {
  return stack === 'root'
}

export function composeArgs(target: DeployTarget): { cwd: string; args: string[] } {
  const cwd = env.repoDir
  if (isRootStack(target.stack)) {
    // No -f: the root compose file is the project, and its networks are defined there.
    return { cwd, args: ['compose', 'up', '-d', ...target.services] }
  }
  return {
    cwd,
    args: ['compose', '-f', `${target.stack}/docker-compose.yaml`, 'up', '-d', ...target.services],
  }
}

function removeArgs(target: DeployTarget): { cwd: string; args: string[] } {
  const cwd = env.repoDir
  const base = isRootStack(target.stack)
    ? ['compose']
    : ['compose', '-f', `${target.stack}/docker-compose.yaml`]
  return { cwd, args: [...base, 'rm', '-sf', ...target.services] }
}

/**
 * Why this deploy must not run, or null when it may.
 *
 * Separated from the execution so the reasons are testable without a Docker daemon,
 * and so the dashboard can explain a held deploy without attempting one.
 */
export function refuseReason(
  target: DeployTarget,
  opts: { selfStack: string; excluded: string[]; blackout: boolean },
): string | null {
  if (target.stack === opts.selfStack) {
    return 'shipshape does not deploy itself — the container running the deploy would be replaced mid-command'
  }
  if (opts.excluded.includes(target.stack)) return `${target.stack} is an excluded stack`
  if (target.services.length === 0) return 'no services to deploy'
  if (opts.blackout) return 'inside the configured blackout window'
  return null
}

export async function deploy(target: DeployTarget): Promise<DeployOutcome> {
  const { policy } = loadPolicy()
  const refusal = refuseReason(target, {
    selfStack: env.selfStack,
    excluded: policy.exclude_stacks,
    blackout: inBlackout(policy),
  })
  if (refusal) return { ok: false, reason: refusal }

  const started = Date.now()

  if (target.strategy === 'rm-first') {
    const rm = removeArgs(target)
    const r = await execa('docker', rm.args, { cwd: rm.cwd, reject: false, timeout: 120_000 })
    if ((r.exitCode ?? 1) !== 0) {
      return { ok: false, reason: 'could not remove the old container', stderr: tail(r.stderr) }
    }
  }

  const up = composeArgs(target)
  const r = await execa('docker', up.args, { cwd: up.cwd, reject: false, timeout: 600_000 })
  if ((r.exitCode ?? 1) !== 0) {
    return { ok: false, reason: 'compose failed', stderr: tail(r.stderr) }
  }

  const health = await settle(target, policy.deploy.health_window_s)
  const secs = Math.round((Date.now() - started) / 1000)
  return {
    ok: true,
    healthy: health.healthy,
    detail: health.healthy
      ? `${target.services.join(', ')} up in ${secs}s`
      : `${target.services.join(', ')} started but ${health.detail}`,
  }
}

/**
 * Wait for the containers to settle, and report what they settled into.
 *
 * Returns as soon as every container is running (and healthy, where a healthcheck
 * exists) rather than sleeping the full window, so a good deploy is fast and only a bad
 * one costs the wait.
 */
async function settle(
  target: DeployTarget,
  windowSeconds: number,
): Promise<{ healthy: boolean; detail: string }> {
  const deadline = Date.now() + windowSeconds * 1000
  let last = 'no container found'
  while (Date.now() < deadline) {
    const states = await Promise.all(target.services.map((s) => stateOf(target.stack, s)))
    const bad = states.filter((s) => s.state !== 'ok')
    if (bad.length === 0) return { healthy: true, detail: 'all healthy' }
    last = bad.map((b) => `${b.name}: ${b.detail}`).join('; ')
    // A container that has already given up will not recover by being watched.
    if (bad.some((b) => b.state === 'dead')) return { healthy: false, detail: last }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return { healthy: false, detail: `did not become healthy within ${windowSeconds}s — ${last}` }
}

async function stateOf(
  stack: string,
  service: string,
): Promise<{ name: string; state: 'ok' | 'waiting' | 'dead'; detail: string }> {
  const r = await execa(
    'docker',
    [
      'ps',
      '--all',
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.Names}}\t{{.State}}\t{{.Status}}',
    ],
    { reject: false, timeout: 20_000 },
  )
  const line = String(r.stdout ?? '')
    .split('\n')
    .find((l) => l.trim())
  if (!line) return { name: service, state: 'waiting', detail: 'no container yet' }
  const [name, state, status] = line.split('\t')
  if (state === 'running') {
    if (/unhealthy/i.test(status ?? '')) return { name: name!, state: 'dead', detail: 'unhealthy' }
    if (/health: starting/i.test(status ?? ''))
      return { name: name!, state: 'waiting', detail: 'health starting' }
    return { name: name!, state: 'ok', detail: status ?? 'running' }
  }
  if (state === 'restarting') return { name: name!, state: 'dead', detail: 'restart loop' }
  if (state === 'exited') return { name: name!, state: 'dead', detail: status ?? 'exited' }
  return { name: name!, state: 'waiting', detail: status ?? String(state) }
}

function tail(s: unknown): string {
  return String(s ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(-6)
    .join('\n')
    .slice(0, 600)
}

/** Run a deploy for a merged pull request and record what happened. */
export async function deployForPr(
  prNumber: number,
  target: DeployTarget,
): Promise<DeployOutcome> {
  const outcome = await deploy(target)
  const now = new Date().toISOString()

  getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, stack, services, strategy, ok, healthy, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      prNumber,
      target.stack,
      target.services.join(' '),
      target.strategy,
      outcome.ok ? 1 : 0,
      outcome.ok && outcome.healthy ? 1 : 0,
      outcome.ok ? outcome.detail : `${outcome.reason}${outcome.stderr ? `\n${outcome.stderr}` : ''}`,
      now,
    )

  if (!outcome.ok) {
    logEvent({
      level: 'error',
      kind: 'deploy',
      stack: target.stack,
      message: `deploy of ${target.stack} failed after #${prNumber} merged`,
      detail: `${outcome.reason}${outcome.stderr ? `\n${outcome.stderr}` : ''}`,
    })
    await notify({
      title: `shipshape: deploy failed — ${target.stack}`,
      body: `#${prNumber} merged but ${target.services.join(', ')} did not deploy.\n\n${outcome.reason}\n\nThe change is in the checkout; the service is running whatever it was.`,
      priority: 4,
      tags: ['rotating_light'],
    })
    return outcome
  }

  if (!outcome.healthy) {
    // Started but unhealthy is the dangerous outcome: it looks deployed and is not.
    logEvent({
      level: 'error',
      kind: 'deploy',
      stack: target.stack,
      message: `${target.stack} deployed but is not healthy`,
      detail: outcome.detail,
    })
    await notify({
      title: `shipshape: ${target.stack} unhealthy after deploy`,
      body: `#${prNumber}: ${outcome.detail}\n\nThe new image is running and failing. Roll back with git revert and redeploy if it does not recover.`,
      priority: 5,
      tags: ['rotating_light'],
    })
    return outcome
  }

  logEvent({
    level: 'info',
    kind: 'deploy',
    stack: target.stack,
    message: `${target.stack} deployed`,
    detail: outcome.detail,
  })
  return outcome
}
