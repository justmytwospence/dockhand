import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'shipshape-diff-'))
const REPO = mkdtempSync(join(tmpdir(), 'shipshape-repo-'))
process.env.DATA_DIR = DATA
process.env.HOMELAB_REPO = REPO

const { getDb } = await import('../src/db.ts')
const { buildUpdateDiff } = await import('../src/diff.ts')

/**
 * The fixture mirrors the shapes that actually bite: heavy comments around the target
 * line, and two services in one file carrying byte-identical image lines.
 */
const FIXTURE = `networks:
  demo:
    external: true

services:

  # The primary application. Comments here must survive untouched.
  app:
    container_name: demo_app
    image: ghcr.io/example/app:v2.7.5
    restart: unless-stopped
    labels:
      shipshape.watch: "true"
      shipshape.pattern: v-semver

  db:
    container_name: demo_db
    image: postgres:13.2
    restart: always

  # A second database on exactly the same image and tag as the first.
  db2:
    container_name: demo_db2
    image: postgres:13.2
    restart: always

  cache:
    container_name: demo_cache
    image: docker.io/valkey/valkey:9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    restart: always
`

function seed(opts: {
  service: string
  fromTag: string
  toTag: string
  imageRef: string
  detail?: string
}): number {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                         current_tag, watched, last_seen_at)
     VALUES ('demo', ?, 'demo/docker-compose.yaml', ?, 'docker.io', 'x/y', ?, 1, ?)
     ON CONFLICT(stack, service) DO UPDATE SET image_ref = excluded.image_ref`,
  ).run(opts.service, opts.imageRef, opts.fromTag, now)
  const info = db
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at)
       VALUES ('demo', ?, ?, ?, ?, 'minor', 'manual', 'detected', ?, ?, ?)`,
    )
    .run(opts.service, opts.imageRef, opts.fromTag, opts.toTag, opts.detail ?? null, now, now)
  return Number(info.lastInsertRowid)
}

beforeEach(() => {
  mkdirSync(join(REPO, 'demo'), { recursive: true })
  writeFileSync(join(REPO, 'demo', 'docker-compose.yaml'), FIXTURE)
  getDb().exec(`DELETE FROM updates; DELETE FROM images;`)
})

test('produces exactly one replaced line, with surrounding context', () => {
  const id = seed({
    service: 'app',
    fromTag: 'v2.7.5',
    toTag: 'v3.1.0',
    imageRef: 'ghcr.io/example/app:v2.7.5',
  })
  const r = buildUpdateDiff(id)
  assert.ok(!('error' in r), 'expected a diff')
  const hunk = r.hunks[0]!

  const del = hunk.lines.filter((l) => l.kind === 'del')
  const add = hunk.lines.filter((l) => l.kind === 'add')
  assert.equal(del.length, 1)
  assert.equal(add.length, 1)
  assert.match(del[0]!.text, /image: ghcr\.io\/example\/app:v2\.7\.5$/)
  assert.match(add[0]!.text, /image: ghcr\.io\/example\/app:v3\.1\.0$/)
  // Indentation is preserved because only the value is spliced.
  assert.equal(del[0]!.text.match(/^\s*/)![0], add[0]!.text.match(/^\s*/)![0])
  // Context is real neighbouring content, including the comment above the service.
  assert.ok(hunk.lines.some((l) => l.kind === 'ctx' && l.text.includes('container_name: demo_app')))
})

test('targets the right service when two carry identical image lines', () => {
  // A whole-file search would rewrite db's line for db2. The document lookup must not.
  const idDb = seed({
    service: 'db',
    fromTag: '13.2',
    toTag: '18.4',
    imageRef: 'postgres:13.2',
  })
  const idDb2 = seed({
    service: 'db2',
    fromTag: '13.2',
    toTag: '18.4',
    imageRef: 'postgres:13.2',
  })

  const a = buildUpdateDiff(idDb)
  const b = buildUpdateDiff(idDb2)
  assert.ok(!('error' in a) && !('error' in b))
  const lineA = a.hunks[0]!.lines.find((l) => l.kind === 'del')!.no
  const lineB = b.hunks[0]!.lines.find((l) => l.kind === 'del')!.no
  assert.notEqual(lineA, lineB, 'the two services must resolve to different lines')
  assert.ok(a.hunks[0]!.header.endsWith('db'))
  assert.ok(b.hunks[0]!.header.endsWith('db2'))
})

test('digest bumps swap only the digest and keep the tag and registry spelling', () => {
  const oldRef =
    'docker.io/valkey/valkey:9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const id = seed({
    service: 'cache',
    fromTag: '9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    toTag: '9@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    imageRef: oldRef,
  })
  const r = buildUpdateDiff(id)
  assert.ok(!('error' in r))
  const add = r.hunks[0]!.lines.find((l) => l.kind === 'add')!
  assert.ok(add.text.includes('docker.io/valkey/valkey:9@sha256:bbbb'), add.text)
  assert.ok(!add.text.includes('aaaa'))
})

test('rolling rows explain themselves instead of rendering an empty diff', () => {
  const id = seed({
    service: 'app',
    fromTag: 'latest@sha256:aaa',
    toTag: 'latest@sha256:bbb',
    imageRef: 'ghcr.io/example/app:v2.7.5',
    detail: 'rolling',
  })
  const r = buildUpdateDiff(id)
  assert.ok('error' in r)
  assert.match(r.error, /Nothing changes in git/)
})

test('a stale row is reported rather than producing a wrong diff', () => {
  // The file says v2.7.5; this row claims to start from something else.
  const id = seed({
    service: 'app',
    fromTag: 'v1.0.0',
    toTag: 'v1.1.0',
    imageRef: 'ghcr.io/example/app:v1.0.0',
  })
  const r = buildUpdateDiff(id)
  assert.ok('error' in r)
  assert.match(r.error, /now reads .* but this update was computed against/)
})

test('unknown updates and missing services fail cleanly', () => {
  const missing = buildUpdateDiff(999999)
  assert.ok('error' in missing)
  const id = seed({
    service: 'ghost',
    fromTag: '1.0.0',
    toTag: '1.1.0',
    imageRef: 'ghost:1.0.0',
  })
  const r = buildUpdateDiff(id)
  assert.ok('error' in r)
  assert.match(r.error, /no image: found/)
})
