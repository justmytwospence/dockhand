import { Cron } from 'croner'
import { env, inBlackout, loadPolicy } from './config.ts'
import { logEvent } from './db.ts'
import { runScan } from './scan.ts'

/**
 * Nightly scan scheduling.
 *
 * The cron string is re-read from policy.yaml on every fire, so editing the schedule
 * takes effect without restarting the container -- consistent with the rest of the
 * config, which is tracked in the homelab repo rather than baked into the image.
 */

let job: Cron | null = null
let currentExpression = ''
let deferTimer: NodeJS.Timeout | null = null

export function startScheduler(): void {
  schedule()
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
