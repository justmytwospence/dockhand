import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderAll } from './fixtures.tsx'

/**
 * The five places where htmx behaviour depends on markup *shape* rather than on a class.
 *
 * None of these is visible to the type checker, and every one of them is the kind of
 * thing a restyle breaks silently: a `<details>` swapped for a Bootstrap collapse still
 * looks right and simply never loads its diff. They are asserted here as literal
 * strings, on rendered output, so a refactor has to notice.
 */

const R = renderAll()

/** Is `index` inside an open `<tr>` element? */
function insideRow(html: string, index: number): boolean {
  const before = html.slice(0, index)
  return before.lastIndexOf('<tr') > before.lastIndexOf('</tr>')
}

test('contract 1: diff panels are native <details>, which is what fires the toggle event', () => {
  // `from:closest details` listens for the DOM `toggle` event. Only <details> emits it,
  // so a Bootstrap/Tabler collapse here loads no diff and reports no error.
  assert.match(R.pending!, /<details[^>]*class="diffbox"/)
  assert.match(R.pending!, /hx-trigger="toggle once from:closest details"/)
  assert.match(R.pending!, /<summary/)
})

test('contract 2: every "closest tr" trigger is inside the row it replaces', () => {
  for (const [name, html] of Object.entries(R)) {
    for (const m of html.matchAll(/hx-target="closest tr"/g)) {
      assert.ok(insideRow(html, m.index!), `${name}: a "closest tr" trigger escaped its <tr>`)
    }
  }
  // ...and the two known sites still exist, so this test cannot pass by them vanishing.
  assert.match(R.pending!, /hx-target="closest tr"/)
  assert.match(R['images-table']!, /hx-target="closest tr"/)
})

test('contract 2b: the swapped-in row fragment is itself a bare <tr>', () => {
  // outerHTML-replacing a <tr> with anything else detaches it from the table.
  assert.ok(R['image-row']!.startsWith('<tr'), R['image-row']!.slice(0, 60))
})

test('contract 3: the images filters are one form, and every control is inside it', () => {
  const html = R.images!
  assert.equal((html.match(/<form/g) ?? []).length, 1, 'exactly one form')
  const open = html.indexOf('<form')
  const close = html.indexOf('</form>')

  // hx-include="closest form" is how filter + search + group reach the server together;
  // a control that drifts out of the form silently stops contributing its parameter.
  const includes = [...html.matchAll(/hx-include="closest form"/g)]
  assert.ok(includes.length >= 3, `expected at least 3 includes, got ${includes.length}`)
  for (const m of includes) {
    assert.ok(m.index! > open && m.index! < close, 'an hx-include escaped the form')
  }
  for (const name of ['name="filter"', 'name="q"', 'name="group"']) {
    const at = html.indexOf(name)
    assert.ok(at > open && at < close, `${name} is outside the form`)
  }
})

test('contract 4: the pending poll keys off the id the scan status emits', () => {
  // Apostrophes are HTML-escaped on the way out; htmx reads the decoded value.
  assert.match(R.dashboard!, /hx-trigger="every 10s \[document\.getElementById\(&#39;scan-running&#39;\)\]"/)
  // The id exists only while scanning -- that is what makes an idle dashboard silent.
  assert.match(String(renderAll({ running: true })['scan-status']), /id="scan-running"/)
  assert.doesNotMatch(R['scan-status']!, /id="scan-running"/)
})

test('contract 4b: the scan-status poll replaces itself, so it stops when the scan does', () => {
  // Without outerHTML the swap is innerHTML *into itself*: the id survives the scan
  // ending and both this 3s poll and the dashboard's 10s poll run until a reload.
  const running = String(renderAll({ running: true })['scan-status'])
  assert.match(running, /hx-swap="outerHTML"/)
  assert.match(running, /hx-trigger="every 3s"/)
})

test('contract 5: the prompt editor is its own outerHTML swap target', () => {
  // hx-swap="outerHTML" onto #prompt-<name>: the fragment must re-emit that wrapper or
  // the element disappears and the next save has nowhere to go.
  assert.ok(
    R['prompt-fragment']!.startsWith('<div class="prompt-editor" id="prompt-verdict"'),
    R['prompt-fragment']!.slice(0, 80),
  )
})

test('contract 5b: #settings-form is declared by the page, not by the form it wraps', () => {
  // The form posts to itself with hx-target="#settings-form" hx-swap="innerHTML", so the
  // target must be the *parent* div. If it moved onto the <form>, the first save would
  // nest a form inside a form.
  assert.match(R.settings!, /id="settings-form"/)
  assert.doesNotMatch(R['settings-form']!, /id="settings-form"/)
})

test('contract 4c: only one element ever carries the scan-running id', () => {
  // The More sheet shows scan status too. Two #scan-running elements would double every
  // poll and make "is a scan running" ambiguous, so its copy asks for ?poll=0.
  const page = String(renderAll({ running: true }).dashboard)
  assert.equal((page.match(/id="scan-running"/g) ?? []).length, 1)
  assert.match(page, /hx-get="\/scan\/status\?poll=0"/)
})

test('the shell keys its two navigations to the same breakpoint', () => {
  // Complementary by construction: there must be no width where both the sidebar and
  // the tab bar show, or where neither does.
  assert.match(R.layout!, /<aside class="[^"]*\bd-none d-lg-flex\b/)
  assert.match(R.layout!, /<nav class="bottom-nav d-lg-none"/)
  assert.match(R.layout!, /<header class="[^"]*\bd-lg-none\b/)
})

test('the sidebar precedes the page wrapper, which is what offsets the content', () => {
  // Tabler's shell offset is a sibling combinator: `.navbar-vertical ~ .page-wrapper`.
  // Nest the aside, or put it after, and the gutter silently vanishes.
  const aside = R.layout!.indexOf('<aside')
  const wrapper = R.layout!.indexOf('<div class="page-wrapper">')
  const asideEnd = R.layout!.indexOf('</aside>')
  assert.ok(aside > -1 && wrapper > asideEnd, 'aside must be a preceding sibling')
})

test('the bottom bar has five equal targets', () => {
  const nav = /<nav class="bottom-nav[^>]*>([\s\S]*?)<\/nav>/.exec(R.layout!)![1]!
  assert.equal((nav.match(/<a |<button /g) ?? []).length, 5)
  assert.match(nav, /data-bs-target="#more-sheet"/)
})
