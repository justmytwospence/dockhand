import type { FC, PropsWithChildren } from 'hono/jsx'

const NAV = [
  ['/', 'Dashboard'],
  ['/images', 'Images'],
  ['/activity', 'Activity'],
  ['/settings', 'Settings'],
  ['/system', 'System'],
] as const

export const Layout: FC<PropsWithChildren<{ title: string; path: string }>> = ({
  title,
  path,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} &middot; dockhand</title>
      <link rel="stylesheet" href="/static/style.css" />
      <script src="/static/htmx.min.js" defer></script>
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
      <main>{children}</main>
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
  <p class="empty">{children}</p>
)
