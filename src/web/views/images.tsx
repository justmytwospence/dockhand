import type { FC } from 'hono/jsx'
import type { ScannedService } from '../../compose/scan.ts'
import { Layout, Empty, Table, type MissingSetting } from './layout.tsx'
import { displayName } from '../../images/ref.ts'
import { refLinks } from '../../links.ts'

const FILTERS = [
  ['all', 'All'],
  ['watched', 'Watched'],
  ['unlabelled', 'Unlabelled'],
  ['unwatchable', 'Not watchable'],
  ['attention', 'Needs attention'],
] as const

export interface StatusRow {
  stack: string
  service: string
  last_status: string | null
  last_detail: string | null
  constrained_from: string | null
  source_url?: string | null
}

export const ImagesPage: FC<{
  services: ScannedService[]
  filter: string
  q: string
  statusMap: Map<string, StatusRow>
  missing?: MissingSetting[]
}> = ({ services, filter, q, statusMap, missing }) => (
  <Layout title="Images" path="/images" missing={missing}>
    <h2>Image inventory</h2>
    <p class="sub">
      Read directly from the compose files in the working tree &mdash; never from running
      container labels, so a label edit takes effect on the next scan without recreating
      anything.
    </p>

    <form class="imgfilters" hx-get="/images" hx-target="#images-table" hx-swap="innerHTML">
      <nav class="filters">
        {FILTERS.map(([key, label]) => (
          <label class={filter === key ? 'active' : ''}>
            <input
              type="radio"
              name="filter"
              value={key}
              checked={filter === key}
              hx-get="/images"
              hx-target="#images-table"
              hx-include="closest form"
            />
            {label}
          </label>
        ))}
      </nav>
      <input
        type="search"
        name="q"
        value={q}
        placeholder="filter by stack, service or image…"
        hx-get="/images"
        hx-target="#images-table"
        hx-include="closest form"
        hx-trigger="input changed delay:250ms, search"
      />
    </form>

    <div id="images-table">
      <ImagesTable services={services} statusMap={statusMap} />
    </div>
  </Layout>
)

export const ImagesTable: FC<{
  services: ScannedService[]
  statusMap: Map<string, StatusRow>
}> = ({ services, statusMap }) =>
  services.length === 0 ? (
    <Empty>Nothing matches this filter.</Empty>
  ) : (
    <Table>
      <thead>
        <tr>
          <th>Service</th>
          <th>Image</th>
          <th>Tag</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {services.map((s) => (
          <ImageRow svc={s} status={statusMap.get(`${s.stack}/${s.service}`)} />
        ))}
      </tbody>
    </Table>
  )

export const ImageRow: FC<{ svc: ScannedService; status?: StatusRow }> = ({ svc, status }) => (
  <tr id={`img-${svc.stack}-${svc.service}`}>
    <td class="nowrap">
      <span class="svc-stack">{svc.stack}</span>
      <span class="svc-name">{svc.service}</span>
    </td>
    <td class="mono">
      {(() => {
        if (!svc.ref) return svc.imageRaw ?? '—'
        const l = refLinks(svc.ref, svc.ref.tag, status?.source_url ?? null)
        const name = displayName(svc.ref)
        return l.image ? (
          <a class="ext" href={l.image} target="_blank" rel="noopener">
            {name}
          </a>
        ) : (
          name
        )
      })()}
    </td>
    <td class="mono">
      {(() => {
        if (!svc.ref?.tag) return '—'
        const l = refLinks(svc.ref, svc.ref.tag, status?.source_url ?? null)
        const href = l.tag ?? l.releases
        return href ? (
          <a class="ext" href={href} target="_blank" rel="noopener">
            {svc.ref.tag}
          </a>
        ) : (
          svc.ref.tag
        )
      })()}
    </td>
    <td>
      {status?.last_status ? (
        <>
          <span class="pill err">{status.last_status}</span>
          {status.last_detail ? <div class="detail">{status.last_detail}</div> : null}
        </>
      ) : svc.unwatchable ? (
        <span class="pill muted">{svc.unwatchable}</span>
      ) : svc.watched ? (
        <span class="pill ok">watched</span>
      ) : (
        <span class="pill warn">unlabelled</span>
      )}
      {status?.constrained_from ? (
        <div class="detail">
          pinned &mdash; <span class="mono">{status.constrained_from}</span> available
        </div>
      ) : null}
    </td>
    <td class="nowrap">
      {svc.watched ? (
        <button
          class="linkish"
          hx-post={`/images/${svc.stack}/${svc.service}/check`}
          hx-target="closest tr"
          hx-swap="outerHTML"
          hx-disabled-elt="this"
        >
          Check now
        </button>
      ) : null}
    </td>
  </tr>
)
