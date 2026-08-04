/**
 * Look at the running UI.
 *
 * There is no browser on the homelab host, which meant every layout change here was
 * shipped blind -- and twice that produced a regression the tests could not see: a
 * sticky header that silently did not stick, and a flex chain that clipped the bottom
 * of the dashboard. Structure is testable; layout has to be looked at.
 *
 * Drives a headless Chrome container over CDP. Node 22 ships WebSocket, so no deps.
 *
 *   docker run -d --name dh-chrome --network container:dockhand \
 *     gcr.io/zenika-hub/alpine-chrome:124 --no-sandbox --disable-gpu \
 *     --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
 *     --hide-scrollbars about:blank
 *
 *   node bin/screenshot.mjs /activity out.png 600 "document.title"
 *
 * Args: <path> <out.png> [scrollY] [js expression evaluated in the page].
 * The expression is how you assert on layout -- element heights, whether a region
 * actually scrolls, whether a sticky header stayed put. Set DOCKHAND_HOST to the
 * container IP (default below).
 *
 * The sidecar shares the app container's network namespace, so recreating the app
 * kills it; restart it after every deploy.
 */
const [, , path = '/', out = 'shot.png', scrollY = '0', probe = 'null'] = process.argv
const HOST = process.env.DOCKHAND_HOST ?? '10.0.121.5'
const BASE = `http://${HOST}:8080`

const targets = await (await fetch(`http://${HOST}:9222/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: BASE + path })
await new Promise((r) => setTimeout(r, 1600))

if (Number(scrollY) > 0) {
  await send('Runtime.evaluate', {
    expression: `(function(){
      var el = document.querySelector('.grid-scroll') || document.querySelector('.page-body');
      if (el) el.scrollTop = ${Number(scrollY)};
      return el ? el.className : 'none';
    })()`,
  })
  await new Promise((r) => setTimeout(r, 400))
}

if (probe !== 'null') {
  const r = await send('Runtime.evaluate', {
    expression: probe,
    returnByValue: true,
  })
  console.log(JSON.stringify(r.result?.value ?? r, null, 1))
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.data) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('wrote', out)
}
ws.close()
