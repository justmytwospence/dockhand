/**
 * One-time migration: derive `shipshape.*` labels from the existing `wud.*` labels and
 * from each image's current tag, and write them into the compose files.
 *
 * Editing is byte-level surgery, never a YAML re-serialisation: the label block is
 * inserted immediately after the existing `wud.watch` line (or after the last `wud.*`
 * line) at the same indentation, and nothing else in the file is touched. These compose
 * files are heavily commented -- traefik's carries 74 comment lines -- and a round-trip
 * through a YAML emitter would quietly reflow them.
 *
 *   npm run migrate-labels -- --dry     # print the diff and stop
 *   npm run migrate-labels              # write
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { inferPattern } from '../versions/patterns.ts'

/**
 * Tags whose shape no built-in pattern can express. Each needs a regex and a source
 * repo chosen by hand once -- guessing here is exactly what this tool is supposed to
 * avoid doing silently.
 */
const MANUAL: Record<string, { pattern: string; tagInclude?: string; source?: string; policy?: string; note: string }> = {
  // linuxserver's grocy uses a `version-` prefix ahead of the upstream tag.
  'grocy/grocy': {
    pattern: 'regex',
    tagInclude: String.raw`^version-v(?<major>\d{1,3})\.(?<minor>\d+)\.(?<patch>\d+)$$`,
    source: 'https://github.com/grocy/grocy',
    note: 'version-v2.7.1',
  },
  // Debian-packaged signal-cli: dashes where the version would have dots.
  'openclaw/signal-cli': {
    pattern: 'regex',
    tagInclude: String.raw`^v(?<major>\d{1,3})-(?<minor>\d+)-(?<patch>\d+)-(?<build>\d+)$$`,
    source: 'https://github.com/AsamK/signal-cli',
    note: 'v0-14-3-1',
  },
  // A local fork: upstream version plus a fork counter.
  'paperless/paperless-webdav': {
    pattern: 'regex',
    tagInclude: String.raw`^v(?<major>\d{1,3})\.(?<minor>\d+)\.(?<patch>\d+)-fork\.(?<build>\d+)$$`,
    note: 'v2.3.6-fork.8',
  },
  // Built locally by the mcpjungle stack; it exists in no registry.
  'mcpjungle/mcpjungle-init': {
    pattern: 'regex',
    policy: 'skip',
    note: 'locally-built image, never published',
  },
  // Monero uses four-component versions behind a `v`.
  'monero/monerod': {
    pattern: 'regex',
    tagInclude: String.raw`^v(?<major>\d{1,3})\.(?<minor>\d+)\.(?<patch>\d+)\.(?<build>\d+)$$`,
    source: 'https://github.com/monero-project/monero',
    note: 'v0.18.4.6',
  },
  // Its own registry publishes ~70k tags and exposes no release feed to probe.
  'openhands/openhands': {
    pattern: 'semver-minor',
    source: 'https://github.com/All-Hands-AI/OpenHands',
    note: 'huge tag list; source label enables release probing',
  },
}

/** Refinements dropped because they contradict the tag actually pinned in the file. */
const mismatched: string[] = []

/** Does the pinned tag satisfy this refinement? Compose escapes a literal `$` as `$$`. */
function tagSatisfies(tag: string | null, include: string): boolean {
  if (!tag) return false
  try {
    return new RegExp(include.replace(/\$\$/g, '$')).test(tag)
  } catch {
    return false // an uncompilable refinement is never carried over
  }
}

interface Plan {
  file: string
  service: string
  stack: string
  labels: [string, string][]
  reason: string
}

function planFor(svc: ScannedService): Plan | null {
  if (svc.unwatchable === 'excluded') return null
  // Locally-built and interpolated images have nothing to poll; leave them unlabelled
  // so the inventory still lists them but detection never tries.
  if (svc.unwatchable === 'build' || svc.unwatchable === 'interpolated' || svc.unwatchable === 'no-image') {
    return null
  }
  if (svc.pattern) return null // already migrated
  if (!svc.ref) return null

  const id = `${svc.stack}/${svc.service}`
  const labels: [string, string][] = []
  const manual = MANUAL[id]

  let pattern: string | null
  let reason: string
  if (manual) {
    pattern = manual.pattern
    reason = manual.note
  } else if (svc.ref.digest) {
    pattern = 'digest'
    reason = 'digest-pinned'
  } else {
    pattern = svc.ref.tag ? inferPattern(svc.ref.tag) : 'latest'
    reason = svc.ref.tag ?? 'no tag'
  }
  if (!pattern) return null // reported separately as needing a human

  labels.push(['shipshape.watch', '"true"'])
  labels.push(['shipshape.pattern', pattern])

  // A refinement is only carried over if the tag actually pinned in the file satisfies
  // it. Some `wud.tag.include` values disagree with their own image -- error-pages is
  // pinned at 4.0.0 but labelled `^\d{1,3}$$` (major-only) -- and copying that blindly
  // would exclude every candidate and report the service up to date forever. Dropping
  // the mismatched refinement leaves the pattern to do the work, which is correct.
  const include = manual?.tagInclude ?? svc.wud.tagInclude
  if (include) {
    if (manual || tagSatisfies(svc.ref.tag, include)) {
      labels.push(['shipshape.tag.include', `'${include}'`])
    } else {
      mismatched.push(
        `${id}: dropped tag.include ${include} -- does not match pinned tag "${svc.ref.tag}"`,
      )
    }
  }

  // WUD's gate (`wud.trigger.exclude: dockercompose.auto`) marks the datastores and
  // infrastructure that must never auto-apply. That intent carries over directly.
  const policy = manual?.policy ?? (svc.wud.gated ? 'gated' : null)
  if (policy) labels.push(['shipshape.policy', policy])

  // Unwatched-by-WUD services (sidecar databases, mostly) become detection-only: they
  // appear in the inventory and get PRs, but nothing auto-merges. That is coverage WUD
  // never had.
  if (!policy && svc.wud.watch !== 'true') labels.push(['shipshape.policy', 'manual'])

  const source = manual?.source ?? linkTemplateToSource(svc.wud.link)
  if (source) labels.push(['shipshape.source', source])

  // A stack that is intentionally stopped still gets labels, so reviving it later needs
  // no migration -- but it must never auto-update while dormant.
  if (svc.unwatchable === 'disabled' && !labels.some(([k]) => k === 'shipshape.policy')) {
    labels.push(['shipshape.policy', 'manual'])
  }

  return { file: svc.composeFile, service: svc.service, stack: svc.stack, labels, reason }
}

/** `wud.link.template` encodes hand-curated knowledge of where an image's releases live.
 *  Mine it rather than rediscovering it. */
function linkTemplateToSource(tpl: string | null): string | null {
  if (!tpl) return null
  const m = /https:\/\/github\.com\/([^/]+)\/([^/]+)/.exec(tpl)
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}

/**
 * Insert the label lines into the file, immediately after the service's existing
 * `wud.watch` line where there is one (so related labels stay together), otherwise
 * after the last `wud.*` line, otherwise after the `labels:` key.
 */
function applyToFile(text: string, plan: Plan): { text: string; ok: boolean; detail?: string } {
  const lines = text.split('\n')

  // Scope the search to the `services:` block first. Matching `<name>:` anywhere in the
  // file finds the wrong thing constantly: `wud` is also a network name, and
  // `traefik-redis` also appears under another service's `depends_on:`.
  let svcStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^services:\s*$/.test(lines[i]!)) {
      svcStart = i
      break
    }
  }
  if (svcStart === -1) return { text, ok: false, detail: 'no top-level services: block' }

  let svcEnd = lines.length
  for (let i = svcStart + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim() || line.startsWith('#')) continue
    // Any other top-level key ends the services block.
    if (!/^\s/.test(line)) {
      svcEnd = i
      break
    }
  }

  // Service keys sit at the first indent level inside that block.
  const startRe = new RegExp(`^(\\s+)${escapeRe(plan.service)}:\\s*$`)
  let start = -1
  let indent = ''
  for (let i = svcStart + 1; i < svcEnd; i++) {
    const m = startRe.exec(lines[i]!)
    if (!m) continue
    // Only a direct child of `services:` -- 2 or 4 spaces in practice, never deeper
    // nesting like a depends_on entry.
    if (m[1]!.length > 4) continue
    start = i
    indent = m[1]!
    break
  }
  if (start === -1) return { text, ok: false, detail: 'service block not found' }

  // The block ends at the next line with indentation <= the service key's.
  let end = svcEnd
  for (let i = start + 1; i < svcEnd; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    const ind = line.match(/^\s*/)![0]
    if (ind.length <= indent.length) {
      end = i
      break
    }
  }

  let anchor = -1
  let labelIndent = ''
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!
    if (/^\s*wud\.watch\s*:/.test(line)) {
      anchor = i
      labelIndent = line.match(/^\s*/)![0]
    } else if (anchor === -1 && /^\s*wud\./.test(line)) {
      anchor = i
      labelIndent = line.match(/^\s*/)![0]
    } else if (/^\s*wud\./.test(line) && anchor !== -1 && i > anchor) {
      // keep the anchor at wud.watch when present
    }
  }

  if (anchor === -1) {
    for (let i = start + 1; i < end; i++) {
      if (/^\s*labels\s*:/.test(lines[i]!)) {
        anchor = i
        labelIndent = lines[i]!.match(/^\s*/)![0] + '  '
        break
      }
    }
  }

  if (anchor !== -1) {
    const block = plan.labels.map(([k, v]) => `${labelIndent}${k}: ${v}`)
    lines.splice(anchor + 1, 0, ...block)
    return { text: lines.join('\n'), ok: true }
  }

  // No labels: block at all -- create one directly after the `image:` line, which is
  // where a reader expects it and which every watchable service necessarily has.
  let imageLine = -1
  for (let i = start + 1; i < end; i++) {
    if (/^\s*image\s*:/.test(lines[i]!)) {
      imageLine = i
      break
    }
  }
  if (imageLine === -1) return { text, ok: false, detail: 'neither labels: nor image: found' }

  const keyIndent = lines[imageLine]!.match(/^\s*/)![0]
  const block = [
    `${keyIndent}labels:`,
    ...plan.labels.map(([k, v]) => `${keyIndent}  ${k}: ${v}`),
  ]
  lines.splice(imageLine + 1, 0, ...block)
  return { text: lines.join('\n'), ok: true }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function main(): void {
  const dry = process.argv.includes('--dry')
  const services = scanRepo(env.repoDir, ['shipshape'])

  const plans: Plan[] = []
  const skipped: string[] = []
  for (const svc of services) {
    const p = planFor(svc)
    if (p) plans.push(p)
    else if (svc.ref && !svc.pattern && svc.unwatchable !== 'excluded') {
      skipped.push(
        `${svc.stack}/${svc.service}  ${svc.imageRaw ?? '-'}  (${svc.unwatchable ?? 'no pattern inferred'})`,
      )
    }
  }

  const byFile = new Map<string, Plan[]>()
  for (const p of plans) {
    const arr = byFile.get(p.file) ?? []
    arr.push(p)
    byFile.set(p.file, arr)
  }

  let written = 0
  let failed = 0
  for (const [file, filePlans] of byFile) {
    const abs = join(env.repoDir, file)
    let text = readFileSync(abs, 'utf8')
    const before = text
    // Apply bottom-up so earlier insertions do not shift later line numbers.
    const ordered = [...filePlans].reverse()
    for (const p of ordered) {
      const r = applyToFile(text, p)
      if (!r.ok) {
        console.error(`  !! ${file} ${p.service}: ${r.detail}`)
        failed++
        continue
      }
      text = r.text
    }
    if (text !== before) {
      if (!dry) writeFileSync(abs, text)
      written++
      console.log(`${dry ? 'would update' : 'updated'} ${file}  (${filePlans.length} services)`)
    }
  }

  console.log(`\n${plans.length} services labelled across ${written} files, ${failed} failures`)
  if (skipped.length) {
    console.log(`\n${skipped.length} left unlabelled (need a human decision):`)
    for (const s of skipped) console.log(`  ${s}`)
  }
  if (mismatched.length) {
    console.log(`\n${mismatched.length} refinement(s) dropped as inconsistent with their own image:`)
    for (const m of mismatched) console.log(`  ${m}`)
  }
  if (dry) console.log('\n(dry run -- nothing written)')
}

main()
