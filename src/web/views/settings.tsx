import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import { SECTIONS, SETTINGS, currentValue, type SettingDef } from '../../settings.ts'
import { Layout, Banner, type MissingSetting } from './layout.tsx'
import { PROMPTS, type PromptName } from '../../prompts/index.ts'

/**
 * The settings page.
 *
 * Two things it has to do that a list of form fields does not. First, order: the
 * sections follow the path an update actually takes, so the page reads as the pipeline
 * rather than as whatever order the fields were declared in. Second, weight: a knob that
 * changes *what dockhand may do* is not the same kind of thing as one that changes how
 * many pages a model may read, and showing them at the same size is how twenty-six
 * settings become a wall. The second kind folds away.
 *
 * Section ids are slugs of their names so /about can link straight at one.
 */

export interface PromptState {
  name: PromptName
  body: string
  customised: boolean
}

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export const SettingsPage: FC<{
  policy: Policy
  models: string[]
  prompts: PromptState[]
  result?: { ok: true; applied: string[]; commit: string | null } | { ok: false; errors: string[] }
  missing?: MissingSetting[]
}> = ({ policy, models, prompts, result, missing }) => (
  <Layout title="Settings" path="/settings" missing={missing}>
    <h2>Settings</h2>
    <p class="sub">
      These are the contents of <code>policy.yaml</code>. Saving edits that file in place
      and commits it, so every change is reviewable in <code>git log</code>.{' '}
      <a href="/settings/raw">View the file &rarr;</a>
    </p>

    <div class="rule compact">
      Sections follow the path an update takes. The model that ties them together is on{' '}
      <a href="/about">About</a> &mdash; in one line: a changelog review can withhold a
      merge and can never cause one.
    </div>

    <div id="settings-form">
      <SettingsForm policy={policy} models={models} result={result} />
    </div>

    <h2>Next digest</h2>
    <p class="sub">
      Exactly what would be sent, rendered by the code that sends it. A batched
      notification is otherwise invisible until it fires, which makes it hard to trust and
      hard to tune.
    </p>
    <div
      id="digest-preview"
      hx-get="/settings/digest"
      hx-trigger="load"
      hx-swap="innerHTML"
    >
      <p class="sub">loading&hellip;</p>
    </div>

    <h2>Prompts</h2>
    <p class="sub">
      What the models are actually told. These are the instructions behind every verdict
      and every drafted change &mdash; edit them if the judgements you are getting are not
      the judgements you want. Stored separately from <code>policy.yaml</code>, so upgrades
      keep shipping new defaults you can return to.
    </p>
    {prompts.map((p) => (
      <PromptEditorFragment state={p} />
    ))}
  </Layout>
)

export const PromptEditorFragment: FC<{ state: PromptState }> = ({ state }) => (
  <div class="prompt-editor" id={`prompt-${state.name}`}>
    <form hx-post={`/settings/prompt/${state.name}`} hx-target={`#prompt-${state.name}`} hx-swap="outerHTML">
      <div class="prompt-head">
        <strong>{PROMPTS[state.name].title}</strong>
        {state.customised ? (
          <span class="pill accent">edited</span>
        ) : (
          <span class="pill muted">default</span>
        )}
      </div>
      <p class="sub">{PROMPTS[state.name].help}</p>
      <textarea name="body" rows={16} spellcheck={false}>
        {state.body}
      </textarea>
      <div class="scanbar">
        <button type="submit" hx-disabled-elt="this">
          Save prompt
        </button>
        {state.customised && (
          <button
            type="button"
            class="linkish"
            hx-post={`/settings/prompt/${state.name}/reset`}
            hx-target={`#prompt-${state.name}`}
            hx-swap="outerHTML"
          >
            Reset to default
          </button>
        )}
        <span class="sub">Takes effect on the next call. Saving the default clears the edit.</span>
      </div>
    </form>
  </div>
)

export const SettingsForm: FC<{
  policy: Policy
  models: string[]
  result?: { ok: true; applied: string[]; commit: string | null } | { ok: false; errors: string[] }
}> = ({ policy, models, result }) => (
  <form hx-post="/settings" hx-target="#settings-form" hx-swap="innerHTML">
    {result && result.ok && result.applied.length > 0 && (
      <Banner kind="info">
        Saved {result.applied.join(', ')}
        {result.commit ? ` — committed ${result.commit}` : ''}.
      </Banner>
    )}
    {result && result.ok && result.applied.length === 0 && (
      <Banner kind="info">Nothing changed.</Banner>
    )}
    {result && !result.ok && (
      <Banner kind="error">
        {result.errors.length === 1 ? (
          result.errors[0]
        ) : (
          <ul class="errlist">
            {result.errors.map((e) => (
              <li>{e}</li>
            ))}
          </ul>
        )}
      </Banner>
    )}

    {SECTIONS.map(([name, blurb]) => {
      const all = SETTINGS.filter((s) => s.section === name)
      const primary = all.filter((s) => !s.advanced)
      const advanced = all.filter((s) => s.advanced)
      // When several fields in a section share one vocabulary -- patch, minor and
      // digest all pick a rung off the same ladder -- explain it once above them
      // rather than three times inside them. Compared by identity, so it only
      // collapses a legend that is literally the same object.
      const shared = sharedLegend(all)
      return (
        <section id={slug(name)}>
          <h2>{name}</h2>
          <p class="sub">{blurb}</p>
          {shared && (
            <p class="sub optlegend hoisted">
              {shared.options.map((o) => (
                <span class="opt">
                  <code>{o}</code> {shared.help[o]}
                </span>
              ))}
            </p>
          )}
          {primary.length > 0 && (
            <div class="settings">
              {primary.map((def) => (
                <Field
                  def={def}
                  value={currentValue(policy, def.path)}
                  models={models}
                  legend={shared ? false : true}
                />
              ))}
            </div>
          )}
          {advanced.length > 0 && (
            // Tuning, not policy: correct out of the box, and shown only on request so
            // the settings that decide what may happen are not lost among them.
            <details class="advanced">
              {/* A bordered full-width control rather than a muted line of text: it is
                  the only way to reach eight real settings, so it has to look like a
                  thing you can press. The count is part of the label, not a badge
                  beside it, because "Tuning 3" reads as a value rather than an action. */}
              <summary>
                <span class="chev" aria-hidden="true"></span>
                {/* The section heading is directly above, so naming it again here only
                    buys awkward grammar ("1 more pull requests setting"). */}
                <span class="advanced-label">
                  {advanced.length} more setting{advanced.length === 1 ? '' : 's'}
                </span>
                <span class="advanced-why">tuning &mdash; sensible by default</span>
              </summary>
              <div class="settings">
                {advanced.map((def) => (
                  <Field
                    def={def}
                    value={currentValue(policy, def.path)}
                    models={models}
                    legend={shared ? false : true}
                  />
                ))}
              </div>
            </details>
          )}
        </section>
      )
    })}

    <div class="scanbar sticky-save">
      <button type="submit" hx-disabled-elt="this">
        Save changes
      </button>
      <span class="sub">Committed to the repository as one change.</span>
    </div>
  </form>
)

/**
 * The one legend every settable field in a section shares, or null.
 *
 * Identity comparison, not deep equality: two fields that happen to describe their
 * options the same way are a coincidence, whereas two fields pointing at the same
 * constant are the same vocabulary by construction.
 */
function sharedLegend(defs: SettingDef[]): { options: string[]; help: Record<string, string> } | null {
  const withHelp = defs.filter((d) => d.optionHelp && !d.locked)
  if (withHelp.length < 2) return null
  const first = withHelp[0]!.optionHelp!
  if (!withHelp.every((d) => d.optionHelp === first)) return null
  const options = [...new Set(withHelp.flatMap((d) => d.options ?? []))].filter((o) => first[o])
  return options.length > 0 ? { options, help: first } : null
}

const Field: FC<{ def: SettingDef; value: string; models: string[]; legend?: boolean }> = ({
  def,
  value,
  models,
  legend = true,
}) => {
  const changed = !def.locked && value !== def.defaultValue
  return (
    <div class={`setting${def.locked ? ' locked' : ''}`}>
      <label for={def.path}>
        {def.label}
        {changed && (
          <span class="pill accent changed" title={`default: ${def.defaultValue}`}>
            changed
          </span>
        )}
      </label>
      <div class="control">
        {def.locked ? (
          <span class="mono locked-value">{value || '—'}</span>
        ) : (
          <Control def={def} value={value} models={models} />
        )}
      </div>
      <p class="help">
        {def.locked ? <em>{def.locked}. </em> : null}
        {def.help}
        {changed && <span class="sub"> (default: {def.defaultValue})</span>}
        {/* The gloss belongs under the control, not inside every option label: an
            option list is for choosing, and a sentence per choice does not fit in one. */}
        {legend && def.optionHelp && !def.locked && (
          <span class="optlegend">
            {(def.options ?? [])
              .filter((o) => def.optionHelp?.[o])
              .map((o) => (
                <span class={value === o ? 'opt current' : 'opt'}>
                  <code>{o}</code> {def.optionHelp![o]}
                </span>
              ))}
          </span>
        )}
      </p>
    </div>
  )
}

const Control: FC<{ def: SettingDef; value: string; models: string[] }> = ({
  def,
  value,
  models,
}) => {
  switch (def.kind) {
    case 'bool':
      return (
        <select id={def.path} name={def.path}>
          {['true', 'false'].map((o) => (
            <option value={o} selected={value === o}>
              {o === 'true' ? 'on' : 'off'}
            </option>
          ))}
        </select>
      )
    case 'enum':
      return (
        <select id={def.path} name={def.path}>
          {(def.options ?? []).map((o) => (
            <option value={o} selected={value === o}>
              {o}
              {o === def.defaultValue ? ' (default)' : ''}
            </option>
          ))}
        </select>
      )
    case 'model':
      return (
        <>
          {models.length > 0 && (
            <select
              class="model-picker"
              // Fills the text box below, which is what actually gets submitted --
              // so an id the API has not listed can still be typed in.
              oninput={`document.getElementById('${def.path}').value = this.value`}
            >
              {[...new Set([value, ...models])].map((m) => (
                <option value={m} selected={m === value}>
                  {m}
                  {m === def.defaultValue ? ' (default)' : ''}
                </option>
              ))}
            </select>
          )}
          <input id={def.path} name={def.path} value={value} class="mono" />
        </>
      )
    case 'int':
    case 'number':
      return (
        <input
          id={def.path}
          name={def.path}
          value={value}
          inputmode="decimal"
          class="mono narrow"
        />
      )
    default:
      return <input id={def.path} name={def.path} value={value} class="mono" />
  }
}

export const DigestPreview: FC<{
  rows: { at: string }[]
  message: { title: string; body: string } | null
  policy: Policy
  channels: { alert: string[]; routine: string[] }
  emailConfigured: boolean
}> = ({ rows, message, policy, channels, emailConfigured }) => (
  <>
    {/* Where things actually go, resolved rather than restated: a channel can be set to
        `all` and still be silent because it has no credentials, and that gap is exactly
        what makes people think notifications are broken. */}
    <p class="sub channels">
      <span>
        Alerts &rarr;{' '}
        {channels.alert.length ? (
          channels.alert.map((c) => <code>{c}</code>)
        ) : (
          <span class="warn-text">nowhere</span>
        )}
      </span>
      <span>
        Routine &rarr;{' '}
        {channels.routine.length ? (
          channels.routine.map((c) => <code>{c}</code>)
        ) : (
          <span class="warn-text">nowhere</span>
        )}
      </span>
      {emailConfigured ? (
        <button
          type="button"
          class="linkish"
          hx-post="/settings/email/test"
          hx-target="#email-test-status"
          hx-swap="innerHTML"
          hx-disabled-elt="this"
        >
          Send a test email
        </button>
      ) : (
        <span class="sub">
          email is off &mdash; set <code>SMTP_URL</code> and <code>MAIL_TO</code>
        </span>
      )}
      <span id="email-test-status" class="sub"></span>
    </p>

    {policy.notify.routine !== 'digest' && (
      <Banner kind="info">
        Routine outcomes are set to <code>{policy.notify.routine}</code>, so no digest is
        scheduled. {policy.notify.routine === 'immediate'
          ? 'Each one is pushed as it happens.'
          : 'They are recorded on the Activity page and pushed nowhere.'}
      </Banner>
    )}
    {message ? (
      <>
        <div class="table-wrap">
          <pre class="rawfile digest">
            {message.title}
            {'\n\n'}
            {message.body}
          </pre>
        </div>
        <div class="scanbar">
          <button
            hx-post="/settings/digest/send"
            hx-target="#digest-send-status"
            hx-swap="innerHTML"
            hx-disabled-elt="this"
          >
            Send now
          </button>
          <span id="digest-send-status" class="sub">
            {rows.length} item{rows.length === 1 ? '' : 's'} waiting since{' '}
            {rows[0]!.at.replace('T', ' ').slice(0, 16)}
          </span>
        </div>
      </>
    ) : (
      <p class="empty">
        Nothing waiting. An empty digest is never sent &mdash; a scheduled &ldquo;0
        things&rdquo; push is how a person learns to ignore the channel.
      </p>
    )}
  </>
)

export const RawPolicy: FC<{ text: string; error?: string; missing?: MissingSetting[] }> = ({ text, error, missing }) => (
  <Layout title="policy.yaml" path="/settings" missing={missing}>
    <h2>policy.yaml</h2>
    <p class="sub">
      The file as it exists on disk, comments and all. <a href="/settings">&larr; Back to settings</a>
    </p>
    {error && <Banner kind="error">{error}</Banner>}
    <div class="table-wrap">
      <pre class="rawfile">{text}</pre>
    </div>
  </Layout>
)
