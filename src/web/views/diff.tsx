import type { FC } from 'hono/jsx'
import type { DiffResult } from '../../diff.ts'
import type { RefLinks } from '../../links.ts'

const MARK: Record<string, string> = { ctx: ' ', del: '-', add: '+' }

export const DiffView: FC<{
  result: DiffResult
  links?: RefLinks
  prUrl?: string | null
  prNumber?: number | null
  prScope?: string | null
}> = ({ result, links, prUrl, prNumber, prScope }) => (
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
