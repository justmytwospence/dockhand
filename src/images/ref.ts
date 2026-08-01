/**
 * Docker image reference parsing.
 *
 * The subtle rule: the part before the first `/` is a registry host only if it looks
 * like one (contains a `.` or `:`, or is exactly "localhost"). Otherwise it is a Docker
 * Hub namespace -- `linuxserver/radarr` is Hub, `lscr.io/linuxserver/radarr` is not.
 */

export interface ImageRef {
  /** Canonical registry host: docker.io, ghcr.io, lscr.io, quay.io, ... */
  registry: string
  /** namespace/name. Hub official images are normalised to `library/<name>`. */
  repository: string
  tag: string | null
  digest: string | null
  /** The reference exactly as it appeared in the compose file. */
  raw: string
}

export function parseImageRef(raw: string): ImageRef {
  let rest = raw.trim()

  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at !== -1) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }

  let registry = 'docker.io'
  const slash = rest.indexOf('/')
  if (slash !== -1) {
    const head = rest.slice(0, slash)
    if (head === 'localhost' || head.includes('.') || head.includes(':')) {
      registry = head
      rest = rest.slice(slash + 1)
    }
  }

  // A colon after the last slash is the tag separator; a colon before it is a registry
  // port, which has already been stripped above.
  let tag: string | null = null
  const lastSlash = rest.lastIndexOf('/')
  const colon = rest.indexOf(':', lastSlash === -1 ? 0 : lastSlash)
  if (colon !== -1) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }

  let repository = rest
  if (registry === 'docker.io' && !repository.includes('/')) {
    repository = `library/${repository}`
  }

  // index.docker.io and docker.io are the same registry; normalise so cache keys and
  // resolutions do not fork.
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') {
    registry = 'docker.io'
  }

  return { registry, repository, tag: tag || null, digest, raw }
}

/** Rebuild a reference with a new tag and/or digest, preserving the original registry
 *  and repository spelling (so `lscr.io/...` does not silently become `docker.io/...`). */
export function formatImageRef(ref: ImageRef, tag: string | null, digest: string | null): string {
  // Recover the original prefix rather than re-deriving it, so `library/` is not
  // introduced into a ref that did not have it.
  const base = ref.raw.split('@')[0]!
  const lastSlash = base.lastIndexOf('/')
  const colon = base.indexOf(':', lastSlash === -1 ? 0 : lastSlash)
  const withoutTag = colon === -1 ? base : base.slice(0, colon)
  let out = withoutTag
  if (tag) out += `:${tag}`
  if (digest) out += `@${digest}`
  return out
}

/** Human-facing short name used in PR titles and the UI. */
export function displayName(ref: ImageRef): string {
  const repo = ref.repository.startsWith('library/') ? ref.repository.slice(8) : ref.repository
  return ref.registry === 'docker.io' ? repo : `${ref.registry}/${repo}`
}
