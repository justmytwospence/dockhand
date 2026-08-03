import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderAll, classesOf } from './fixtures.tsx'

/**
 * Structural facts about the rendered UI, and regression cover for a batch of bugs that
 * were all the same shape: a class emitted by a view that no rule ever matched. None of
 * them threw, none showed up in a type check, and the only symptom was something quietly
 * looking wrong -- an uncoloured failure badge, a left-aligned money column.
 *
 * So every class the markup uses is asserted to exist in the stylesheet.
 */

const R = renderAll()

/**
 * Both stylesheets we ship. Checking against the union catches two different mistakes
 * with one assertion: our own dead classes (which is how `pill error` and `num` hid for
 * months), and a mistyped Tabler utility, which is otherwise completely silent -- a
 * misspelled `d-lg-none` just never applies.
 */
const APP_CSS = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')
const CSS = APP_CSS + readFileSync(new URL('../../public/tabler.min.css', import.meta.url), 'utf8')

/**
 * Class names with deliberately no rule of their own.
 *   active -- state, always used in a compound selector
 *   ctx    -- the unchanged diff line, which is `.dl` with nothing added
 */
const NOT_OURS = new Set(['active', 'ctx'])

test('every class the views emit is defined in the stylesheet', () => {
  const used = new Set<string>()
  for (const html of Object.values(R)) {
    for (const attr of classesOf(html)) {
      for (const c of attr.split(/\s+/).filter(Boolean)) used.add(c)
    }
  }
  const undefinedClasses = [...used]
    .filter((c) => !NOT_OURS.has(c))
    .filter((c) => !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![\\w-])`).test(CSS))
    .sort()
  assert.deepEqual(undefinedClasses, [], `classes with no CSS rule: ${undefinedClasses.join(', ')}`)
})

test('failure badges are coloured', () => {
  // `pill error` was emitted for months; only `.pill.err` exists, so the single status
  // you most need to notice rendered in plain body colour.
  assert.match(R.system!, /class="pill err">unhealthy/)
  assert.match(R.system!, /class="pill err">failed/)
  assert.doesNotMatch(R.system!, /class="pill error"/)
})

test('.sub is not element-qualified, so spans and cells get it too', () => {
  assert.match(APP_CSS, /^\.sub \{/m)
  // The server emits several of these as raw HTML far from any <p>.
  assert.match(R.pending!, /<span class="sub"/)
})

test('numeric table cells are right-aligned and tabular', () => {
  assert.match(APP_CSS, /^th\.num,\s*\ntd\.num \{/m)
  assert.match(R.system!, /class="num"/)
})

test('the monospace token exists, since the stylesheet dereferences it', () => {
  assert.match(APP_CSS, /--mono:/)
  assert.doesNotMatch(APP_CSS, /font-family: ui-monospace/)
})

test('no class collides with a bare Tabler/Bootstrap selector', () => {
  // Tabler defines `.mark,mark{background:highlight}` and a centred, 3rem-padded
  // `.empty`. Both would restyle our markup the moment the framework loads, with no
  // change to any of our files -- so neither name is used any more.
  for (const html of Object.values(R)) {
    assert.doesNotMatch(html, /class="[^"]*\bmark\b[^"]*"/)
    assert.doesNotMatch(html, /class="[^"]*\bempty\b[^"]*"/)
  }
  assert.match(R.diff!, /class="sign"/)
  assert.match(R['activity-table']!, /class="nothing"/)
})

test('the diff viewer renders a line per hunk line, with its gutter', () => {
  assert.match(R.diff!, /<div class="dl ctx">/)
  assert.match(R.diff!, /<div class="dl del">/)
  assert.match(R.diff!, /<div class="dl add">/)
  assert.match(R.diff!, /<span class="ln">/)
  assert.match(R.diff!, /<span class="txt">/)
})

test('activity kind chips carry their colour as an inline custom property', () => {
  // The one place inline style is load-bearing: `--k` selects from the --k-* palette,
  // and the chip and its dot both read it.
  assert.match(R.activity!, /style="--k: var\(--k-pr[^"]*\)"/)
  assert.match(R.activity!, /<span class="kdot">/)
})

test('every page is a complete document and names itself', () => {
  for (const key of ['dashboard', 'images', 'activity', 'settings', 'system', 'about']) {
    const html = R[key]!
    assert.match(html, /^<html lang="en" data-bs-theme="(light|dark)">/, key)
    assert.match(html, /<title>[^<]+ · dockhand<\/title>/, key)
    assert.match(html, /<meta name="viewport"/, key)
  }
})

test('fragments carry no document chrome', () => {
  for (const key of ['pending', 'images-table', 'image-row', 'settings-form', 'digest-preview', 'diff']) {
    assert.doesNotMatch(R[key]!, /<html|<head|<body/, key)
  }
})

test('the theme is resolved before anything paints', () => {
  // Bootstrap has no data-bs-theme="auto", so auto has to collapse to light or dark in
  // JS. If that script were deferred or placed after the stylesheets, every navigation
  // would flash the wrong theme first.
  const head = R.layout!.slice(0, R.layout!.indexOf('</head>'))
  const script = head.indexOf('dockhand-theme')
  const tabler = head.indexOf('tabler.min.css')
  const app = head.indexOf('style.css')
  assert.ok(script > -1 && script < tabler, 'theme script must precede the stylesheets')
  assert.ok(tabler < app, 'app styles must load after Tabler so source order settles ties')
  assert.doesNotMatch(head.slice(script - 60, script), /defer/)
})

test('the viewport opts into the safe-area insets the mobile bar needs', () => {
  assert.match(R.layout!, /viewport-fit=cover/)
})

test('the manifest is fetched with credentials, or it silently does not install', () => {
  // Browsers omit credentials for a manifest by default. Behind forward-auth that gets
  // a 302 to another origin, the manifest fails to parse, and the only symptom is that
  // the install prompt never appears -- the network tab still shows 200.
  assert.match(R.layout!, /<link rel="manifest" href="\/static\/manifest\.webmanifest" crossorigin="use-credentials"/)
})

test('the PWA head carries what each platform actually needs', () => {
  assert.match(R.layout!, /rel="apple-touch-icon" href="\/static\/apple-touch-icon\.png"/)
  assert.match(R.layout!, /<link rel="icon" href="\/static\/icon\.svg"/)
  // Two theme-colors, one per scheme, for the auto case.
  assert.equal((R.layout!.match(/name="theme-color"/g) ?? []).length, 2)
})

test('the service worker is registered from the root, which is where its scope comes from', () => {
  // A worker served from /static/ can only control /static/ -- it could not see the
  // navigations it exists to leave alone.
  assert.match(R.layout!, /navigator\.serviceWorker\.register\('\/sw\.js'\)/)
})
