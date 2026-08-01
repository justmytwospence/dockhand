import type { FC } from 'hono/jsx'
import type { DiffResult } from '../../diff.ts'

const MARK: Record<string, string> = { ctx: ' ', del: '-', add: '+' }

export const DiffView: FC<{ result: DiffResult; prUrl?: string | null; prNumber?: number | null }> = ({
  result,
  prUrl,
  prNumber,
}) => {
  if ('error' in result) return <p class="diff-note">{result.error}</p>
  return (
    <>
      {result.hunks.map((h) => (
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
      {prUrl && prNumber ? (
        <p class="diff-note">
          <a href={prUrl} target="_blank" rel="noopener">
            View pull request #{prNumber} &#8599;
          </a>
        </p>
      ) : null}
    </>
  )
}
