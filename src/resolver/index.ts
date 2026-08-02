import { getDb } from '../db.ts'
import { registryFetch } from '../registry/http.ts'

/**
 * Image -> upstream source repository.
 *
 * This is the problem Renovate declines to solve, and the reason this tool exists.
 * Measured across one real deployment's images: only about half carry an OCI annotation
 * pointing at the project that actually writes the release notes. Roughly a quarter
 * point at a *packaging* repo -- `traefik` -> `traefik-library-image`, every LinuxServer
 * image -> `linuxserver/docker-<app>` -- which is technically correct and useless. The
 * rest carry nothing.
 *
 * Three tiers, cheapest first, and the answer is cached permanently: manifest walks are
 * billed against the Docker Hub pull budget, and an image's source repo effectively
 * never changes.
 */

export type ResolutionTier = 'label' | 'annotation' | 'override' | 'lsio' | 'none'

export interface Resolution {
  /** `owner/repo` on GitHub, or null when unresolved. */
  sourceRepo: string | null
  tier: ResolutionTier
  detail?: string
}

/**
 * Docker Official Images and a few vendors annotate their *packaging* repo. Mapping
 * those by hand is unavoidable -- there is no metadata anywhere that connects
 * `docker-library/postgres` to `postgres/postgres`.
 */
const OVERRIDES: Record<string, string> = {
  'docker.io/library/postgres': 'postgres/postgres',
  'docker.io/library/redis': 'redis/redis',
  'docker.io/library/mariadb': 'MariaDB/server',
  'docker.io/library/nginx': 'nginx/nginx',
  'docker.io/library/traefik': 'traefik/traefik',
  'docker.io/library/nextcloud': 'nextcloud/server',
  'docker.io/library/influxdb': 'influxdata/influxdb',
  'docker.io/library/monica': 'monicahq/monica',
  'docker.io/library/mongo': 'mongodb/mongo',
  'docker.io/library/node': 'nodejs/node',
  'docker.io/traefik/traefik': 'traefik/traefik',
  // Image name and repo name disagree.
  'docker.io/miniflux/miniflux': 'miniflux/v2',
  'docker.io/n8nio/n8n': 'n8n-io/n8n',
  'docker.io/linkace/linkace': 'Kovah/LinkAce',
  'docker.io/crazymax/fail2ban': 'crazy-max/docker-fail2ban',
  'docker.io/nicolargo/glances': 'nicolargo/glances',
  'docker.io/grafana/grafana': 'grafana/grafana',
  'docker.io/apache/tika': 'apache/tika',
  'docker.io/actualbudget/actual-server': 'actualbudget/actual',
  'docker.io/getwud/wud': 'getwud/wud',
  'docker.io/binwiederhier/ntfy': 'binwiederhier/ntfy',
  'docker.io/henrygd/beszel': 'henrygd/beszel',
  'docker.io/henrygd/beszel-agent': 'henrygd/beszel',
  'docker.io/organizr/organizr': 'causefx/Organizr',
  'docker.io/huginn/huginn-single-process': 'huginn/huginn',
  'docker.io/pihole/pihole': 'pi-hole/docker-pi-hole',
  'docker.io/netdata/netdata': 'netdata/netdata',
  'docker.io/crowdsecurity/crowdsec': 'crowdsecurity/crowdsec',
  'docker.io/getmeili/meilisearch': 'meilisearch/meilisearch',
  'docker.io/gotenberg/gotenberg': 'gotenberg/gotenberg',
  'docker.io/qmcgaw/gluetun': 'qdm12/gluetun',
  'docker.io/prom/prometheus': 'prometheus/prometheus',
  'docker.io/telegraf': 'influxdata/telegraf',
  'docker.io/library/telegraf': 'influxdata/telegraf',
  'docker.io/valkey/valkey': 'valkey-io/valkey',
}

/** The annotation keys worth reading, in preference order. */
const SOURCE_KEYS = ['org.opencontainers.image.source', 'org.label-schema.vcs-url']

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

/** Normalise anything that looks like a GitHub URL down to `owner/repo`. Docker Official
 *  Images use a git-fragment form (`<repo>.git#<sha>:<subdir>`) that must be stripped. */
export function normaliseSourceUrl(raw: string): string | null {
  if (!raw) return null
  let s = raw.trim()
  s = s.split('#')[0]!
  s = s.replace(/^git\+/, '').replace(/\.git$/, '')
  const m = /github\.com[/:]([^/]+)\/([^/]+)/.exec(s)
  if (!m) return null
  return `${m[1]}/${m[2]}`
}

/** LinuxServer's own API exposes `project_url` -- the real upstream, which the OCI label
 *  never gives (it points at the packaging repo). One request resolves every lsio image. */
let lsioCache: Map<string, string> | null = null

async function lsioProjectUrls(): Promise<Map<string, string>> {
  if (lsioCache) return lsioCache
  const out = new Map<string, string>()
  try {
    const res = await fetch(
      'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false',
      { headers: { 'user-agent': 'dockhand/0.1' } },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { repositories?: Record<string, { name: string; project_url?: string }[]> }
      }
      for (const list of Object.values(body.data?.repositories ?? {})) {
        for (const img of list) {
          const repo = normaliseSourceUrl(img.project_url ?? '')
          if (repo) out.set(img.name, repo)
        }
      }
    }
  } catch {
    // Offline or upstream down -- fall through to the annotation tier.
  }
  lsioCache = out
  return out
}

/** Walk the manifest for annotations without pulling the image. They hide in four
 *  distinct places and real images use every one of them. */
async function fromAnnotations(
  registry: string,
  repository: string,
  tag: string,
): Promise<string | null> {
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  const base = `https://${host}/v2/${repository}`

  const read = (obj: Record<string, string> | undefined): string | null => {
    if (!obj) return null
    for (const k of SOURCE_KEYS) {
      const v = obj[k]
      if (v) {
        const norm = normaliseSourceUrl(v)
        if (norm) return norm
      }
    }
    return null
  }

  const res = await registryFetch(`${base}/manifests/${tag}`, { accept: ACCEPT, billed: true })
  if (!res.ok) return null
  const doc = (await res.json()) as {
    annotations?: Record<string, string>
    manifests?: { digest: string; annotations?: Record<string, string>; platform?: { architecture?: string; os?: string } }[]
    config?: { digest?: string }
  }

  // 1. index-level annotations (immich)
  const atIndex = read(doc.annotations)
  if (atIndex) return atIndex

  let manifest = doc
  if (doc.manifests?.length) {
    // 2. descriptor-level annotations -- where every Docker Official Image puts it
    for (const d of doc.manifests) {
      const atDesc = read(d.annotations)
      if (atDesc) return atDesc
    }
    // Recurse into the amd64 child (this host is amd64).
    const child =
      doc.manifests.find((m) => m.platform?.architecture === 'amd64' && m.platform.os === 'linux') ??
      doc.manifests[0]!
    const cres = await registryFetch(`${base}/manifests/${child.digest}`, {
      accept: ACCEPT,
      billed: true,
    })
    if (!cres.ok) return null
    manifest = (await cres.json()) as typeof doc
  }

  // 3. manifest-level annotations (authelia)
  const atManifest = read(manifest.annotations)
  if (atManifest) return atManifest

  // 4. config blob labels -- the majority case
  const cfgDigest = manifest.config?.digest
  if (!cfgDigest) return null
  const blob = await registryFetch(`${base}/blobs/${cfgDigest}`, { billed: true })
  if (!blob.ok) return null
  const cfg = (await blob.json()) as { config?: { Labels?: Record<string, string> } }
  return read(cfg.config?.Labels)
}

export async function resolveSource(opts: {
  registry: string
  repository: string
  tag: string
  /** `dockhand.source` label, which always wins. */
  sourceLabel?: string | null
}): Promise<Resolution> {
  const { registry, repository, tag, sourceLabel } = opts
  const key = `${registry}/${repository}`

  if (sourceLabel) {
    const norm = normaliseSourceUrl(sourceLabel)
    if (norm) return { sourceRepo: norm, tier: 'label' }
  }

  const cached = getDb()
    .prepare(`SELECT source_url, tier FROM resolutions WHERE registry = ? AND repository = ?`)
    .get(registry, repository) as { source_url: string | null; tier: string } | undefined
  if (cached) return { sourceRepo: cached.source_url, tier: cached.tier as ResolutionTier }

  let result: Resolution = { sourceRepo: null, tier: 'none' }

  const override = OVERRIDES[key]
  if (override) {
    result = { sourceRepo: override, tier: 'override' }
  } else if (repository.startsWith('linuxserver/')) {
    const name = repository.slice('linuxserver/'.length)
    const lsio = (await lsioProjectUrls()).get(name)
    if (lsio) result = { sourceRepo: lsio, tier: 'lsio' }
  }

  if (!result.sourceRepo) {
    try {
      const ann = await fromAnnotations(registry, repository, tag)
      if (ann) result = { sourceRepo: ann, tier: 'annotation' }
    } catch (err) {
      result = { sourceRepo: null, tier: 'none', detail: (err as Error).message }
    }
  }

  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, detail, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(registry, repository) DO UPDATE SET
         source_url = excluded.source_url, tier = excluded.tier, resolved_at = excluded.resolved_at`,
    )
    .run(registry, repository, result.sourceRepo, result.tier, result.detail ?? null, new Date().toISOString())

  return result
}

/** ghcr images very often live in the repo whose path they mirror. Used only as a probe
 *  hint when nothing else resolved -- never written to the cache as a real resolution. */
export function guessFromImagePath(registry: string, repository: string): string | null {
  if (registry !== 'ghcr.io') return null
  const parts = repository.split('/')
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}
