import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import { SETTINGS, currentValue, type SettingDef } from '../../settings.ts'
import { Layout, Banner } from './layout.tsx'

export const SettingsPage: FC<{
  policy: Policy
  models: string[]
  result?: { ok: true; applied: string[]; commit: string | null } | { ok: false; errors: string[] }
}> = ({ policy, models, result }) => (
  <Layout title="Settings" path="/settings">
    <h2>Settings</h2>
    <p class="sub">
      These are the contents of <code>dockhand/config/policy.yaml</code>. Saving edits that
      file in place and commits it, so every change is reviewable in{' '}
      <code>git log</code>. <a href="/settings/raw">View the file &rarr;</a>
    </p>
    <div id="settings-form">
      <SettingsForm policy={policy} models={models} result={result} />
    </div>
  </Layout>
)

export const SettingsForm: FC<{
  policy: Policy
  models: string[]
  result?: { ok: true; applied: string[]; commit: string | null } | { ok: false; errors: string[] }
}> = ({ policy, models, result }) => {
  const sections = [...new Set(SETTINGS.map((s) => s.section))]
  return (
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

      {sections.map((section) => (
        <>
          <h2>{section}</h2>
          <div class="settings">
            {SETTINGS.filter((s) => s.section === section).map((def) => (
              <Field def={def} value={currentValue(policy, def.path)} models={models} />
            ))}
          </div>
        </>
      ))}

      <div class="scanbar">
        <button type="submit" hx-disabled-elt="this">
          Save changes
        </button>
        <span class="sub">Committed to the repository as one change.</span>
      </div>
    </form>
  )
}

const Field: FC<{ def: SettingDef; value: string; models: string[] }> = ({
  def,
  value,
  models,
}) => (
  <div class={`setting${def.locked ? ' locked' : ''}`}>
    <label for={def.path}>{def.label}</label>
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
      {!def.locked && value !== def.defaultValue && (
        <span class="sub"> (default: {def.defaultValue})</span>
      )}
    </p>
  </div>
)

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

export const RawPolicy: FC<{ text: string; error?: string }> = ({ text, error }) => (
  <Layout title="policy.yaml" path="/settings">
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
