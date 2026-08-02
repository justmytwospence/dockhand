import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Cron } from 'croner'
import { botIdentity, env, paths, validatePolicyText, type Policy } from './config.ts'
import { logEvent } from './db.ts'

/**
 * Editing policy.yaml from the browser.
 *
 * Settings ARE policy.yaml -- there is no second store to drift out of step, and the
 * file stays the tracked, reviewable source of truth the rest of this repo expects.
 * Edits are line splices, never a re-serialisation: the file is written for humans and
 * carries a comment above almost every key explaining why it is set that way, all of
 * which a YAML emitter would discard.
 */

export type SettingKind =
  | 'enum'
  | 'int'
  | 'number'
  | 'bool'
  | 'string'
  | 'windows'
  | 'cron'
  | 'model'

export interface SettingDef {
  /** Dotted path, e.g. `claude.model`. Top-level keys have no dot. */
  path: string
  kind: SettingKind
  label: string
  help: string
  options?: string[]
  min?: number
  /** Shown as "default: X" so a changed value is obvious. */
  defaultValue: string
  /** Present = read-only, with the reason shown. */
  locked?: string
  section: string
}

export const SETTINGS: SettingDef[] = [
  {
    section: 'Changelog analysis',
    path: 'claude.mode',
    kind: 'enum',
    options: ['advisory', 'off'],
    defaultValue: 'advisory',
    label: 'Mode',
    help: 'Advisory lets a verdict hold back an automatic merge. It can never cause one.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.model',
    kind: 'model',
    defaultValue: 'claude-haiku-4-5-20251001',
    label: 'Model',
    help: 'Pick from the list, or type an id to use one that is not listed.',
  },
  {
    section: 'Merging',
    path: 'model_tier.mode',
    kind: 'enum',
    options: ['off', 'shadow', 'enforce'],
    defaultValue: 'shadow',
    label: 'Model-decided updates',
    help: 'For services labelled dockhand.policy: model. Shadow records the decisions without acting on them.',
  },
  {
    section: 'Merging',
    path: 'merge.auto',
    kind: 'bool',
    defaultValue: 'false',
    label: 'Merge without asking',
    help: 'Only tag-only pull requests on the auto tier, patch/minor, with no verdict withholding them.',
  },
  {
    section: 'Merging',
    path: 'merge.max_per_run',
    kind: 'number',
    defaultValue: '3',
    label: 'Most merges per run',
    help: 'A ceiling so a misconfiguration merges a couple of things rather than the backlog.',
  },
  {
    section: 'Deploys',
    path: 'deploy.mode',
    kind: 'enum',
    options: ['auto', 'manual', 'off'],
    defaultValue: 'manual',
    label: 'After a merge',
    help: 'Auto brings the change up on the host. Manual syncs and sends you the command.',
  },
  {
    section: 'Deploys',
    path: 'deploy.health_window_s',
    kind: 'number',
    defaultValue: '120',
    label: 'Health window (seconds)',
    help: 'How long to wait for containers to come up healthy before calling it a failure.',
  },
  {
    section: 'Config proposals',
    path: 'propose.mode',
    kind: 'enum',
    options: ['auto', 'manual', 'off'],
    defaultValue: 'auto',
    label: 'Draft config changes',
    help: 'Auto drafts them whenever a verdict reports breakage. A drafted PR always needs a human.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.web.searches',
    kind: 'number',
    defaultValue: '4',
    label: 'Searches per call',
    help: 'How many web searches a single review or proposal may run.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.web.fetches',
    kind: 'number',
    defaultValue: '5',
    label: 'Pages read per call',
    help: 'Together with the size cap below, this sets the ceiling on what a call can cost.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.web.content_tokens',
    kind: 'number',
    defaultValue: '12000',
    label: 'Max tokens per page',
    help: 'Reading is the dominant cost: worst case per call is pages x this.',
  },
  {
    section: 'Config proposals',
    path: 'claude.code_model',
    kind: 'model',
    defaultValue: 'claude-opus-5',
    label: 'Model',
    help: 'Rare, high-stakes work — worth a stronger model than the changelog verdicts use.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.min_confidence',
    kind: 'enum',
    options: ['low', 'medium', 'high'],
    defaultValue: 'medium',
    label: 'Minimum confidence',
    help: 'An approval below this is treated as a caution and waits for you.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.monthly_budget_usd',
    kind: 'number',
    min: 0,
    defaultValue: '10',
    label: 'Monthly budget (USD)',
    help: 'Reaching it pauses analysis. Pull requests keep opening regardless.',
  },
  {
    section: 'Changelog analysis',
    path: 'claude.block_on',
    kind: 'string',
    defaultValue: 'block, caution',
    label: 'Hold on',
    help: 'Which verdicts hold back an automatic merge.',
    locked: 'the damper is load-bearing; edit policy.yaml directly to change it',
  },

  {
    section: 'Pull requests',
    path: 'prs.enabled',
    kind: 'bool',
    defaultValue: 'true',
    label: 'Open pull requests',
    help: 'Off keeps detection running but stops all pushing and PR creation.',
  },
  {
    section: 'Pull requests',
    path: 'prs.max_open',
    kind: 'int',
    min: 1,
    defaultValue: '5',
    label: 'Maximum open at once',
    help: 'New ones open as older ones are merged or closed.',
  },
  {
    section: 'Pull requests',
    path: 'prs.scope',
    kind: 'enum',
    options: ['coexist', 'full'],
    defaultValue: 'coexist',
    label: 'Coverage',
    help: 'Coexist takes only what another updater leaves alone. Full takes over everything.',
  },
  {
    section: 'Pull requests',
    path: 'merge_method',
    kind: 'enum',
    options: ['squash', 'merge', 'rebase'],
    defaultValue: 'squash',
    label: 'Merge method',
    help: 'Must be one the GitHub repository actually allows, or merging fails.',
  },

  {
    section: 'Sync',
    path: 'sync.push_main',
    kind: 'bool',
    defaultValue: 'true',
    label: 'Publish main',
    help: 'Required for pull requests: a branch cut from a stale origin reverts unpushed work when merged.',
  },
  {
    section: 'Sync',
    path: 'sync.blackout',
    kind: 'windows',
    defaultValue: '(none)',
    label: 'Blackout windows',
    help: 'Comma-separated HH:MM-HH:MM. No git or deploy work happens inside them.',
  },
  {
    section: 'Sync',
    path: 'sync.poll_active_s',
    kind: 'int',
    min: 15,
    defaultValue: '60',
    label: 'Poll interval, PRs open (s)',
    help: 'How often GitHub is checked while something is awaiting merge.',
  },
  {
    section: 'Sync',
    path: 'sync.poll_idle_s',
    kind: 'int',
    min: 30,
    defaultValue: '600',
    label: 'Poll interval, idle (s)',
    help: 'How often GitHub is checked when nothing is open.',
  },

  {
    section: 'Scanning',
    path: 'scan.cron',
    kind: 'cron',
    defaultValue: '0 0 3 * * *',
    label: 'Schedule',
    help: 'Six fields, seconds first. Applies immediately, no restart needed.',
  },

  {
    section: 'Updates',
    path: 'defaults.patch',
    kind: 'enum',
    options: ['auto', 'gated', 'manual', 'skip'],
    defaultValue: 'auto',
    label: 'Patch updates',
    help: 'What happens to a patch bump by default.',
  },
  {
    section: 'Updates',
    path: 'defaults.minor',
    kind: 'enum',
    options: ['auto', 'gated', 'manual', 'skip'],
    defaultValue: 'auto',
    label: 'Minor updates',
    help: 'What happens to a minor bump by default.',
  },
  {
    section: 'Updates',
    path: 'defaults.major',
    kind: 'enum',
    options: ['manual'],
    defaultValue: 'manual',
    label: 'Major updates',
    help: 'Majors always wait for a person.',
    locked: 'not configurable — a major always needs a human',
  },
  {
    section: 'Updates',
    path: 'defaults.digest',
    kind: 'enum',
    options: ['auto', 'gated', 'manual', 'skip'],
    defaultValue: 'manual',
    label: 'Digest bumps',
    help: 'What happens when a pinned digest moves.',
  },

  {
    section: 'Deploy',
    path: 'deploy.health_window_s',
    kind: 'int',
    min: 10,
    defaultValue: '120',
    label: 'Health check window (s)',
    help: 'How long a container must stay healthy after a deploy before it counts.',
  },
]

export function currentValue(policy: Policy, path: string): string {
  const raw = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], policy)
  if (Array.isArray(raw)) return raw.join(', ')
  return raw === undefined || raw === null ? '' : String(raw)
}

export type ApplyResult =
  | { ok: true; applied: string[]; commit: string | null }
  | { ok: false; errors: string[] }

export function applySettings(changes: Record<string, string>): ApplyResult {
  const file = paths.policy
  // Git wants the path relative to the repository root, wherever policy.yaml lives.
  const rel = relative(env.repoDir, file)
  let original: string
  try {
    original = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, errors: [`cannot read policy.yaml: ${(err as Error).message}`] }
  }

  // Never fold a browser edit into hand-edits sitting in the working tree -- the commit
  // would carry changes nobody reviewed here.
  const dirty = gitOut(['diff', '--name-only', '--', rel])
  if (dirty) {
    return {
      ok: false,
      errors: [
        'policy.yaml has uncommitted changes in the checkout. Commit or discard them first.',
      ],
    }
  }

  const errors: string[] = []
  const applied: string[] = []
  let text = original

  for (const [path, rawValue] of Object.entries(changes)) {
    const def = SETTINGS.find((s) => s.path === path)
    if (!def || def.locked) continue

    const value = rawValue.trim()
    const validation = validate(def, value)
    if (validation) {
      errors.push(`${def.label}: ${validation}`)
      continue
    }

    const spliced = spliceValue(text, path, format(def, value))
    if (!spliced) {
      errors.push(`${def.label}: could not find "${path}" in policy.yaml`)
      continue
    }
    if (spliced !== text) {
      text = spliced
      applied.push(path)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  if (applied.length === 0) return { ok: true, applied: [], commit: null }

  // A malformed file must never reach disk in a state the app would then fail to load.
  const check = validatePolicyText(text)
  if (!check.ok) return { ok: false, errors: [check.error] }

  writeFileSync(file, text)
  try {
    execFileSync('git', ['add', '--', rel], { cwd: env.repoDir })
    execFileSync(
      'git',
      [
        ...botIdentity(),
        'commit',
        '-m',
        `chore(dockhand): settings: ${applied.join(', ')}`,
        '--',
        rel,
      ],
      { cwd: env.repoDir },
    )
  } catch (err) {
    writeFileSync(file, original)
    execFileSync('git', ['checkout', '--', rel], { cwd: env.repoDir })
    return { ok: false, errors: [`could not commit the change: ${(err as Error).message}`] }
  }

  const sha = gitOut(['rev-parse', '--short', 'HEAD'])
  logEvent({
    level: 'info',
    kind: 'policy',
    message: `settings changed: ${applied.join(', ')}`,
    detail: sha ? `committed ${sha}` : undefined,
  })
  return { ok: true, applied, commit: sha }
}

function gitOut(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: env.repoDir, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function validate(def: SettingDef, value: string): string | null {
  switch (def.kind) {
    case 'enum':
      return def.options?.includes(value) ? null : `must be one of ${def.options?.join(', ')}`
    case 'bool':
      return value === 'true' || value === 'false' ? null : 'must be true or false'
    case 'int': {
      if (!/^\d+$/.test(value)) return 'must be a whole number'
      if (def.min !== undefined && Number(value) < def.min) return `must be at least ${def.min}`
      return null
    }
    case 'number': {
      if (!/^\d+(\.\d+)?$/.test(value)) return 'must be a number'
      if (def.min !== undefined && Number(value) < def.min) return `must be at least ${def.min}`
      return null
    }
    case 'cron':
      try {
        new Cron(value)
        return null
      } catch {
        return 'not a valid schedule expression'
      }
    case 'windows': {
      if (value === '') return null
      const bad = value
        .split(',')
        .map((w) => w.trim())
        .filter((w) => !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w))
      return bad.length ? `not a valid window: ${bad[0]}` : null
    }
    case 'model':
      return /^[A-Za-z0-9._-]+$/.test(value) ? null : 'not a valid model id'
    default:
      return null
  }
}

function format(def: SettingDef, value: string): string {
  if (def.kind === 'windows') {
    const items = value
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
    return items.length ? `[${items.map((w) => `"${w}"`).join(', ')}]` : '[]'
  }
  // Quoted in the file today and worth keeping quoted: an unquoted cron expression is
  // legal YAML but reads badly and invites a parser surprise.
  if (def.kind === 'cron') return `"${value}"`
  return value
}

/**
 * Replace one key's value, leaving every byte of structure and commentary alone.
 *
 * Top-level keys (`merge_method`) sit at indent 0; the rest live one level under their
 * section, and the section's range is what disambiguates identically-named keys.
 */
export function spliceValue(text: string, path: string, formatted: string): string | null {
  const lines = text.split('\n')
  const parts = path.split('.')

  let from = 0
  let to = lines.length
  let indent = ''

  if (parts.length === 2) {
    const [section, key] = parts as [string, string]
    const start = lines.findIndex((l) => new RegExp(`^${escapeRe(section)}:\\s*$`).test(l))
    if (start === -1) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (l.trim() === '' || l.startsWith('#')) continue
      if (!/^\s/.test(l)) {
        end = i
        break
      }
    }
    from = start + 1
    to = end
    indent = '  '
    parts[0] = key
  }

  const key = parts[parts.length - 1]!
  const re = new RegExp(`^(${indent}${escapeRe(key)}:[ \\t]*)(.*)$`)
  for (let i = from; i < to; i++) {
    const m = re.exec(lines[i]!)
    if (!m) continue
    // Preserve any trailing comment on the same line.
    const trailing = /(\s+#.*)$/.exec(m[2]!)?.[1] ?? ''
    lines[i] = `${m[1]}${formatted}${trailing}`
    return lines.join('\n')
  }
  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
