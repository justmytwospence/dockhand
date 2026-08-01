import { loadPolicy } from './config.ts'
import { getDb, logEvent } from './db.ts'
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
    message: 'dockhand started',
    detail: `merge=${policy.merge_method} push_main=${policy.sync.push_main} claude=${policy.claude.mode}`,
  })

  startServer()

  // The scheduler (registry scan, sync loop, deploy queue) lands in M1/M2. Nothing here
  // writes to git or Docker yet -- M0 is deliberately read-only.
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[system] ${sig} received, shutting down`)
    process.exit(0)
  })
}

main()
