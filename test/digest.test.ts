import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../src/notify/digest.ts'

/**
 * The digest is the whole point of batching, so what it says is worth asserting on.
 * `render` is pure and takes rows, so none of this needs a database or a network.
 */

let seq = 0
const row = (over: Partial<Parameters<typeof render>[0][number]> = {}) => ({
  id: ++seq,
  at: '2026-08-04T03:14:00.000Z',
  category: 'opened' as const,
  stack: null,
  service: null,
  summary: 'something happened',
  detail: null,
  url: null,
  ...over,
})

test('an empty batch renders nothing at all', () => {
  // null rather than an empty string, so "nothing to send" is a state the caller has to
  // handle rather than a message it might accidentally send. A scheduled "0 things"
  // push is how a person learns to ignore the channel.
  assert.equal(render([]), null)
})

test('one item names itself in the title rather than counting to one', () => {
  const m = render([row({ summary: 'radarr 5.28.0 -> 5.29.0 (#16)' })])!
  assert.equal(m.title, 'dockhand: radarr 5.28.0 -> 5.29.0 (#16)')
})

test('several items are counted in the title and listed under headings', () => {
  const m = render([
    row({ category: 'opened', stack: 'servarr', service: 'radarr', summary: 'a (#1)' }),
    row({ category: 'opened', stack: 'grafana', summary: 'b (#2)' }),
    row({ category: 'merged', stack: 'glances', summary: 'c (#3)' }),
  ])!
  assert.equal(m.title, 'dockhand: 3 updates')
  assert.match(m.body, /^2 pull requests opened$/m)
  assert.match(m.body, /^ {2}servarr\/radarr: a \(#1\)$/m)
  assert.match(m.body, /^ {2}grafana: b \(#2\)$/m)
  assert.match(m.body, /^1 merged$/m)
})

test('sections read in the order an update travels', () => {
  // The digest should tell the same story as the pipeline: what appeared, what landed,
  // what is still waiting on you.
  const m = render([
    row({ category: 'held', summary: 'h' }),
    row({ category: 'deployed', summary: 'd' }),
    row({ category: 'opened', summary: 'o' }),
    row({ category: 'merged', summary: 'm' }),
    row({ category: 'drafted', summary: 'p' }),
  ])!
  const order = ['opened', 'merged', 'deployed', 'carried drafted', 'waiting on you'].map((h) =>
    m.body.indexOf(h),
  )
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    m.body,
  )
})

test('a heading agrees with itself on plurals', () => {
  assert.match(render([row()])!.body, /^1 pull request opened$/m)
  assert.match(render([row(), row()])!.body, /^2 pull requests opened$/m)
})

test('a long batch is truncated rather than becoming a log', () => {
  const m = render(Array.from({ length: 30 }, (_, i) => row({ summary: `item ${i}` })))!
  assert.equal(m.title, 'dockhand: 30 updates')
  assert.match(m.body, /^ {2}\.\.\.and 18 more$/m)
  // The heading still reports the true count, not the truncated one.
  assert.match(m.body, /^30 pull requests opened$/m)
  assert.ok(m.body.split('\n').length < 20, 'still readable on a phone')
})

test('an item with no stack does not render a stray separator', () => {
  const m = render([row({ stack: null, service: null, summary: 'bare' })])!
  assert.match(m.body, /^ {2}bare$/m)
  assert.ok(!m.body.includes(': bare'))
})

test('a stack with no service renders just the stack', () => {
  const m = render([row({ stack: 'immich', service: null, summary: 'x' })])!
  assert.match(m.body, /^ {2}immich: x$/m)
})
