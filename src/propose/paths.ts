import { dirname, relative, resolve, sep } from 'node:path'

/**
 * How far a drafted proposal may reach, expressed as a boundary in the repository.
 *
 * The boundary is derived from where the service's compose file sits, which is the
 * whole idea: a stack is a directory, so "this stack's files" is `dirname(composeFile)`
 * and needs no configuration beyond naming the rung.
 *
 * | scope          | boundary                                  |
 * |----------------|-------------------------------------------|
 * | `none`         | nothing                                   |
 * | `service`      | this service's block in its compose file  |
 * | `compose-file` | any service in that compose file          |
 * | `compose-dir`  | any file in the compose file's directory  |
 * | `repo`         | any file in the repository                |
 *
 * `service` is the default. The first two rungs are about which *service* may change;
 * the last two are about which *file* may change, and both limits apply at once — at
 * `compose-dir` a proposal may edit a sibling config file, and may still only touch the
 * services its service-level scope permits inside a compose file.
 *
 * ## Two limits that no scope lifts
 *
 * **Never binary.** There is nothing to anchor to in a PNG. Structured files (YAML,
 * JSON) take the path operations; everything else — `.conf`, `.sh`, a Dockerfile —
 * takes anchored text replacement, where the anchor must match exactly once.
 *
 * **Never its own guardrails, never anything executable.** A proposal can only add a
 * commit a human reviews — but a diff review is exactly where "one line in policy.yaml"
 * slips past, and shipshape's policy file is where its own limits live. Workflows and
 * `bin/` are executable on merge or on next run. Excluded at every scope including
 * `repo`, for the same reason shipshape never deploys itself: a rule that can be
 * configured away is not a limit.
 */

export type ProposeScope = 'none' | 'service' | 'compose-file' | 'compose-dir' | 'repo'

export const SCOPES: ProposeScope[] = ['none', 'service', 'compose-file', 'compose-dir', 'repo']

/**
 * Read `shipshape.propose`. Unset means `service`.
 *
 * `off` is the original spelling of `none`. An unrecognised value narrows to `service`
 * rather than widening — a typo must never grant reach.
 */
export function scopeFor(label: string | null | undefined): ProposeScope {
  if (!label) return 'service'
  const v = label.trim().toLowerCase()
  if (v === 'off' || v === 'none') return 'none'
  if (v === 'compose-file' || v === 'file') return 'compose-file'
  if (v === 'compose-dir' || v === 'compose-directory' || v === 'directory' || v === 'dir') {
    return 'compose-dir'
  }
  if (v === 'repo' || v === 'repository' || v === 'any') return 'repo'
  return 'service'
}

/** Paths no proposal may write, whatever its scope. Repo-relative, POSIX separators. */
export function isForbidden(relPath: string, selfStack: string): boolean {
  const p = relPath.split(sep).join('/').replace(/^\.\//, '')
  const first = p.split('/')[0] ?? ''
  if (first === selfStack) return true // its own configuration, including its policy
  if (first === '.github' || first === '.git') return true // executes on merge
  if (first === 'bin' || first === 'scripts') return true // executes on next run
  if (/(^|\/)\.env/.test(p)) return true // secrets, and gitignored anyway
  return false
}

/**
 * Binary files are the only type that cannot be edited.
 *
 * An earlier version of this restricted edits to YAML, reasoning that the deep-compare
 * needed a parse. That was backwards: the deep-compare never proved the edit was
 * *right*, only that the applier did exactly what the operations named and nothing
 * else — and an anchor matching exactly once gives the same guarantee with no parse at
 * all. Structured files (YAML, JSON) get the path operations; everything else gets
 * anchored replacement.
 */
export function isEditableType(relPath: string, content?: string): boolean {
  if (content !== undefined && content.includes('\0')) return false
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|db|sqlite3?|woff2?|ttf|so|bin)$/i.test(relPath)
}

/** Structured formats the path operations can address. Everything else is text. */
export function isStructured(relPath: string): boolean {
  return /\.(ya?ml|json)$/i.test(relPath)
}

/**
 * Which services a proposal may change.
 *
 * Separate from the file boundary because the two limits are independent and both
 * apply: a wide file scope still only reaches the services its rung permits inside a
 * compose file.
 */
export function allowedServices(
  scope: ProposeScope,
  primary: string,
  siblings: string[],
): string[] {
  if (scope === 'none') return []
  if (scope === 'service') return [primary]
  // Every wider rung permits the whole compose file.
  return siblings.includes(primary) ? siblings : [primary, ...siblings]
}

export interface Boundary {
  scope: ProposeScope
  /** Repo-relative directory the proposal may write within, or null for the whole repo. */
  root: string | null
  composeFile: string
}

/** The boundary for a service, derived from where its compose file lives. */
export function boundaryFor(scope: ProposeScope, composeFile: string): Boundary {
  if (scope === 'compose-dir') {
    const dir = dirname(composeFile).split(sep).join('/')
    return { scope, root: dir === '.' ? '' : dir, composeFile }
  }
  if (scope === 'repo') return { scope, root: null, composeFile }
  // The narrow rungs reach exactly one file.
  return { scope, root: composeFile, composeFile }
}

export type FileVerdict = { ok: true } | { ok: false; reason: string }

/** May this proposal write this file? */
export function canWrite(
  relPath: string,
  boundary: Boundary,
  selfStack: string,
  /** File contents, when already read — catches a binary with an innocent extension. */
  content?: string,
): FileVerdict {
  if (boundary.scope === 'none') return { ok: false, reason: 'this proposal may not change anything' }

  const p = normalise(relPath)
  if (escapesRepo(p)) return { ok: false, reason: `"${relPath}" is outside the repository` }
  if (isForbidden(p, selfStack)) {
    return { ok: false, reason: `"${p}" is never writable by a proposal` }
  }
  if (!isEditableType(p, content)) {
    return { ok: false, reason: `"${p}" is a binary file — describe the change as a note instead` }
  }

  if (boundary.scope === 'service' || boundary.scope === 'compose-file') {
    return p === normalise(boundary.composeFile)
      ? { ok: true }
      : { ok: false, reason: `this proposal may only change ${boundary.composeFile}` }
  }

  if (boundary.scope === 'compose-dir') {
    const root = boundary.root ?? ''
    const inside = root === '' ? !p.includes('/') : p === root || p.startsWith(`${root}/`)
    return inside
      ? { ok: true }
      : { ok: false, reason: `this proposal may only change files under ${root}/` }
  }

  return { ok: true } // repo, past the exclusions above
}

function normalise(p: string): string {
  return p.split(sep).join('/').replace(/^\.\//, '')
}

/** `../` traversal and absolute paths both leave the repository. */
function escapesRepo(p: string): boolean {
  if (p.startsWith('/')) return true
  const rel = relative('/repo', resolve('/repo', p))
  return rel.startsWith('..')
}

/** What the model is told it may touch. Kept in step with what canWrite enforces. */
export function describeBoundary(
  boundary: Boundary,
  primary: string,
  allowedServices: string[],
): string {
  const services =
    allowedServices.length > 1
      ? `Within ${boundary.composeFile} you may change these services: ${allowedServices.join(', ')}. Name the service on each operation; operations without one apply to ${primary}.`
      : `Within ${boundary.composeFile} you may change only the "${primary}" service.`

  switch (boundary.scope) {
    case 'none':
      return 'You may not change anything. Describe everything as notes.'
    case 'service':
    case 'compose-file':
      return `${services}\nYou may not change any other file.`
    case 'compose-dir':
      return [
        services,
        `You may also change other files under ${boundary.root}/ — a configuration file`,
        'this service reads, for instance. Use the path operations for YAML and JSON,',
        'and replace_text for anything else. Files outside that directory are notes.',
      ].join('\n')
    case 'repo':
      return [
        services,
        'You may also change files elsewhere in the repository: path operations for',
        "YAML and JSON, replace_text for anything else. shipshape's own configuration,",
        'CI workflows, scripts, and .env files are never writable.',
        'Prefer the narrowest change that works: reaching outside this stack needs a',
        'reason from the upstream documentation.',
      ].join('\n')
  }
}
