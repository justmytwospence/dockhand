import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeFor, allowedServices, describeScope } from '../src/propose/scope.ts'
import { applyOps } from '../src/propose/apply.ts'

const FILE = `services:
  app:
    image: ghcr.io/example/app:v1.0.0
    environment:
      A: 1
  sidecar:
    image: ghcr.io/example/proxy:v1.0.0
    environment:
      B: 2
`

test('unset means the narrowest useful scope, not the widest', () => {
  assert.equal(scopeFor(null), 'service')
  assert.equal(scopeFor(undefined), 'service')
  assert.equal(scopeFor(''), 'service')
})

test('a typo narrows rather than widens', () => {
  // Granting reach on an unrecognised value is the one direction this must never fail.
  assert.equal(scopeFor('compose-directory'), 'service')
  assert.equal(scopeFor('any'), 'service')
  assert.equal(scopeFor('ANYTHING'), 'service')
})

test('off is still accepted as the original spelling of none', () => {
  assert.equal(scopeFor('off'), 'none')
  assert.equal(scopeFor('none'), 'none')
})

test('allowedServices matches the ladder', () => {
  assert.deepEqual(allowedServices('none', 'app', ['app', 'sidecar']), [])
  assert.deepEqual(allowedServices('service', 'app', ['app', 'sidecar']), ['app'])
  assert.deepEqual(allowedServices('compose-file', 'app', ['app', 'sidecar']), ['app', 'sidecar'])
})

test('at service scope a sibling edit is refused by name', () => {
  const r = applyOps(
    FILE,
    'app',
    [{ op: 'set_env', service: 'sidecar', key: 'B', value: '9' }],
    ['app'],
  )
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /may not change "sidecar"/)
})

test('at compose-file scope the same edit applies, and only where aimed', () => {
  const r = applyOps(
    FILE,
    'app',
    [{ op: 'set_env', service: 'sidecar', key: 'B', value: '9' }],
    ['app', 'sidecar'],
  )
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('B: 9'))
  assert.ok(r.text.includes('A: 1'), "the primary service must not be touched")
})

test('an op with no service still means the service being updated', () => {
  const r = applyOps(FILE, 'app', [{ op: 'set_env', key: 'A', value: '5' }], ['app', 'sidecar'])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('A: 5'))
  assert.ok(r.text.includes('B: 2'), 'the sibling must be untouched')
})

test('a service outside the file is refused even at the widest scope', () => {
  const r = applyOps(
    FILE,
    'app',
    [{ op: 'set_env', service: 'somewhere-else', key: 'X', value: '1' }],
    ['app', 'sidecar'],
  )
  assert.equal(r.ok, false)
})

test('a sibling change is labelled with the service it touched', () => {
  // The change list is what the operator reads on the pull request; an edit to another
  // service that reads like an edit to this one is the wrong thing to show.
  const r = applyOps(
    FILE,
    'app',
    [
      { op: 'set_env', key: 'A', value: '5' },
      { op: 'set_env', service: 'sidecar', key: 'B', value: '9' },
    ],
    ['app', 'sidecar'],
  )
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(!r.changed[0]!.includes('('), 'the primary needs no qualifier')
  assert.match(r.changed[1]!, /\(sidecar\)/)
})

test('the model is told exactly what apply.ts will enforce', () => {
  const wide = describeScope('compose-file', 'app', ['app', 'sidecar'])
  assert.match(wide, /app, sidecar/)
  const narrow = describeScope('service', 'app', ['app'])
  assert.match(narrow, /only the "app" service/)
  assert.match(describeScope('none', 'app', []), /may not change anything/)
})
