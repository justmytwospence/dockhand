import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseImageRef, type ImageRef } from '../images/ref.ts'

/**
 * Reads the desired state out of the compose files themselves.
 *
 * Critically, `dockhand.*` labels are read HERE -- from the files in git -- and never
 * from running containers. WUD reads live Docker metadata, which is why a label
 * refactor in this repo sat inert on ~80 containers for weeks (AGENTS.md, incident
 * ad98576): its recreate clones the running container's config, so stale labels
 * survive forever. Parsing files makes that entire failure class impossible.
 */

export type UnwatchableReason = 'build' | 'interpolated' | 'no-image' | 'disabled' | 'excluded'

export interface ScannedService {
  stack: string
  service: string
  composeFile: string
  imageRaw: string | null
  ref: ImageRef | null
  labels: Record<string, string>
  profiles: string[]
  hasBuild: boolean
  watched: boolean
  unwatchable: UnwatchableReason | null
  /** dockhand.* label values, already split out. */
  pattern: string | null
  tagInclude: string | null
  policyLabel: string | null
  sourceLabel: string | null
  claudeLabel: string | null
  deployLabel: string | null
  /** wud.* equivalents, used by the migration script and the parity report. */
  wud: { watch: string | null; tagInclude: string | null; gated: boolean; link: string | null }
}

const SKIP_DIRS = new Set(['.git', '.claude', '.agents', 'bin', 'node_modules'])

/** Every `<stack>/docker-compose.yaml` plus the root infrastructure compose. */
export function findComposeFiles(repoRoot: string): string[] {
  const out: string[] = []
  const root = join(repoRoot, 'docker-compose.yaml')
  if (exists(root)) out.push(root)
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const f = join(repoRoot, entry.name, 'docker-compose.yaml')
    if (exists(f)) out.push(f)
  }
  return out.sort()
}

function exists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Compose accepts labels as a map or as a `key=value` list; normalise to a map. */
function normaliseLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const eq = item.indexOf('=')
      if (eq === -1) out[item] = ''
      else out[item.slice(0, eq)] = item.slice(eq + 1)
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === null || v === undefined ? '' : String(v)
    }
  }
  return out
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  if (typeof raw === 'string') return [raw]
  return []
}

export function scanComposeFile(repoRoot: string, file: string, excludeStacks: string[] = []): ScannedService[] {
  const rel = relative(repoRoot, file)
  // `<stack>/docker-compose.yaml` -> `<stack>`; the root file is the infrastructure
  // project, whose services must be brought up from the repo root (AGENTS.md gotcha 1).
  const stack = rel.includes('/') ? rel.split('/')[0]! : 'root'

  let doc: unknown
  try {
    doc = parseYaml(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!doc || typeof doc !== 'object') return []
  const services = (doc as { services?: Record<string, unknown> }).services
  if (!services || typeof services !== 'object') return []

  const out: ScannedService[] = []
  for (const [name, rawSvc] of Object.entries(services)) {
    if (!rawSvc || typeof rawSvc !== 'object') continue
    const svc = rawSvc as Record<string, unknown>

    const imageRaw = typeof svc.image === 'string' ? svc.image : null
    const labels = normaliseLabels(svc.labels)
    const profiles = toStringArray(svc.profiles)
    const hasBuild = svc.build !== undefined

    const pattern = labels['dockhand.pattern'] ?? null
    const tagInclude = labels['dockhand.tag.include'] ?? null
    const policyLabel = labels['dockhand.policy'] ?? null
    const sourceLabel = labels['dockhand.source'] ?? null
    const claudeLabel = labels['dockhand.claude'] ?? null
    const deployLabel = labels['dockhand.deploy'] ?? null
    const watchLabel = labels['dockhand.watch'] ?? null

    let unwatchable: UnwatchableReason | null = null
    if (excludeStacks.includes(stack)) unwatchable = 'excluded'
    else if (!imageRaw) unwatchable = 'no-image'
    // A locally-built image has no registry to poll. `build:` wins even when `image:`
    // is also set -- that combination just names the local build output.
    else if (hasBuild) unwatchable = 'build'
    // `image: ${FOO}` cannot be compared against registry tags, and rewriting it would
    // corrupt the indirection.
    else if (imageRaw.includes('${')) unwatchable = 'interpolated'
    else if (profiles.includes('disabled') || profiles.includes('standby')) unwatchable = 'disabled'

    const watched = watchLabel === 'true' && unwatchable === null

    out.push({
      stack,
      service: name,
      composeFile: rel,
      imageRaw,
      ref: imageRaw && !imageRaw.includes('${') ? parseImageRef(imageRaw) : null,
      labels,
      profiles,
      hasBuild,
      watched,
      unwatchable,
      pattern,
      tagInclude,
      policyLabel,
      sourceLabel,
      claudeLabel,
      deployLabel,
      wud: {
        watch: labels['wud.watch'] ?? null,
        tagInclude: labels['wud.tag.include'] ?? null,
        gated: (labels['wud.trigger.exclude'] ?? '').includes('dockercompose.auto'),
        link: labels['wud.link.template'] ?? null,
      },
    })
  }
  return out
}

export function scanRepo(repoRoot: string, excludeStacks: string[] = []): ScannedService[] {
  return findComposeFiles(repoRoot).flatMap((f) => scanComposeFile(repoRoot, f, excludeStacks))
}
