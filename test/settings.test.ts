import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spliceValue } from '../src/settings.ts'

/**
 * A trimmed copy of the real policy.yaml, keeping what makes splicing risky: comments
 * above and beside keys, blank lines, a quoted cron, a list value, and two sections
 * that both contain a key named `enabled`-ish at the same indent.
 */
const FIXTURE = `# dockhand policy -- the single place update semantics are declared.

merge_method: squash

sync:
  # Kill-switch. Setting this false degrades dockhand to alert-only.
  push_main: true
  blackout: ["00:45-02:30"]
  poll_active_s: 60

scan:
  # Seconds-field cron (croner).
  cron: "0 0 3 * * *"

claude:
  mode: advisory
  min_confidence: medium
  model: claude-haiku-4-5-20251001
  monthly_budget_usd: 10

prs:
  enabled: true
  scope: wud-coexist
  max_open: 5   # trailing comment worth preserving

exclude_stacks: []
`

test('replaces a nested value and leaves every other byte alone', () => {
  const out = spliceValue(FIXTURE, 'claude.model', 'claude-sonnet-5')!
  assert.ok(out.includes('  model: claude-sonnet-5'))
  // Everything else is byte-identical.
  const a = FIXTURE.split('\n').filter((l) => !l.startsWith('  model:'))
  const b = out.split('\n').filter((l) => !l.startsWith('  model:'))
  assert.deepEqual(b, a)
})

test('comments above and beside a key survive', () => {
  const out = spliceValue(FIXTURE, 'prs.max_open', '8')!
  assert.ok(out.includes('  max_open: 8   # trailing comment worth preserving'))
  assert.ok(out.includes('# dockhand policy -- the single place update semantics are declared.'))
  assert.ok(out.includes('  # Kill-switch. Setting this false degrades dockhand to alert-only.'))
})

test('a top-level key is reachable too', () => {
  const out = spliceValue(FIXTURE, 'merge_method', 'merge')!
  assert.ok(out.includes('\nmerge_method: merge\n'))
  // ...and did not disturb the nested keys.
  assert.ok(out.includes('  scope: wud-coexist'))
})

test('section scoping picks the right key when names could collide', () => {
  // `scope` exists under prs; a naive whole-file match could hit something else later.
  const out = spliceValue(FIXTURE, 'prs.scope', 'full')!
  assert.ok(out.includes('  scope: full'))
  assert.equal(out.split('\n').filter((l) => l.trim().startsWith('scope:')).length, 1)
})

test('quoted values stay quoted and lists are rewritten wholesale', () => {
  const cron = spliceValue(FIXTURE, 'scan.cron', '"0 30 4 * * *"')!
  assert.ok(cron.includes('  cron: "0 30 4 * * *"'))
  const win = spliceValue(FIXTURE, 'sync.blackout', '["01:00-02:00", "03:00-03:30"]')!
  assert.ok(win.includes('  blackout: ["01:00-02:00", "03:00-03:30"]'))
})

test('an unknown key is reported rather than silently appended', () => {
  assert.equal(spliceValue(FIXTURE, 'claude.nonexistent', 'x'), null)
  assert.equal(spliceValue(FIXTURE, 'nosuchsection.key', 'x'), null)
})

test('a key is only found inside its own section', () => {
  // `mode` lives under claude; asking for it under prs must not wander.
  assert.equal(spliceValue(FIXTURE, 'prs.mode', 'off'), null)
})

test('splicing is idempotent', () => {
  const once = spliceValue(FIXTURE, 'prs.max_open', '9')!
  const twice = spliceValue(once, 'prs.max_open', '9')!
  assert.equal(once, twice)
})

test('the result still parses as the same shape', async () => {
  const { parse } = await import('yaml')
  const out = spliceValue(FIXTURE, 'claude.monthly_budget_usd', '25')!
  const doc = parse(out) as Record<string, Record<string, unknown>>
  assert.equal(doc.claude!.monthly_budget_usd, 25)
  assert.equal(doc.prs!.max_open, 5)
  assert.deepEqual(doc.sync!.blackout, ['00:45-02:30'])
})
