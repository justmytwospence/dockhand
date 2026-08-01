import type { Policy } from './config.ts'
import type { Magnitude } from './versions/patterns.ts'

/**
 * The decision engine: what may happen to an update, given the static policy and
 * whatever Claude concluded.
 *
 * Pure and exhaustively tested, because the failure mode is silent and expensive --
 * auto-merging something that needed a human. The governing rule is that Claude is a
 * ONE-DIRECTIONAL damper: a verdict can demote an auto-merge to a human hold, never
 * promote anything. That is also the prompt-injection boundary, since release notes are
 * untrusted input: the worst a hostile changelog can achieve is to stop an update.
 */

export type Verdict = 'approve' | 'caution' | 'block' | 'unavailable'
export type Confidence = 'low' | 'medium' | 'high'

/**
 * `held` is not a policy the operator writes -- it is what `dockhand.pr: on-request`
 * produces. Held updates are detected, persisted and rendered, but the PR engine never
 * touches them; only an explicit per-service action in the UI promotes one. Datastores
 * live here: a postgres major cannot be applied by bumping the tag at all (the new
 * container refuses the old datadir), so a standing merge-able PR would be a loaded gun.
 */
export type EffectiveTier = 'auto' | 'gated' | 'manual' | 'held' | 'skip'

export interface TierInput {
  magnitude: Magnitude
  /** `dockhand.policy`: auto | gated | manual | skip */
  policyLabel: string | null
  /** `dockhand.pr`: on-request */
  prLabel: string | null
  defaults: Policy['defaults']
}

/** First match wins. */
export function tierFor(i: TierInput): EffectiveTier {
  if (i.policyLabel === 'skip') return 'skip'
  if (i.prLabel === 'on-request') return 'held'
  if (i.policyLabel === 'gated') return 'gated'
  if (i.policyLabel === 'manual') return 'manual'
  // Majors always need a human, whatever the defaults say. Not configurable.
  if (i.magnitude === 'major') return 'manual'
  if (i.magnitude === 'digest') return asTier(i.defaults.digest)
  return asTier(i.defaults[i.magnitude])
}

function asTier(v: string): EffectiveTier {
  return v === 'auto' || v === 'gated' || v === 'manual' || v === 'skip' ? v : 'manual'
}

const TIER_RANK: Record<EffectiveTier, number> = {
  skip: 0,
  auto: 1,
  gated: 2,
  manual: 3,
  held: 4,
}

/**
 * A grouped PR takes the most conservative tier among its members. One held member
 * holds the whole group; one gated member gates it. `skip` members never join a group
 * in the first place (they produce no update row), so they cannot drag a group down.
 */
export function foldGroupTier(tiers: EffectiveTier[]): EffectiveTier {
  const real = tiers.filter((t) => t !== 'skip')
  if (real.length === 0) return 'skip'
  return real.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a))
}

const MAGNITUDE_RANK: Record<Magnitude, number> = { digest: 0, patch: 1, minor: 2, major: 3 }

/** A group is labelled with its largest jump -- one `major` badge, not one per member. */
export function foldGroupMagnitude(ms: Magnitude[]): Magnitude {
  if (ms.length === 0) return 'patch'
  return ms.reduce((a, b) => (MAGNITUDE_RANK[b] > MAGNITUDE_RANK[a] ? b : a))
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export interface AutoMergeInput {
  tier: EffectiveTier
  magnitude: Magnitude
  verdict: Verdict
  confidence: Confidence | null
  /** `dockhand.claude: required` -- flips this service to fail-closed. */
  claudeRequired: boolean
  claudeMode: Policy['claude']['mode']
  minConfidence: Confidence
}

export type AutoMergeDecision =
  | { merge: true }
  | { merge: false; reason: string; label?: 'claude-hold' | 'claude-block' | 'needs-analysis' }

/**
 * Whether an update may be merged without a human.
 *
 * Note the deliberate asymmetry on `unavailable`: by default an absent verdict falls
 * back to the static policy (fail-open), because the static policy is exactly what runs
 * today under WUD -- an Anthropic outage must not freeze every update in the homelab.
 * Services that would rather stall than proceed unread carry `dockhand.claude: required`.
 */
export function canAutoMerge(i: AutoMergeInput): AutoMergeDecision {
  if (i.tier !== 'auto') return { merge: false, reason: `tier is ${i.tier}` }
  if (i.magnitude === 'major') return { merge: false, reason: 'majors always need a human' }
  if (i.magnitude === 'digest') return { merge: false, reason: 'digest bumps always need a human' }

  if (i.claudeMode === 'off') return { merge: true }

  switch (i.verdict) {
    case 'block':
      return { merge: false, reason: 'Claude flagged breaking changes', label: 'claude-block' }
    case 'caution':
      return { merge: false, reason: 'Claude recommends a human read this', label: 'claude-hold' }
    case 'unavailable':
      return i.claudeRequired
        ? {
            merge: false,
            reason: 'analysis unavailable and this service is fail-closed',
            label: 'needs-analysis',
          }
        : { merge: true }
    case 'approve': {
      const conf = i.confidence ?? 'low'
      if (CONFIDENCE_RANK[conf] < CONFIDENCE_RANK[i.minConfidence]) {
        return {
          merge: false,
          reason: `Claude approved but only at ${conf} confidence`,
          label: 'claude-hold',
        }
      }
      return { merge: true }
    }
  }
}

/**
 * Whether the PR engine should open a PR for this update at all.
 *
 * Under `wud-coexist` (the setting while WUD still runs), dockhand only handles what
 * WUD's auto trigger never touches -- majors, digests, and anything not on the auto
 * tier. The two tools therefore cannot write to the same file for the same reason, by
 * construction rather than by timing. Drop this to `full` when WUD retires.
 */
export function shouldOpenPr(opts: {
  scope: 'wud-coexist' | 'full'
  tier: EffectiveTier
  magnitude: Magnitude
  /** Rolling `latest` movement has nothing to change in git. */
  rolling: boolean
}): boolean {
  if (opts.rolling) return false
  if (opts.tier === 'skip' || opts.tier === 'held') return false
  if (opts.scope === 'full') return true
  return opts.magnitude === 'major' || opts.magnitude === 'digest' || opts.tier !== 'auto'
}
