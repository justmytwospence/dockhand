import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every route, actually served.
 *
 * `paths` in config.ts is computed at module load from DATA_DIR, so the environment has
 * to be set before that module is imported -- hence the dynamic import. REPO_DIR is left
 * unset on purpose: `scanRepo` treats an absent repo as "no services" rather than an
 * error, so this exercises the unconfigured path too, which is the one a new deployment
 * sees first and the one nothing else covers.
 */

let app: { request: (path: string, init?: RequestInit) => Promise<Response> }
let dir: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dockhand-test-'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  delete process.env.HOMELAB_REPO
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GITHUB_TOKEN
  const { createApp } = await import('../../src/web/server.ts')
  app = createApp() as never
})

after(() => rmSync(dir, { recursive: true, force: true }))

const PAGES = ['/', '/images', '/images?group=stack', '/activity', '/settings', '/settings/raw', '/system', '/about']
const FRAGMENTS = ['/fragments/pending', '/scan/status', '/settings/digest']

test('every page returns a whole document', async () => {
  for (const path of PAGES) {
    const res = await app.request(path)
    assert.equal(res.status, 200, path)
    const html = await res.text()
    assert.match(html, /^<html lang="en" data-bs-theme="(light|dark)">/, path)
    assert.match(html, /<\/html>$/, path)
  }
})

test('every fragment returns a bare fragment, never a whole document', async () => {
  // A fragment that accidentally renders <html> gets swapped into the middle of the
  // page, which browsers quietly flatten -- no error, just a broken layout.
  for (const path of FRAGMENTS) {
    const res = await app.request(path)
    assert.equal(res.status, 200, path)
    assert.doesNotMatch(await res.text(), /<html/, path)
  }
})

test('the unconfigured deployment gets setup instructions, not a crash', async () => {
  const html = await (await app.request('/')).text()
  assert.match(html, /dockhand is not configured yet/)
  assert.match(html, /REPO_DIR/)
})

test('a row fragment spans exactly the columns of the table it lands in', async () => {
  // These come back as raw HTML strings far from the tables that define the columns,
  // so the count is asserted here rather than trusted.
  const dashboardCols = 6 // Service, Change, Kind, Analysis, PR, action
  const imagesCols = 5 // Service, Image, Tag, Status, action

  const dismissed = await (await app.request('/updates/1/dismiss', { method: 'POST' })).text()
  assert.match(dismissed, new RegExp(`colspan="${dashboardCols}"`), dismissed)

  const held = await (await app.request('/updates/1/open-pr', { method: 'POST' })).text()
  assert.match(held, new RegExp(`colspan="${dashboardCols}"`), held)

  const missing = await app.request('/images/nope/nope/check', { method: 'POST' })
  assert.equal(missing.status, 404)
  assert.match(await missing.text(), new RegExp(`colspan="${imagesCols}"`))
})

test('the health endpoint stays plain JSON for the container healthcheck', async () => {
  const res = await app.request('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})
