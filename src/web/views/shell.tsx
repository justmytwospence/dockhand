import type { FC } from 'hono/jsx'
import { version } from '../version.ts'
import {
  IconAbout,
  IconActivity,
  IconAuto,
  IconDashboard,
  IconImages,
  IconInfo,
  IconMore,
  IconMoon,
  IconSettings,
  IconSun,
  IconSystem,
  type IconFC,
} from './icons.tsx'

/**
 * The application chrome.
 *
 * Two presentations of one navigation, and they are generated from the same array so
 * they cannot disagree about what exists or which entry is current:
 *
 *   >= 992px  a persistent left sidebar, all six destinations
 *   <  992px  a bottom tab bar with the four you actually live in, plus More
 *
 * A bottom bar rather than a hamburger because this is the difference between something
 * that reads as a tool and something that reads as a website: the four things you do
 * most are one thumb-reach away, always, instead of two taps behind a menu.
 *
 * Both breakpoints are keyed to `lg` (992px) via Bootstrap's own display utilities, so
 * there is no width at which both are visible or neither is.
 */

interface NavItem {
  href: string
  label: string
  icon: IconFC
  /** Earns a slot in the bottom bar. The rest live behind More. */
  primary?: boolean
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: IconDashboard, primary: true },
  { href: '/images', label: 'Images', icon: IconImages, primary: true },
  { href: '/activity', label: 'Activity', icon: IconActivity, primary: true },
  { href: '/settings', label: 'Settings', icon: IconSettings, primary: true },
  { href: '/system', label: 'System', icon: IconSystem },
  { href: '/about', label: 'About', icon: IconAbout },
]

/** `/images?group=stack` must still light up the Images tab. */
const isCurrent = (path: string, href: string): boolean =>
  href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`)

export const Sidebar: FC<{ path: string }> = ({ path }) => (
  <aside class="navbar navbar-vertical navbar-expand-lg d-none d-lg-flex">
    <div class="container-fluid">
      <h1 class="navbar-brand">
        <a href="/">shipshape</a>
      </h1>
      <div class="navbar-collapse">
        <ul class="navbar-nav pt-lg-2">
          {NAV.map((item) => (
            <li class={`nav-item${isCurrent(path, item.href) ? ' active' : ''}`}>
              <a
                class="nav-link"
                href={item.href}
                aria-current={isCurrent(path, item.href) ? 'page' : undefined}
              >
                {/* .nav-link-icon carries the gap; Tabler has no matching *-title
                    class, so the label sits directly in the link. */}
                <span class="nav-link-icon">
                  <item.icon />
                </span>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        <div class="mt-auto pb-3">
          <ThemeToggle />
          <div class="sub mt-2 px-2">v{version()}</div>
        </div>
      </div>
    </div>
  </aside>
)

/** The mobile top bar: just enough to say where you are and get back to the top. */
export const MobileBar: FC<{ title: string }> = ({ title }) => (
  <header class="navbar navbar-expand-md d-lg-none sticky-top">
    <div class="container-xl">
      <a class="navbar-brand navbar-brand-autodark me-0" href="/">
        shipshape
      </a>
      <span class="sub ms-2 text-truncate">{title}</span>
    </div>
  </header>
)

export const BottomNav: FC<{ path: string }> = ({ path }) => (
  <nav class="bottom-nav d-lg-none" aria-label="Primary">
    {NAV.filter((i) => i.primary).map((item) => (
      <a
        href={item.href}
        class={isCurrent(path, item.href) ? 'active' : ''}
        aria-current={isCurrent(path, item.href) ? 'page' : undefined}
      >
        <item.icon />
        <span>{item.label}</span>
      </a>
    ))}
    <button type="button" data-bs-toggle="offcanvas" data-bs-target="#more-sheet" aria-label="More">
      <IconMore />
      <span>More</span>
    </button>
  </nav>
)

/**
 * What did not fit on the tab bar.
 *
 * Also the mobile home for the theme toggle and the version, which on desktop live in
 * the sidebar footer. Rendered inside Layout, outside every htmx swap target, so a
 * fragment swap can never detach Bootstrap's offcanvas from its trigger.
 */
export const MoreSheet: FC<{ path: string }> = ({ path }) => (
  <div class="offcanvas offcanvas-bottom" tabindex={-1} id="more-sheet" aria-labelledby="more-title">
    <div class="offcanvas-header">
      <h2 class="offcanvas-title h4 mb-0" id="more-title">
        More
      </h2>
      <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
    </div>
    <div class="offcanvas-body">
      <div class="list-group list-group-flush">
        {NAV.filter((i) => !i.primary).map((item) => (
          <a
            class={`list-group-item list-group-item-action d-flex align-items-center gap-2${
              isCurrent(path, item.href) ? ' active' : ''
            }`}
            href={item.href}
          >
            <item.icon />
            {item.label}
          </a>
        ))}
      </div>
      <div class="d-flex align-items-center justify-content-between mt-3">
        <ThemeToggle />
        <span class="sub">v{version()}</span>
      </div>
      {/* poll=0: the dashboard's pending region keys its 10s poll off an element with
          id="scan-running", and two of those on one page would double every request. */}
      <div class="sub mt-3" hx-get="/scan/status?poll=0" hx-trigger="load, every 30s">
        &nbsp;
      </div>
    </div>
  </div>
)

/**
 * auto / light / dark.
 *
 * Writes localStorage and re-applies immediately through the resolver defined in
 * layout.tsx, so no round-trip and no flash. Three explicit states rather than a
 * two-way switch because "follow the OS" is a real preference and a toggle cannot
 * express it -- which is all the old prefers-color-scheme-only setup could do.
 */
export const ThemeToggle: FC = () => (
  <div class="btn-group theme-toggle" role="group" aria-label="Colour theme">
    {(
      [
        ['auto', 'Auto', IconAuto],
        ['light', 'Light', IconSun],
        ['dark', 'Dark', IconMoon],
      ] as const
    ).map(([value, label, Ico]) => (
      <button
        type="button"
        class="btn btn-sm"
        data-theme={value}
        title={label}
        aria-label={label}
        onclick={`window.shipshapeSetTheme('${value}')`}
      >
        <Ico />
      </button>
    ))}
  </div>
)

/**
 * The explanation that used to be a paragraph.
 *
 * Working screens are for data and controls; the reasoning behind a column, a tab or a
 * setting is real and worth keeping, but it does not need to occupy a line of the
 * screen forever. `container: body` matters -- with the fixed frame the scroll regions
 * are `overflow: hidden`, and a popover rendered in place would be clipped by them.
 */
export const Help: FC<{ text: string; label?: string }> = ({ text, label }) => (
  <button
    type="button"
    class="help-dot"
    data-bs-toggle="popover"
    data-bs-trigger="focus hover"
    data-bs-placement="top"
    data-bs-container="body"
    data-bs-content={text}
    aria-label={label ? `About ${label}` : 'More information'}
  >
    <IconInfo />
  </button>
)

/** Title, optional subtitle, optional actions. Tabler's own page-header shape. */
export const PageHeader: FC<{ title: string; subtitle?: unknown; actions?: unknown }> = ({
  title,
  subtitle,
  actions,
}) => (
  <div class="page-header d-print-none">
    <div class="row g-2 align-items-center">
      <div class="col">
        <h2 class="page-title">{title}</h2>
        {subtitle ? <div class="page-subtitle sub">{subtitle}</div> : null}
      </div>
      {actions ? <div class="col-auto ms-auto d-print-none">{actions}</div> : null}
    </div>
  </div>
)
