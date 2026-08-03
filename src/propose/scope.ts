/**
 * How far a drafted proposal may reach, per service.
 *
 * The reachable rungs, narrowest first:
 *
 * | scope          | may change                                    |
 * |----------------|-----------------------------------------------|
 * | `none`         | nothing — no proposal is drafted at all       |
 * | `service`      | this service's block in its own compose file  |
 * | `compose-file` | any service in that same compose file         |
 *
 * `service` is the default and is what the engine did before this setting existed.
 *
 * `compose-file` exists because sidecars are real: a service that talks to a socket
 * proxy, a VPN container its network rides through, an init container sharing its
 * volume. The first live proposal ran into exactly this and said so — "arcane-docker-proxy
 * is a separate service I cannot edit, verify it permits the Docker API calls v2 needs" —
 * which is a correct refusal and also a note about work the operator now has to do by
 * hand.
 *
 * ## Why the ladder stops here
 *
 * Wider scopes — the stack's directory, or the whole repository — are deliberately not
 * offered, because they are not a permission problem. Every op in the vocabulary is
 * anchored to `services.<name>` in a compose document, and its safety comes from that
 * narrowness: an op either matches the document or is refused by name, and the result
 * is checked by applying the same ops to the parsed object independently and comparing.
 * Editing `configuration.yml` or a Traefik dynamic file needs a vocabulary that can
 * address arbitrary YAML, and the verification that makes this trustworthy does not
 * survive the generalisation.
 *
 * The mechanism that already covers those cases is notes. Anything outside the
 * vocabulary comes back as a required manual step and reaches a human, which is the
 * outcome a wider scope would be trying to produce anyway — minus the model writing to
 * a file nothing can check it against.
 */

export type ProposeScope = 'none' | 'service' | 'compose-file'

export const SCOPES: ProposeScope[] = ['none', 'service', 'compose-file']

/**
 * Read `dockhand.propose`. Unset means `service`.
 *
 * `off` is accepted as the original spelling of `none`, and an unrecognised value
 * narrows to `service` rather than widening — a typo must never grant reach.
 */
export function scopeFor(label: string | null | undefined): ProposeScope {
  if (!label) return 'service'
  const v = label.trim().toLowerCase()
  if (v === 'off' || v === 'none') return 'none'
  if (v === 'compose-file' || v === 'file') return 'compose-file'
  return 'service'
}

/**
 * Which services a proposal may change, given its scope.
 *
 * `siblings` is every service defined in the same compose file, primary included.
 */
export function allowedServices(
  scope: ProposeScope,
  primary: string,
  siblings: string[],
): string[] {
  if (scope === 'none') return []
  if (scope === 'compose-file') {
    return siblings.includes(primary) ? siblings : [primary, ...siblings]
  }
  return [primary]
}

/** What the model is told it may touch. Kept in step with what apply.ts enforces. */
export function describeScope(scope: ProposeScope, primary: string, allowed: string[]): string {
  if (scope === 'none') return 'You may not change anything.'
  if (scope === 'compose-file' && allowed.length > 1) {
    return [
      `You may change any of these services in this compose file: ${allowed.join(', ')}.`,
      `Name the service on each operation; operations without one apply to ${primary}.`,
      'Change a service other than the one being updated only when the upstream',
      'documentation says this update requires it — a sidecar whose configuration must',
      'move in step, for example. Everything else stays a note.',
    ].join('\n')
  }
  return `You may change only the "${primary}" service. Anything else is a note.`
}
