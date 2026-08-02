import type { FC } from 'hono/jsx'
import type { DiffResult, DiffHunk } from '../../diff.ts'
import type { RefLinks } from '../../links.ts'

const MARK: Record<string, string> = { ctx: ' ', del: '-', add: '+' }

export interface ProposalSummary {
  summary: string
  notes: string[]
  changed: string[]
  error: string | null
  model: string
  /** The proposal's own diff, captured when it was applied. */
  hunks: DiffHunk[]
}

export const DiffView: FC<{
  result: DiffResult
  links?: RefLinks
  prUrl?: string | null
  prNumber?: number | null
  prScope?: string | null
  proposal?: ProposalSummary
  canPropose?: boolean
}> = ({ result, links, prUrl, prNumber, prScope, proposal, canPropose }) => (
  <>
    {'error' in result ? (
      <p class="diff-note">{result.error}</p>
    ) : (
      result.hunks.map((h) => (
        <div class="diff">
          <div class="diff-head">
            <span class="diff-file">{h.file}</span>
            <span class="diff-hunk">{h.header}</span>
          </div>
          {h.lines.map((l) => (
            <div class={`dl ${l.kind}`}>
              <span class="ln">{l.no ?? ''}</span>
              <span class="mark">{MARK[l.kind]}</span>
              <span class="txt">{l.text}</span>
            </div>
          ))}
        </div>
      ))
    )}

    {proposal ? (
      <div class={`proposal${proposal.error ? ' failed' : ''}`}>
        <strong>
          {proposal.error
            ? 'Config changes drafted but not applied'
            : proposal.changed.length > 0
              ? 'Config changes drafted'
              : 'No config change needed'}
        </strong>
        {proposal.error ? <p class="diff-note warn-text">{proposal.error}</p> : null}
        <p class="diff-note">{proposal.summary}</p>
        {proposal.changed.length > 0 && (
          <ul class="oplist">
            {proposal.changed.map((c) => (
              <li>{c}</li>
            ))}
          </ul>
        )}
        {/* The change itself, not just a description of it. */}
        {proposal.hunks.map((h) => (
          <div class="diff">
            <div class="diff-head">
              <span class="diff-file">{h.file}</span>
              <span class="diff-hunk">{h.header}</span>
            </div>
            {h.lines.map((l) => (
              <div class={`dl ${l.kind}`}>
                <span class="ln">{l.no ?? ''}</span>
                <span class="mark">{MARK[l.kind]}</span>
                <span class="txt">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
        {proposal.notes.length > 0 && (
          <>
            <strong>Manual steps</strong>
            <ul class="oplist notes">
              {proposal.notes.map((n) => (
                <li>{n}</li>
              ))}
            </ul>
          </>
        )}
        <p class="diff-note">
          Drafted by <code>{proposal.model}</code>. Nothing has verified these; read the
          commit before merging.
        </p>
      </div>
    ) : canPropose && prNumber ? (
      <p class="diff-note">
        <button
          class="linkish"
          hx-post={`/prs/${prNumber}/propose`}
          hx-swap="outerHTML"
          hx-disabled-elt="this"
        >
          Draft config changes for this update
        </button>
      </p>
    ) : null}

    {prScope === 'modified' && prUrl ? (
      <p class="diff-note warn-text">
        This branch has been edited since dockhand wrote it &mdash; the preview above is
        no longer the whole change.{' '}
        <a class="ext" href={`${prUrl}/files`} target="_blank" rel="noopener">
          See the pull request&rsquo;s own diff &#8599;
        </a>
      </p>
    ) : null}

    {/* Everything you might want to check before merging, one click away. */}
    <p class="diff-links">
      {links?.image && (
        <a class="ext" href={links.image} target="_blank" rel="noopener">
          image &#8599;
        </a>
      )}
      {links?.tag && (
        <a class="ext" href={links.tag} target="_blank" rel="noopener">
          new tag &#8599;
        </a>
      )}
      {links?.releases && (
        <a class="ext" href={links.releases} target="_blank" rel="noopener">
          releases &#8599;
        </a>
      )}
      {prUrl && prNumber ? (
        <a class="ext" href={prUrl} target="_blank" rel="noopener">
          pull request #{prNumber} &#8599;
        </a>
      ) : null}
    </p>
  </>
)
