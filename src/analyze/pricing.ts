import type Anthropic from '@anthropic-ai/sdk'

/**
 * Per-million-token pricing by model family, for the spend ledger only.
 *
 * Matched by prefix so a new dated release of a known family is priced correctly the
 * day it ships. An unrecognised model bills at the most expensive known rate: a budget
 * that under-counts silently overspends, which is the failure that actually costs
 * money.
 *
 * Verified against the published rates rather than recalled. An earlier version of this
 * table guessed $15/$75 for Opus and over-reported spend by 3x -- a wrong number here
 * is worse than no number, because it is believed.
 */
const PRICING: { prefix: string; in: number; out: number }[] = [
  { prefix: 'claude-fable-', in: 10, out: 50 },
  { prefix: 'claude-mythos-', in: 10, out: 50 },
  { prefix: 'claude-opus-', in: 5, out: 25 },
  { prefix: 'claude-sonnet-', in: 3, out: 15 },
  { prefix: 'claude-haiku-', in: 1, out: 5 },
]
/** Web search is billed per request, independent of tokens. */
const PRICE_SEARCH = 10 / 1000
/** Cache writes cost a premium; reads are the whole point -- about a tenth of input. */
const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_MULTIPLIER = 0.1

let warnedUnknownModel = ''

/** Set by the caller so this module needs no logger of its own. */
let onUnknownModel: ((model: string) => void) | undefined
export function reportUnknownModels(fn: (model: string) => void): void {
  onUnknownModel = fn
}

function priceFor(model: string): { in: number; out: number } {
  const hit = PRICING.find((p) => model.startsWith(p.prefix))
  if (hit) return hit
  if (warnedUnknownModel !== model) {
    warnedUnknownModel = model
    onUnknownModel?.(model)
  }
  return PRICING[0]!
}

export interface CallCost {
  cost: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  searches: number
}

/**
 * What one call cost, itemised.
 *
 * Cache tokens are billed separately from `input_tokens` and are NOT included in it --
 * ignoring them under-counts every cached call, which is exactly the call you make most
 * often.
 */
export function costOf(usage: Anthropic.Usage, model: string): CallCost {
  const price = priceFor(model)
  const searches =
    (usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use
      ?.web_search_requests ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cost =
    (usage.input_tokens / 1e6) * price.in +
    (cacheWrite / 1e6) * price.in * CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1e6) * price.in * CACHE_READ_MULTIPLIER +
    (usage.output_tokens / 1e6) * price.out +
    searches * PRICE_SEARCH
  return {
    cost,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheWrite,
    cacheRead,
    searches,
  }
}

