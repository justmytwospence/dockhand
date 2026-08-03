import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeFor, boundaryFor, canWrite, isForbidden } from '../src/propose/paths.ts'
import { applyOps } from '../src/propose/apply.ts'

const b = (scope: Parameters<typeof boundaryFor>[0]) =>
  boundaryFor(scope, 'authelia/docker-compose.yaml')

test('the boundary comes from where the compose file sits', () => {
  assert.equal(b('compose-dir').root, 'authelia')
  assert.equal(b('repo').root, null)
  assert.equal(b('service').root, 'authelia/docker-compose.yaml')
})

test('compose-dir reaches a sibling config file and nothing beyond it', () => {
  assert.equal(canWrite('authelia/configuration.yml', b('compose-dir'), 'dockhand').ok, true)
  assert.equal(canWrite('traefik/dynamic/mcp.yaml', b('compose-dir'), 'dockhand').ok, false)
  // ...which repo scope does reach.
  assert.equal(canWrite('traefik/dynamic/mcp.yaml', b('repo'), 'dockhand').ok, true)
})

test('the narrow rungs reach exactly one file', () => {
  assert.equal(canWrite('authelia/docker-compose.yaml', b('service'), 'dockhand').ok, true)
  assert.equal(canWrite('authelia/configuration.yml', b('service'), 'dockhand').ok, false)
  assert.equal(canWrite('authelia/configuration.yml', b('compose-file'), 'dockhand').ok, false)
})

test('only YAML is editable; everything else is a note', () => {
  for (const f of ['authelia/entrypoint.sh', 'authelia/Dockerfile', 'authelia/users.json']) {
    const r = canWrite(f, b('compose-dir'), 'dockhand')
    assert.equal(r.ok, false, f)
    assert.match(r.ok === false ? r.reason : '', /not a YAML file/)
  }
})

test('no scope reaches its own guardrails or anything executable', () => {
  // A rule that can be configured away is not a limit. `repo` is the widest there is.
  for (const f of [
    'dockhand/config/policy.yaml',
    'dockhand/docker-compose.yaml',
    '.github/workflows/ci.yaml',
    'bin/homelab.yaml',
  ]) {
    assert.equal(canWrite(f, b('repo'), 'dockhand').ok, false, f)
  }
  assert.equal(isForbidden('dockhand/config/policy.yaml', 'dockhand'), true)
  // ...and the self-stack is whatever this deployment calls it.
  assert.equal(isForbidden('updater/config/policy.yaml', 'updater'), true)
  assert.equal(isForbidden('updater/config/policy.yaml', 'dockhand'), false)
})

test('traversal and absolute paths do not escape the repository', () => {
  for (const f of ['../outside/x.yaml', '/etc/passwd.yaml', 'authelia/../../x.yaml']) {
    assert.equal(canWrite(f, b('repo'), 'dockhand').ok, false, f)
  }
})

test('a typo narrows; the widest words are still recognised', () => {
  assert.equal(scopeFor('compose-directory'), 'compose-dir')
  assert.equal(scopeFor('any'), 'repo')
  assert.equal(scopeFor('everything'), 'service')
  assert.equal(scopeFor(null), 'service')
})

test('none reaches nothing at all', () => {
  assert.equal(canWrite('authelia/docker-compose.yaml', b('none'), 'dockhand').ok, false)
})

const CONFIG = `theme: light
authentication_backend:
  file:
    path: /config/users.yml
  password_reset:
    disable: false
session:
  domain: example.com
`

test('path ops edit a non-compose YAML file, byte-exactly', () => {
  const r = applyOps(CONFIG, 'ignored', [
    { op: 'set_path', path: ['session', 'domain'], value: 'new.example.com' },
    { op: 'rename_path', path: ['authentication_backend', 'password_reset'], to: 'reset_password' },
    { op: 'remove_path', path: ['theme'] },
  ])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('domain: new.example.com'))
  assert.ok(r.text.includes('reset_password:'))
  assert.ok(!r.text.includes('theme:'))
  // Untouched structure survives verbatim.
  assert.ok(r.text.includes('path: /config/users.yml'))
})

test('a path op will not invent the structure it needs', () => {
  // Conjuring intermediate mappings is how a plausible edit lands in the wrong place.
  const r = applyOps(CONFIG, 'x', [
    { op: 'set_path', path: ['nothing', 'here', 'deep'], value: '1' },
  ])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /no mapping at/)
})

test('a path op naming something absent is refused, not guessed', () => {
  const r = applyOps(CONFIG, 'x', [{ op: 'remove_path', path: ['session', 'nope'] }])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /no entry at session\.nope/)
})

test('the verifier catches a path splice that did more than asked', () => {
  // The whole safety property: the splice is compared against the same ops applied to
  // the parsed object. This asserts the check is actually wired for path ops.
  const r = applyOps(CONFIG, 'x', [{ op: 'set_path', path: ['session', 'domain'], value: 'a.b' }])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.equal(r.changed.length, 1)
})
