import { env } from './config.ts'
import type { ScannedService } from './compose/scan.ts'
import {
  listTags,
  headDigest,
  TagListTooLarge,
  RepositoryNotFound,
  type TagInfo,
} from './registry/index.ts'
import { probeByReleases } from './registry/probe.ts'
import { resolveSource, guessFromImagePath } from './resolver/index.ts'
import { selectUpdate, type Comparison } from './versions/compare.ts'
import { inferPattern, isPatternKind, type PatternKind } from './versions/patterns.ts'

/**
 * One service in, one verdict out.
 *
 * Every non-update outcome is named. Nothing here may return "up to date" unless the
 * comparison genuinely ran and found nothing newer -- the two bugs found while building
 * this both took the shape of an unrelated failure disguising itself as "current".
 */
export type Detection =
  | { status: 'update'; tag: string; magnitude: string; via: Source; observed: TagInfo[] }
  | { status: 'up-to-date'; via: Source; observed: TagInfo[]; constrainedFrom?: string }
  /** Rolling or digest-pinned: compare digests, not tag strings. */
  | { status: 'digest-watch'; currentDigest: string | null }
  /** No `dockhand.pattern` label and none could be inferred -- needs a human. */
  | { status: 'no-pattern'; detail: string }
  /** The pinned tag does not match its declared pattern. */
  | { status: 'unparseable'; detail: string }
  | { status: 'bad-refinement'; detail: string }
  /** Never published to a registry (a locally-built image). */
  | { status: 'not-published'; detail: string }
  /** Too many tags to enumerate and no source repo to probe releases from. */
  | { status: 'unresolvable'; detail: string }
  | { status: 'error'; detail: string }

/** How the candidate tag list was obtained -- surfaced so a probe-derived result is
 *  never mistaken for an exhaustive one. */
export type Source = 'registry' | 'releases'

export function patternFor(svc: ScannedService): PatternKind | null {
  if (svc.pattern && isPatternKind(svc.pattern)) return svc.pattern
  if (svc.ref?.digest) return 'digest'
  return svc.ref?.tag ? inferPattern(svc.ref.tag) : null
}

export async function detect(svc: ScannedService): Promise<Detection> {
  const ref = svc.ref
  if (!ref) return { status: 'no-pattern', detail: 'no image reference' }

  const kind = patternFor(svc)
  if (!kind) {
    return {
      status: 'no-pattern',
      detail:
        `cannot infer a pattern from tag "${ref.tag}" -- ` +
        `add a dockhand.pattern label (use "regex" with dockhand.tag.include for odd shapes)`,
    }
  }

  // Rolling tags and digest pins have no ordering; movement shows up as a digest change.
  if (kind === 'latest' || kind === 'digest' || !ref.tag) {
    try {
      const digest = await headDigest(ref.registry, ref.repository, ref.tag ?? 'latest')
      return { status: 'digest-watch', currentDigest: digest }
    } catch (err) {
      return { status: 'error', detail: (err as Error).message }
    }
  }

  const tagInclude = normaliseInclude(svc.tagInclude ?? svc.wud.tagInclude)

  let tags: string[]
  let observed: TagInfo[] = []
  let via: Source = 'registry'
  try {
    observed = await listTags(ref.registry, ref.repository)
    tags = observed.map((t) => t.tag)
  } catch (err) {
    if (err instanceof RepositoryNotFound) {
      return {
        status: 'not-published',
        detail: `${ref.registry}/${ref.repository} is not in the registry (locally built?)`,
      }
    }
    if (err instanceof TagListTooLarge) {
      // The repository tags every commit and PR (immich-machine-learning is past
      // 148,000 tags). Ask the source project what it released instead, and confirm
      // each candidate with a HEAD.
      //
      // This whole fallback runs INSIDE a catch block, so it needs its own guard --
      // resolveSource and probeByReleases both make network calls, and an exception
      // from either would otherwise escape detect() entirely and abort the scan.
      try {
        const resolved = await resolveSource({
          registry: ref.registry,
          repository: ref.repository,
          tag: ref.tag,
          sourceLabel: svc.sourceLabel,
        })
        const sourceRepo = resolved.sourceRepo ?? guessFromImagePath(ref.registry, ref.repository)
        if (!sourceRepo) {
          return {
            status: 'unresolvable',
            detail:
              `${err.message}, and no source repo is known to probe releases from -- ` +
              `add a dockhand.source label`,
          }
        }
        const probe = await probeByReleases({
          registry: ref.registry,
          repository: ref.repository,
          currentTag: ref.tag,
          sourceRepo,
          githubToken: env.githubToken,
        })
        if (probe.tags.length <= 1) {
          return {
            status: 'unresolvable',
            detail: `${err.message}; probing ${sourceRepo} releases confirmed no image tags`,
          }
        }
        observed = probe.tags.map((tag) => ({ tag }))
        tags = probe.tags
        via = 'releases'
      } catch (fallbackErr) {
        return {
          status: 'error',
          detail: `release probing failed: ${(fallbackErr as Error).message}`,
        }
      }
    } else {
      return { status: 'error', detail: (err as Error).message }
    }
  }

  const cmp: Comparison = selectUpdate({
    currentTag: ref.tag,
    availableTags: tags,
    kind,
    tagInclude,
    regex: tagInclude,
  })

  switch (cmp.status) {
    case 'update':
      return { status: 'update', tag: cmp.tag, magnitude: cmp.magnitude, via, observed }
    case 'up-to-date':
      return { status: 'up-to-date', via, observed, constrainedFrom: cmp.constrainedFrom }
    case 'unparseable-current':
      return { status: 'unparseable', detail: cmp.detail }
    case 'bad-refinement':
      return { status: 'bad-refinement', detail: cmp.detail }
    case 'not-orderable':
      return { status: 'digest-watch', currentDigest: null }
  }
}

/** Compose escapes a literal `$` as `$$`; the labels are read raw from the file, so the
 *  escape has to be undone before the string is used as a regex. */
function normaliseInclude(raw: string | null | undefined): string | null {
  return raw ? raw.replace(/\$\$/g, '$') : null
}
