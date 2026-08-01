import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tierFor,
  foldGroupTier,
  foldGroupMagnitude,
  canAutoMerge,
  shouldOpenPr,
  type EffectiveTier,
} from '../src/policy.ts'
import type { Magnitude } from '../src/versions/patterns.ts'

const DEFAULTS = {
  patch: 'auto',
  minor: 'auto',
  major: 'manual',
  digest: 'manual',
  soak: '0h',
} as const

const t = (
  magnitude: Magnitude,
  policyLabel: string | null = null,
  prLabel: string | null = null,
): EffectiveTier => tierFor({ magnitude, policyLabel, prLabel, defaults: { ...DEFAULTS } })

test('tierFor: label precedence, first match wins', () => {
  // skip beats everything
  assert.equal(t('patch', 'skip', 'on-request'), 'skip')
  // on-request beats the remaining labels -- this is what makes datastores dashboard-only
  assert.equal(t('patch', 'gated', 'on-request'), 'held')
  assert.equal(t('major', 'manual', 'on-request'), 'held')
  assert.equal(t('patch', 'gated'), 'gated')
  assert.equal(t('patch', 'manual'), 'manual')
})

test('tierFor: majors are always manual regardless of defaults', () => {
  assert.equal(t('major'), 'manual')
  // even if someone writes major: auto in policy.yaml
  assert.equal(
    tierFor({
      magnitude: 'major',
      policyLabel: null,
      prLabel: null,
      defaults: { ...DEFAULTS, major: 'auto' },
    }),
    'manual',
  )
})

test('tierFor: patch and minor follow the defaults; digest has its own default', () => {
  assert.equal(t('patch'), 'auto')
  assert.equal(t('minor'), 'auto')
  assert.equal(t('digest'), 'manual')
  assert.equal(
    tierFor({
      magnitude: 'minor',
      policyLabel: null,
      prLabel: null,
      defaults: { ...DEFAULTS, minor: 'gated' },
    }),
    'gated',
  )
})

test('foldGroupTier: the most conservative member wins', () => {
  assert.equal(foldGroupTier(['auto', 'auto']), 'auto')
  assert.equal(foldGroupTier(['auto', 'gated']), 'gated')
  assert.equal(foldGroupTier(['auto', 'manual']), 'manual')
  // one held member holds the whole group
  assert.equal(foldGroupTier(['auto', 'held']), 'held')
  assert.equal(foldGroupTier(['manual', 'held', 'auto']), 'held')
  // skip members never drag a group down -- they produce no update row at all
  assert.equal(foldGroupTier(['skip', 'auto']), 'auto')
  assert.equal(foldGroupTier(['skip']), 'skip')
})

test('foldGroupMagnitude: a group is labelled with its largest jump', () => {
  assert.equal(foldGroupMagnitude(['patch', 'major']), 'major')
  assert.equal(foldGroupMagnitude(['patch', 'minor']), 'minor')
  assert.equal(foldGroupMagnitude(['digest', 'patch']), 'patch')
})

const merge = (over: Partial<Parameters<typeof canAutoMerge>[0]> = {}) =>
  canAutoMerge({
    tier: 'auto',
    magnitude: 'patch',
    verdict: 'approve',
    confidence: 'high',
    claudeRequired: false,
    claudeMode: 'advisory',
    minConfidence: 'medium',
    ...over,
  })

test('canAutoMerge: only the auto tier, only patch/minor', () => {
  assert.equal(merge().merge, true)
  assert.equal(merge({ magnitude: 'minor' }).merge, true)
  for (const tier of ['gated', 'manual', 'held', 'skip'] as const) {
    assert.equal(merge({ tier }).merge, false, tier)
  }
  assert.equal(merge({ magnitude: 'major' }).merge, false)
  assert.equal(merge({ magnitude: 'digest' }).merge, false)
})

test('canAutoMerge: Claude can demote but never promote', () => {
  // demote
  assert.equal(merge({ verdict: 'block' }).merge, false)
  assert.equal(merge({ verdict: 'caution' }).merge, false)
  assert.equal(merge({ verdict: 'approve', confidence: 'low' }).merge, false)
  // and cannot promote: a confident approval does NOT rescue a major or a gated service
  assert.equal(merge({ magnitude: 'major', verdict: 'approve', confidence: 'high' }).merge, false)
  assert.equal(merge({ tier: 'gated', verdict: 'approve', confidence: 'high' }).merge, false)
})

test('canAutoMerge: labels identify why a merge was withheld', () => {
  assert.equal(merge({ verdict: 'block' }).merge === false && merge({ verdict: 'block' }).label, 'claude-block')
  const caution = merge({ verdict: 'caution' })
  assert.equal(caution.merge === false && caution.label, 'claude-hold')
})

test('canAutoMerge: absent analysis fails OPEN by default, CLOSED when required', () => {
  // The static policy is what runs today under WUD; an API outage must not freeze the
  // whole homelab.
  assert.equal(merge({ verdict: 'unavailable' }).merge, true)
  // ...unless the service opted into fail-closed.
  const required = merge({ verdict: 'unavailable', claudeRequired: true })
  assert.equal(required.merge, false)
  assert.equal(required.merge === false && required.label, 'needs-analysis')
})

test('canAutoMerge: claude off skips the damper entirely', () => {
  assert.equal(merge({ claudeMode: 'off', verdict: 'unavailable' }).merge, true)
  // but the hard rules still bind
  assert.equal(merge({ claudeMode: 'off', magnitude: 'major' }).merge, false)
})

test('canAutoMerge: confidence threshold is inclusive', () => {
  assert.equal(merge({ confidence: 'medium', minConfidence: 'medium' }).merge, true)
  assert.equal(merge({ confidence: 'low', minConfidence: 'medium' }).merge, false)
  assert.equal(merge({ confidence: 'medium', minConfidence: 'high' }).merge, false)
})

test('shouldOpenPr: wud-coexist covers exactly what WUD auto never touches', () => {
  const s = (over: Partial<Parameters<typeof shouldOpenPr>[0]>) =>
    shouldOpenPr({ scope: 'wud-coexist', tier: 'auto', magnitude: 'patch', rolling: false, ...over })

  // WUD owns auto-tier patches and minors during coexistence
  assert.equal(s({}), false)
  assert.equal(s({ magnitude: 'minor' }), false)
  // dockhand owns everything WUD's auto trigger skips
  assert.equal(s({ magnitude: 'major' }), true)
  assert.equal(s({ magnitude: 'digest' }), true)
  assert.equal(s({ tier: 'gated' }), true)
  assert.equal(s({ tier: 'manual' }), true)
  // held is dashboard-only until the operator clicks through
  assert.equal(s({ tier: 'held', magnitude: 'major' }), false)
  assert.equal(s({ tier: 'skip' }), false)
  // a rolling latest has nothing to change in git
  assert.equal(s({ rolling: true, magnitude: 'major' }), false)
})

test('shouldOpenPr: full scope takes over the auto tier too', () => {
  assert.equal(
    shouldOpenPr({ scope: 'full', tier: 'auto', magnitude: 'patch', rolling: false }),
    true,
  )
  // held and rolling stay excluded even at full scope
  assert.equal(
    shouldOpenPr({ scope: 'full', tier: 'held', magnitude: 'major', rolling: false }),
    false,
  )
  assert.equal(
    shouldOpenPr({ scope: 'full', tier: 'auto', magnitude: 'patch', rolling: true }),
    false,
  )
})
