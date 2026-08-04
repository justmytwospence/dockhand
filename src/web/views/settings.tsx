import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import { SECTIONS, SETTINGS, currentValue, type SettingDef } from '../../settings.ts'
import { Layout, Banner, type MissingSetting } from './layout.tsx'
import { Help } from './shell.tsx'
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

/**
 * Everything reachable from the settings screen, in one list.
 *
 * The nine policy sections come from SECTIONS; Digest and Prompts are panes too, because
 * from the operator's point of view they are just more settings -- they only differ in
 * where they are stored, which is an implementation detail.
 */
const PANES = [
  ...SECTIONS.map(([name, blurb]) => ({ id: slug(name), label: name, blurb, form: true })),
  {
    id: 'next-digest',
    label: 'Next digest',
    blurb:
      'Exactly what would be sent, rendered by the code that sends it. A batched notification is otherwise invisible until it fires, which makes it hard to trust and hard to tune.',
    form: false,
  },
  {
    id: 'prompts',
    label: 'Prompts',
    blurb:
      'What the models are actually told — the instructions behind every verdict and every drafted change. Stored separately from policy.yaml, so upgrades keep shipping new defaults you can return to.',
    form: false,
  },
] as const

/**
 * Switching panes, and keeping the URL honest.
 *
 * Bootstrap's own tab JS would work, but it does not know about the hash, and /about
 * links straight at individual sections (`/settings#reading-the-changelog`). So this
 * does both: activate on click AND on load from the hash, and write the hash back as
 * you move so the address bar always names what you are looking at.
 *
 * It also hides the Save bar on the two panes that are not part of the form -- a Save
 * button that does nothing for what is on screen is worse than no button.
 */
const PANE_SCRIPT = `(function(){
  function show(id, push){
    var pane = document.getElementById('pane-' + id);
    if (!pane) return false;
    document.querySelectorAll('.settings-pane').forEach(function(p){ p.classList.toggle('active', p === pane); });
    document.querySelectorAll('.settings-nav .nav-link').forEach(function(a){
      a.classList.toggle('active', a.dataset.pane === id);
    });
    var bar = document.querySelector('.sticky-save');
    if (bar) bar.hidden = pane.dataset.form !== '1';
    if (push) history.replaceState(null, '', '#' + id);
    return true;
  }
  document.addEventListener('click', function(e){
    var a = e.target.closest('.settings-nav .nav-link');
    if (!a) return;
    e.preventDefault();
    show(a.dataset.pane, true);
  });
  addEventListener('hashchange', function(){ show(location.hash.slice(1), false); });
  var first = document.querySelector('.settings-nav .nav-link');
  if (!show(location.hash.slice(1), false) && first) show(first.dataset.pane, false);
})()`

export const SettingsPage: FC<{
  policy: Policy
  models: string[]
  prompts: PromptState[]
  result?: { ok: true; applied: string[]; commit: string | null } | { ok: false; errors: string[] }
  missing?: MissingSetting[]
}> = ({ policy, models, prompts, result, missing }) => (
  <Layout
    title="Settings"
    path="/settings"
    missing={missing}
    actions={
      <a class="btn" href="/settings/raw">
        View policy.yaml
      </a>
    }
  >
    <div class="settings-shell">
      {/* Section list. Sticky, so the place you are in the config is always visible --
          which is the thing eleven stacked cards could never tell you. */}
      <nav class="settings-nav" aria-label="Settings sections">
        <ul class="nav nav-pills flex-column">
          {PANES.map((p) => (
            <li class="nav-item">
              <a class="nav-link" href={`#${p.id}`} data-pane={p.id}>
                {p.label}
              </a>
            </li>
          ))}
        </ul>
        <p class="sub settings-note">
          A changelog review can withhold a merge and can never cause one. The model that
          ties these together is on <a href="/about">About</a>.
        </p>
      </nav>

      <div class="settings-panes">
        <div id="settings-form">
          <SettingsForm policy={policy} models={models} result={result} />
        </div>

        <div class="settings-pane" id="pane-next-digest" data-form="0">
          <div class="pane-head">
            <h3 class="pane-title">Next digest</h3>
            <Help label="Next digest" text={PANES.find((p) => p.id === 'next-digest')!.blurb} />
          </div>
          <div id="digest-preview" hx-get="/settings/digest" hx-trigger="load" hx-swap="innerHTML">
            <p class="sub">loading&hellip;</p>
          </div>
        </div>

        <div class="settings-pane" id="pane-prompts" data-form="0">
          <div class="pane-head">
            <h3 class="pane-title">Prompts</h3>
            <Help label="Prompts" text={PANES.find((p) => p.id === 'prompts')!.blurb} />
          </div>
          {prompts.map((p) => (
            <PromptEditorFragment state={p} />
          ))}
        </div>
      </div>
    </div>
    <script dangerouslySetInnerHTML={{ __html: PANE_SCRIPT }} />
  </Layout>
)

export const PromptEditorFragment: FC<{ state: PromptState }> = ({ state }) => (
  <div class="prompt-editor card" id={`prompt-${state.name}`}>
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
      <textarea name="body" rows={16} spellcheck={false} class="form-control">
        {state.body}
      </textarea>
      <div class="scanbar">
        <button type="submit" class="btn btn-primary" hx-disabled-elt="this">
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
        // One pane per section; only the active one is displayed. `id` keeps the slug
        // /about links at, and data-form tells the pane script whether Save applies.
        <section id={`pane-${slug(name)}`} class="settings-pane" data-form="1">
          <div class="pane-head">
            <h3 class="pane-title">{name}</h3>
            <Help label={name} text={blurb} />
            {shared && (
              <Help
                label={`${name} options`}
                text={shared.options.map((o) => `${o} — ${shared.help[o]}`).join('\n')}
              />
            )}
          </div>
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
      <button type="submit" class="btn btn-primary" hx-disabled-elt="this">
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
        {/* Reference material for the enum, on demand rather than always on screen. */}
        {legend && def.optionHelp && !def.locked && (
          <Help
            label={def.label}
            text={(def.options ?? [])
              .filter((o) => def.optionHelp?.[o])
              .map((o) => `${o} — ${def.optionHelp![o]}`)
              .join('\n')}
          />
        )}
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
        <select id={def.path} name={def.path} class="form-select">
          {['true', 'false'].map((o) => (
            <option value={o} selected={value === o}>
              {o === 'true' ? 'on' : 'off'}
            </option>
          ))}
        </select>
      )
    case 'enum':
      return (
        <select id={def.path} name={def.path} class="form-select">
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
              class="form-select model-picker"
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
          <input id={def.path} name={def.path} value={value} class="form-control mono" />
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
          class="form-control mono narrow"
        />
      )
    default:
      return <input id={def.path} name={def.path} value={value} class="form-control mono" />
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
        <div class="card">
          <pre class="rawfile">
            {message.title}
            {'\n\n'}
            {message.body}
          </pre>
        </div>
        <div class="scanbar">
          <button
            class="btn"
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
      <p class="nothing">
        Nothing waiting. An empty digest is never sent &mdash; a scheduled &ldquo;0
        things&rdquo; push is how a person learns to ignore the channel.
      </p>
    )}
  </>
)

export const RawPolicy: FC<{ text: string; error?: string; missing?: MissingSetting[] }> = ({ text, error, missing }) => (
  <Layout
    title="policy.yaml"
    path="/settings"
    missing={missing}
    subtitle="The file as it exists on disk, comments and all."
    actions={
      <a class="btn" href="/settings">
        &larr; Back to settings
      </a>
    }
  >
    {error && <Banner kind="error">{error}</Banner>}
    <div class="card">
      <pre class="rawfile">{text}</pre>
    </div>
  </Layout>
)
