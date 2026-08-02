import { Cron } from 'croner'
import { configured, env, inBlackout, loadPolicy } from './config.ts'
import { logEvent } from './db.ts'
import { runAnalysisPass } from './analyze/run.ts'
import { pollIntervalMs, pollPrs } from './gitops/poll.ts'
import { runPrPass } from './gitops/pr.ts'
import { runScan } from './scan.ts'

/**
 * Nightly scan scheduling.
 *
 * The cron string is re-read from policy.yaml on every fire, so editing the schedule
 * takes effect without restarting the container -- consistent with the rest of the
 * config, which is tracked in the watched repository rather than baked into the image.
 */

let job: Cron | null = null
let currentExpression = ''
let deferTimer: NodeJS.Timeout | null = null

export function startScheduler(): void {
  const setup = configured()
  if (!setup.ok) {
    // Nothing can run without knowing which repository to watch. Say so once, plainly,
    // and let the web UI carry the instructions.
    logEvent({
      level: 'warn',
      kind: 'system',
      message: 'not configured yet — scanning and pull requests are standing by',
      detail: setup.missing.map((m) => m.name).join(', '),
    })
    return
  }
  schedule()
  startPrLoop()
}

/**
 * The pull-request loop: notice merges, then open whatever is newly eligible.
 *
 * Self-rescheduling rather than a fixed interval, because the cadence depends on
 * whether anything is open -- a minute while PRs are in flight, ten when idle.
 */
function startPrLoop(): void {
  const tick = async (): Promise<void> => {
    try {
      const { policy } = loadPolicy()
      if (policy.prs.enabled && !inBlackout(policy)) {
        await pollPrs()
        const result = await runPrPass()
        // Analysis runs after PR creation, not before: a pull request must appear
        // whether or not the model is reachable.
        await runAnalysisPass()
        if (result.paused) {
          logEvent({
            level: 'info',
            kind: 'pr',
            message: 'pull request pass skipped',
            detail: result.paused,
          })
        }
      }
    } catch (err) {
      logEvent({
        level: 'error',
        kind: 'pr',
        message: 'pull request loop failed',
        detail: (err as Error).message,
      })
    } finally {
      setTimeout(() => void tick(), pollIntervalMs()).unref?.()
    }
  }
  // Give the first scan a moment before touching git.
  setTimeout(() => void tick(), 20_000).unref?.()
}

function schedule(): void {
  const { policy } = loadPolicy()
  currentExpression = policy.scan.cron
  job?.stop()
  job = new Cron(currentExpression, { timezone: env.tz }, fire)
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'scan scheduled',
    detail: `${currentExpression} (${env.tz}); next ${job.nextRun()?.toISOString() ?? 'unknown'}`,
  })
}

async function fire(): Promise<void> {
  const { policy } = loadPolicy()

  // Pick up a schedule edit without a restart.
  if (policy.scan.cron !== currentExpression) {
    schedule()
    return
  }

  // Scans only read registries, so a blackout does not strictly bind them -- but the
  // window exists to keep dockhand away from WUD's nightly rewrite, and an operator who
  // moves the cron into it should get the protection anyway.
  if (inBlackout(policy)) {
    const delayMs = msUntilBlackoutEnds(policy.sync.blackout) + 60_000 + Math.random() * 60_000
    logEvent({
      level: 'info',
      kind: 'scan',
      message: 'scan deferred: inside blackout window',
      detail: `retrying in ${Math.round(delayMs / 60_000)}m`,
    })
    if (deferTimer) clearTimeout(deferTimer)
    deferTimer = setTimeout(() => void fire(), delayMs)
    return
  }

  await runScanSafely('cron')
}

/** Rebuild the cron job, so a schedule edited in the UI applies immediately. */
export function rescheduleScan(): void {
  schedule()
}

/** Entry point for the UI button. */
export async function runScanNow(): Promise<ReturnType<typeof runScan>> {
  return runScan('manual')
}

async function runScanSafely(trigger: 'cron' | 'manual'): Promise<void> {
  try {
    await runScan(trigger)
  } catch (err) {
    logEvent({
      level: 'error',
      kind: 'scan',
      message: 'scan failed',
      detail: (err as Error).message,
    })
  }
}

/** Milliseconds until the end of whichever configured window contains "now". */
function msUntilBlackoutEnds(windows: string[]): number {
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()
  let best = 15 * 60_000
  for (const w of windows) {
    const [from, to] = w.split('-') as [string, string]
    const [fh, fm] = from.split(':').map(Number) as [number, number]
    const [th, tm] = to.split(':').map(Number) as [number, number]
    const start = fh * 60 + fm
    const end = th * 60 + tm
    const inside = start <= end ? mins >= start && mins < end : mins >= start || mins < end
    if (!inside) continue
    const untilMins = end >= mins ? end - mins : 24 * 60 - mins + end
    best = Math.max(best, untilMins * 60_000)
  }
  return best
}
