import type { FC, PropsWithChildren } from 'hono/jsx'

const NAV = [
  ['/', 'Dashboard'],
  ['/images', 'Images'],
  ['/activity', 'Activity'],
  ['/settings', 'Settings'],
  ['/system', 'System'],
  ['/about', 'About'],
] as const

export interface MissingSetting {
  name: string
  why: string
}

/**
 * Resolve the theme before anything paints.
 *
 * Three stored states -- auto, light, dark -- collapsing to the two Bootstrap
 * understands. `auto` follows the OS and keeps following it, which is why the
 * matchMedia listener is registered here rather than with the toggle: the listener has
 * to exist on every page, and the toggle does not.
 *
 * Deliberately tiny and inline. A deferred external script would run after first paint,
 * which is exactly the flash this avoids.
 */
export const THEME_SCRIPT = `(function(){
  var q = matchMedia('(prefers-color-scheme: dark)');
  function pick(){
    var s = localStorage.getItem('dockhand-theme') || 'auto';
    return s === 'auto' ? (q.matches ? 'dark' : 'light') : s;
  }
  function apply(){
    var t = pick();
    document.documentElement.setAttribute('data-bs-theme', t);
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', t === 'dark' ? '#16171a' : '#fbfbfa');
  }
  apply();
  q.addEventListener('change', apply);
  window.dockhandSetTheme = function(v){ localStorage.setItem('dockhand-theme', v); apply(); };
})()`

export const Layout: FC<
  PropsWithChildren<{ title: string; path: string; missing?: MissingSetting[] }>
> = ({ title, path, missing, children }) => (
  <html lang="en" data-bs-theme="light">
    <head>
      <meta charset="utf-8" />
      {/* viewport-fit=cover so env(safe-area-inset-*) is non-zero on a notched phone;
          without it the mobile tab bar sits under the home indicator. */}
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title} &middot; dockhand</title>
      {/* First, and NOT deferred. Bootstrap 5.3 has no data-bs-theme="auto" -- auto has
          to be resolved to light or dark before the stylesheets paint, or the page
          flashes the wrong theme on every navigation. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <link rel="stylesheet" href="/static/tabler.min.css" />
      {/* After Tabler: source order settles every same-specificity tie in our favour,
          which is what lets the bespoke CSS below stay unedited. */}
      <link rel="stylesheet" href="/static/style.css" />
      <script src="/static/htmx.min.js" defer></script>
      <script src="/static/tabler.min.js" defer></script>
      <link
        rel="icon"
        href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9A%A2%3C/text%3E%3C/svg%3E"
      />
    </head>
    <body>
      <header class="topbar">
        {/* Inner wrapper so the bar's border spans the viewport while its contents
            align to the same column as <main>. */}
        <div class="bar-inner">
          <a class="brand" href="/">
            dockhand
          </a>
          <nav>
            {NAV.map(([href, label]) => (
              <a href={href} class={path === href ? 'active' : ''}>
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main>
        {missing && missing.length > 0 && <Setup missing={missing} />}
        {children}
      </main>
    </body>
  </html>
)

export const Banner: FC<{ kind: 'warn' | 'error' | 'info'; children?: unknown }> = ({
  kind,
  children,
}) => <div class={`banner ${kind}`}>{children}</div>

/** Tables scroll horizontally inside their own box so the page body never does. */
export const Table: FC<PropsWithChildren<{ kv?: boolean }>> = ({ kv, children }) => (
  <div class="table-wrap">
    <table class={kv ? 'kv' : ''}>{children}</table>
  </div>
)

export const Empty: FC<{ children?: unknown }> = ({ children }) => (
  <p class="nothing">{children}</p>
)

/**
 * How many columns each table has, so a row fragment can span all of them.
 *
 * These fragments are returned from the server as replacements for a `<tr>` that has
 * already been rendered somewhere else, which means the column count has to be stated
 * twice and the two statements are hundreds of lines apart. It was wrong: the images
 * 404 row claimed six columns for a five-column table. Naming the counts here is what
 * lets a test compare them against the tables that define them.
 */
export const COLUMNS = { pending: 6, images: 5 } as const

/** A full-width note replacing a table row -- "dismissed", "no such service". */
export const RowNote: FC<{ cols: number; cls?: string; children?: unknown }> = ({
  cols,
  cls,
  children,
}) => (
  <tr class={cls}>
    <td colspan={cols} class="sub">
      {children}
    </td>
  </tr>
)

/** Shown until dockhand knows which repository to watch. */
const Setup: FC<{ missing: MissingSetting[] }> = ({ missing }) => (
  <div class="banner warn">
    <strong>dockhand is not configured yet.</strong>
    <p>Set the following, then restart the container:</p>
    <table class="kv">
      <tbody>
        {missing.map((m) => (
          <tr>
            <th class="mono">{m.name}</th>
            <td>{m.why}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p>A minimal compose service looks like this:</p>
    <pre class="rawfile">{`services:
  dockhand:
    image: ghcr.io/justmytwospence/dockhand:latest   # or build: ./app
    environment:
      # The path must be identical inside and outside the container.
      REPO_DIR: /srv/compose
      GITHUB_REPO: you/your-compose-repo
      GITHUB_TOKEN: \${GITHUB_TOKEN}     # fine-grained: Contents rw, Pull requests rw
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY}   # optional: changelog analysis
    volumes:
      - /srv/compose:/srv/compose
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock`}</pre>
    <p>
      Full instructions are in the{' '}
      <a class="ext" href="https://github.com/justmytwospence/dockhand#readme" target="_blank" rel="noopener">
        README
      </a>
      .
    </p>
  </div>
)
