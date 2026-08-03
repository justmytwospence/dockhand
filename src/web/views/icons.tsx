import type { FC } from 'hono/jsx'

/**
 * The handful of icons the chrome needs, inline.
 *
 * Tabler ships ~5,900 icons as a separate package. Vendoring that for eleven glyphs
 * would be 30x the weight of the entire rest of this directory, and an icon font brings
 * its own flash-of-unstyled-text problem, so these are copied as paths.
 *
 * Shaped the way Tabler's own `.icon` rule expects -- 24x24, no fill, `currentColor`
 * stroke, 2px round caps -- so they inherit colour from whatever they sit in and scale
 * with `--tblr-icon-size`.
 */

const Icon: FC<{ children?: unknown; cls?: string }> = ({ children, cls }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    class={cls ?? 'icon'}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export type IconFC = FC<{ cls?: string }>

export const IconDashboard: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M4 4h6v8h-6z" />
    <path d="M4 16h6v4h-6z" />
    <path d="M14 12h6v8h-6z" />
    <path d="M14 4h6v4h-6z" />
  </Icon>
)

/** A container. The thing this whole app is about. */
export const IconImages: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9z" />
    <path d="M12 12l8 -4.5" />
    <path d="M12 12v9" />
    <path d="M12 12l-8 -4.5" />
  </Icon>
)

export const IconActivity: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M3 12h4l3 8l4 -16l3 8h4" />
  </Icon>
)

export const IconSettings: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
    <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
  </Icon>
)

export const IconSystem: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M3 4m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" />
    <path d="M3 12m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" />
    <path d="M7 8l0 .01" />
    <path d="M7 16l0 .01" />
  </Icon>
)

export const IconAbout: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
    <path d="M12 17l0 .01" />
    <path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4" />
  </Icon>
)

export const IconMore: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
  </Icon>
)

export const IconSun: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
    <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />
  </Icon>
)

export const IconMoon: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />
  </Icon>
)

/** Auto: half light, half dark. */
export const IconAuto: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M12 3a9 9 0 0 0 0 18v-18z" />
    <path d="M12 3a9 9 0 0 1 0 18" />
  </Icon>
)

export const IconRefresh: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
  </Icon>
)

export const IconInfo: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
    <path d="M12 9h.01" />
    <path d="M11 12h1v4h1" />
  </Icon>
)

export const IconChevronRight: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M9 6l6 6l-6 6" />
  </Icon>
)

export const IconSearch: IconFC = ({ cls }) => (
  <Icon cls={cls}>
    <path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
    <path d="M21 21l-6 -6" />
  </Icon>
)
