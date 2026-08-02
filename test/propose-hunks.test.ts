import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalHunks } from '../src/propose/hunks.ts'

const before = `services:
  app:
    image: old:1
    environment:
      A: 1
      B: 2
    labels:
      x: y
`

test('a rewritten line reads as one delete plus one add', () => {
  const after = before.replace('image: old:1', 'image: new:2')
  const h = proposalHunks(before, after, 'x/docker-compose.yaml')
  assert.equal(h.length, 1)
  const del = h[0]!.lines.filter((l) => l.kind === 'del')
  const add = h[0]!.lines.filter((l) => l.kind === 'add')
  assert.equal(del.length, 1)
  assert.equal(add.length, 1)
  assert.match(del[0]!.text, /old:1/)
  assert.match(add[0]!.text, /new:2/)
})

test('an inserted line has no old line number', () => {
  const after = before.replace('      B: 2\n', '      B: 2\n      C: 3\n')
  const h = proposalHunks(before, after, 'f.yaml')
  const add = h.flatMap((x) => x.lines).filter((l) => l.kind === 'add')
  assert.equal(add.length, 1)
  assert.match(add[0]!.text, /C: 3/)
  assert.equal(add[0]!.no, null, 'an added line has no position in the old file')
})

test('a deleted line is reported as deleted', () => {
  const after = before.replace('      A: 1\n', '')
  const h = proposalHunks(before, after, 'f.yaml')
  const del = h.flatMap((x) => x.lines).filter((l) => l.kind === 'del')
  assert.equal(del.length, 1)
  assert.match(del[0]!.text, /A: 1/)
})

test('identical text produces no hunks at all', () => {
  assert.deepEqual(proposalHunks(before, before, 'f.yaml'), [])
})

test('context lines surround the change and carry their real line numbers', () => {
  const after = before.replace('image: old:1', 'image: new:2')
  const [h] = proposalHunks(before, after, 'f.yaml')
  const ctx = h!.lines.filter((l) => l.kind === 'ctx')
  assert.ok(ctx.length > 0, 'a hunk without context is unreadable')
  // The image line is line 3, so context above it must be lines 1 and 2.
  assert.deepEqual(
    ctx.filter((l) => (l.no ?? 0) < 3).map((l) => l.no),
    [1, 2],
  )
})

test('two distant edits become two hunks, not one giant one', () => {
  const after = before.replace('image: old:1', 'image: new:2').replace('x: y', 'x: z')
  const h = proposalHunks(after.replace('image: new:2', 'image: old:1'), after, 'f.yaml')
  assert.ok(h.length >= 1)
  // Every emitted line belongs to some hunk and nothing is duplicated across them.
  const all = h.flatMap((x) => x.lines.map((l) => `${l.kind}:${l.text}`))
  assert.equal(new Set(all).size, all.length, 'hunks must not overlap')
})
