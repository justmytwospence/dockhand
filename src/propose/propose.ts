import Anthropic from '@anthropic-ai/sdk'
import { env, loadPolicy } from '../config.ts'
import { recordCost } from '../analyze/claude.ts'
import { webTools } from '../analyze/tools.ts'
import { prompt } from '../prompts/index.ts'
import type { Op } from './apply.ts'
import { renderContext, type DeployContext } from './context.ts'

/**
 * Drafting the configuration changes an update needs beyond its tag.
 *
 * Some upstreams rename their image, rename environment variables, or change a default
 * that only matters given how you have things configured. A tag-only pull request
 * cannot express any of that, so it merges and the service breaks.
 *
 * The model does not write YAML. It selects operations from a fixed vocabulary, which
 * apply.ts then applies deterministically -- a model-authored diff mis-applies quietly,
 * an unknown operation is refused loudly.
 *
 * SECURITY: like the analyzer, this reads untrusted release notes. The containment is
 * structural rather than textual: a proposal can only ever ADD a reviewable commit to a
 * pull request, which marks that request as needing a human and disqualifies it from
 * auto-merge forever. Nothing it emits can cause a merge or reach a running container
 * on its own.
 */

export interface Proposal {
  ops: Op[]
  /** Required steps that are not compose changes. */
  notes: string[]
  summary: string
  sources: string[]
}

const PROPOSE_CHANGES = {
  name: 'propose_changes',
  description:
    'Record the compose changes this update requires, plus anything the operator must do by hand.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ops: {
        type: 'array',
        description:
          'Compose changes to apply to this service. Empty when the update needs no config change.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['set_image', 'set_env', 'remove_env', 'rename_env', 'set_label', 'remove_label'],
            },
            image: { type: 'string', description: 'set_image: the full new image reference.' },
            key: { type: 'string', description: 'The environment variable or label name.' },
            value: {
              type: 'string',
              description:
                'Raw YAML scalar text. Quote it yourself if it needs quoting. Never invent a secret.',
            },
            from: { type: 'string', description: 'rename_env: the current name.' },
            to: { type: 'string', description: 'rename_env: the new name.' },
          },
          required: ['op'],
        },
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Steps the operator must perform that are NOT compose changes: data migrations, volume permissions, values only they can supply, anything outside this vocabulary.',
      },
      summary: { type: 'string', description: 'One short paragraph on what these changes do.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'URLs relied on.' },
    },
    required: ['ops', 'notes', 'summary', 'sources'],
  },
}


export interface ProposeInput {
  image: string
  fromTag: string
  toTag: string
  service: string
  /** The service's block as it stands on the pull request branch, tag already bumped. */
  composeBlock: string
  sourceRepo: string | null
  verdict: { summary: string; breaking_changes: string[]; migration_steps: string[] }
  /** Facts about the running deployment the compose file cannot state. */
  context: DeployContext
}

export async function propose(input: ProposeInput): Promise<Proposal | { error: string }> {
  const { policy } = loadPolicy()
  if (!env.anthropicApiKey) return { error: 'ANTHROPIC_API_KEY is not set' }

  const client = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 })
  const allowed = ['github.com', 'docs.linuxserver.io', 'api.linuxserver.io']

  try {
    const res = await client.messages.create(
      {
        model: policy.claude.code_model,
        max_tokens: 8192,
        system: [{ type: 'text', text: prompt('proposal'), cache_control: { type: 'ephemeral' } }],
        tools: [
          ...webTools(policy.claude.code_model, policy.claude.web, allowed),
          PROPOSE_CHANGES,
        ],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: renderPrompt(input) }],
      },
      { timeout: 300_000 },
    )

    const call = res.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === 'propose_changes',
    )
    recordCost(res.usage, policy, policy.claude.code_model, 'proposal')
    if (!call) return { error: 'the model did not return a proposal' }

    return normalise(call.input as Record<string, unknown>)
  } catch (err) {
    return { error: (err as Error).message.slice(0, 300) }
  }
}

function renderPrompt(i: ProposeInput): string {
  return [
    `Service: ${i.service}`,
    `Image: ${i.image}`,
    `Updating: ${i.fromTag} -> ${i.toTag}`,
    i.sourceRepo ? `Upstream: https://github.com/${i.sourceRepo}` : 'Upstream: unknown',
    '',
    'A changelog review of this update concluded:',
    i.verdict.summary,
    i.verdict.breaking_changes.length
      ? `\nBreaking changes identified:\n${i.verdict.breaking_changes.map((b) => `- ${b}`).join('\n')}`
      : '',
    i.verdict.migration_steps.length
      ? `\nSteps it listed:\n${i.verdict.migration_steps.map((s) => `- ${s}`).join('\n')}`
      : '',
    '',
    'The service as it stands on the update branch (the image tag is already bumped):',
    '```yaml',
    i.composeBlock,
    '```',
    '',
    renderContext(i.context),
    '',
    'Read the upstream migration documentation before deciding. Then call',
    'propose_changes with the operations this specific configuration requires, and notes',
    'for everything else.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Keep only well-formed operations; a malformed one becomes nothing rather than a guess. */
function normalise(raw: Record<string, unknown>): Proposal {
  const ops: Op[] = []
  for (const item of Array.isArray(raw.ops) ? raw.ops : []) {
    const o = item as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key : ''
    const value = typeof o.value === 'string' ? o.value : ''
    switch (o.op) {
      case 'set_image':
        if (typeof o.image === 'string' && o.image) ops.push({ op: 'set_image', image: o.image })
        break
      case 'set_env':
        if (key && value) ops.push({ op: 'set_env', key, value })
        break
      case 'remove_env':
        if (key) ops.push({ op: 'remove_env', key })
        break
      case 'rename_env':
        if (typeof o.from === 'string' && typeof o.to === 'string' && o.from && o.to) {
          ops.push({ op: 'rename_env', from: o.from, to: o.to })
        }
        break
      case 'set_label':
        if (key && value) ops.push({ op: 'set_label', key, value })
        break
      case 'remove_label':
        if (key) ops.push({ op: 'remove_label', key })
        break
    }
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  return {
    ops,
    notes: strings(raw.notes),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    sources: strings(raw.sources),
  }
}
