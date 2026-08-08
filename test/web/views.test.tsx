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
  for (const key of ['dashboard', 'images', 'activity', 'settings', 'system']) {
    const html = R[key]!
    assert.match(html, /^<html lang="en" data-bs-theme="(light|dark)">/, key)
    assert.match(html, /<title>[^<]+ · shipshape<\/title>/, key)
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
  const script = head.indexOf('shipshape-theme')
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

test('the page header sits outside the scroll region', () => {
  // This is the frame: chrome fixed, content scrolling under it. If the header were
  // inside .page-body it would scroll away and the app would be a document again.
  const header = R.dashboard!.indexOf('page-header-bar')
  const body = R.dashboard!.indexOf('<div class="page-body')
  assert.ok(header > -1, 'no page-header-bar')
  assert.ok(header < body, 'the header must precede the scroll region, not sit inside it')
})

test('popovers are initialised, and re-initialised after every htmx swap', () => {
  // Bootstrap auto-inits click-driven components but never popovers. Half this UI
  // arrives as fragments, so a help dot inside a swapped region is dead without this.
  assert.match(R.layout!, /htmx:afterSwap/)
  assert.match(R.layout!, /window\.tabler\.Popover/)
  // Bound to document.body, so the script must come after it.
  const script = R.layout!.indexOf('htmx:afterSwap')
  assert.ok(script > R.layout!.indexOf('<body>'), 'popover script must be inside body')
})

test('every settings pane has a nav entry, and every nav entry a pane', () => {
  // The nav and the panes are generated from one list, but the two non-form panes
  // (Digest, Prompts) are written out by hand -- so a typo there would produce a nav
  // item that activates nothing, with no error anywhere.
  const navIds = [...R.settings!.matchAll(/data-pane="([^"]+)"/g)].map((m) => m[1]!)
  const paneIds = [...R.settings!.matchAll(/id="pane-([^"]+)"/g)].map((m) => m[1]!)
  assert.ok(navIds.length >= 12, `expected 12+ nav entries, got ${navIds.length}`)
  assert.deepEqual(navIds.slice().sort(), paneIds.slice().sort())
})

test('the explanations only link at panes that exist', () => {
  // This used to guard /about's deep links into Settings. The prose now lives inside the
  // panes it describes, so the same links became same-page anchors -- and the invariant
  // matters more, not less: a hash naming no pane activates nothing and reports nothing.
  const targets = [...R.settings!.matchAll(/href="(?:\/settings)?#([^"]+)"/g)].map((m) => m[1]!)
  assert.ok(targets.length >= 5)
  for (const t of new Set(targets)) {
    assert.ok(R.settings!.includes(`id="pane-${t}"`), `settings links at #${t}, which has no pane`)
  }
})

test('every policy section carries an explanation', () => {
  // One per form pane. A section added to SECTIONS without prose is a type error in
  // explain.tsx, but a section whose prose stops being *rendered* would be silent.
  const panes = (R.settings!.match(/class="settings-pane" data-form="1"/g) ?? []).length
  const explains = (R.settings!.match(/class="explain"/g) ?? []).length
  assert.equal(panes, 9)
  assert.equal(explains, 9)
})

test('explanations are off until asked for, and decided before anything paints', () => {
  // Same contract as the theme: the preference is applied by the inline head script, so
  // the prose never flashes. If it were server-rendered onto <html> instead, the two
  // tests anchoring that tag's exact shape would break.
  assert.match(APP_CSS, /\.explain\s*\{\s*display:\s*none/)
  assert.match(APP_CSS, /\[data-explain='on'\]\s*\.explain/)
  const head = R.settings!.slice(0, R.settings!.indexOf('tabler.min.css'))
  assert.ok(head.includes('shipshape-explain'), 'the explain pref is set after first paint')
  assert.ok(!/<html[^>]*data-explain/.test(R.settings!), 'data-explain must not be server-rendered')
})

test('the explain switch sits outside the settings form', () => {
  // A Save swaps #settings-form's innerHTML. A control inside it would be re-rendered
  // unchecked mid-session, silently disagreeing with localStorage.
  const sw = R.settings!.indexOf('explain-toggle')
  const form = R.settings!.indexOf('id="settings-form"')
  assert.ok(sw >= 0 && form >= 0)
  assert.ok(sw < form, 'the explain switch must not be inside the swapped form')
})

test('the pane script survives a save', () => {
  // Regression cover: a Save re-renders every pane without `active`, so without an
  // afterSwap hook the content area goes blank while the nav still says otherwise.
  assert.match(R.settings!, /htmx:afterSwap/)
})

test('every setting input stays inside the form, including on hidden panes', () => {
  // Panes are display:none, not detached. That is what lets one Save commit all nine
  // sections at once, exactly as when they were stacked cards.
  const html = R.settings!
  const open = html.indexOf('<form hx-post="/settings"')
  const close = html.indexOf('</form>', open)
  for (const m of html.matchAll(/name="(defaults\.[a-z]+|claude\.[a-z_.]+|prs\.[a-z_]+)"/g)) {
    assert.ok(m.index! > open && m.index! < close, `${m[1]} escaped the settings form`)
  }
})

test('the save bar is inside the form and knows which panes it applies to', () => {
  assert.match(R.settings!, /class="scanbar sticky-save"/)
  assert.match(R.settings!, /data-form="1"/)
  assert.match(R.settings!, /data-form="0"/)
})

/**
 * Classes that only appear on a branch the fixtures do not exercise -- an error state,
 * a server-rendered row note, a conditional badge. Verified by grep against src/, not
 * assumed: each is named in the markup somewhere, just not in a rendered fixture.
 */
const CONDITIONAL = new Set([
  'detail', 'dismissed', 'errlist', 'failed', 'notes', 'oplist',
  'proposal', 'row-error', 'row-warn', 'popover',
])

test('no CSS is left behind for a feature that no longer exists', () => {
  // The other direction from the coverage test above. Removing an expander or a filter
  // strip leaves its rules behind, and dead frames are exactly how box-in-box nesting
  // accumulates -- a rule with no markup still draws nothing, but the next person to
  // read the stylesheet cannot tell which frames are real.
  const rendered = new Set<string>()
  for (const html of [...Object.values(R), ...Object.values(renderAll({ running: true }))]) {
    for (const attr of classesOf(html)) {
      for (const c of attr.split(/\s+/).filter(Boolean)) rendered.add(c)
    }
  }
  const styled = new Set(
    [...APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!),
  )
  const orphans = [...styled].filter((c) => !rendered.has(c) && !CONDITIONAL.has(c)).sort()
  assert.deepEqual(orphans, [], `CSS with no markup: ${orphans.join(', ')}`)
})

test('nothing draws a frame inside another frame', () => {
  // One box per thing. A card in a card, or a bordered block inside a bordered block,
  // is the visual tell that a refactor left a wrapper behind.
  const FRAMED = /\b(card|alert|prompt-editor)\b/
  for (const [name, html] of Object.entries(R)) {
    const stack: boolean[] = []
    for (const m of html.matchAll(/<(\/?)(?:div|section|form|aside|nav)\b([^>]*)>/g)) {
      if (m[1]) {
        stack.pop()
        continue
      }
      const cls = /class="([^"]*)"/.exec(m[2]!)?.[1] ?? ''
      // card-table/card-body/card-header/card-sm/card-fill are parts of a card, not new ones.
      const isFrame = FRAMED.test(cls.replace(/card-[\w-]+/g, ''))
      if (isFrame && stack.some(Boolean)) {
        assert.fail(`${name}: a framed element nested inside another (class="${cls}")`)
      }
      stack.push(isFrame)
    }
  }
})

test('card-table only appears where there is a card', () => {
  // Tabler's card-table makes a table sit flush inside a card. On the full-bleed grid
  // pages there is no card, so it is a modifier for a frame that does not exist --
  // exactly the kind of leftover a refactor strands.
  for (const [name, html] of Object.entries(R)) {
    if (!html.includes('card-table')) continue
    assert.match(html, /class="card[ "]/, `${name}: card-table without a card`)
  }
})

test('the single-table pages carry no card at all', () => {
  // A card around the only thing on a page is a box inside the page's own box.
  for (const key of ['images', 'images-grouped', 'activity']) {
    assert.doesNotMatch(R[key]!, /class="card[ "]/, `${key} should be full-bleed`)
    assert.match(R[key]!, /class="page-body fill bleed"/, key)
    assert.match(R[key]!, /class="page-toolbar/, `${key}: toolbar should be fixed chrome`)
  }
})
