import { loadPolicy } from './config.ts'
import { getDb, logEvent } from './db.ts'
import { startScheduler } from './scheduler.ts'
import { startServer } from './web/server.ts'

function main(): void {
  getDb()
  const { policy, error } = loadPolicy()
  if (error) {
    logEvent({ level: 'error', kind: 'system', message: 'policy load failed', detail: error })
  }
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'shipshape started',
    detail: `merge=${policy.merge_method} push_main=${policy.sync.push_main} claude=${policy.claude.mode}`,
  })

  startServer()
  startScheduler()

  // The git sync loop and deploy queue land in M2/M4. Scanning is registry-read-only:
  // nothing here writes to git or Docker.
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[system] ${sig} received, shutting down`)
    process.exit(0)
  })
}

main()
