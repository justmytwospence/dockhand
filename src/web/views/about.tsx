import type { FC } from 'hono/jsx'
import type { Policy } from '../../config.ts'
import { Layout, Table, type MissingSetting } from './layout.tsx'

/**
 * The mental model, on one page.
 *
 * Everything here is a claim about how the tool behaves, and every claim names the
 * setting or label that governs it, so the page doubles as the index to Settings. It is
 * deliberately short: a page nobody finishes teaches nothing. The long-form reasoning
 * lives in the source comments, which is the right place for it.
 *
 * The live policy is passed in so the page says what *this* deployment does rather than
 * what the defaults do -- a mental model that disagrees with the running config is worse
 * than none.
 */

export const AboutPage: FC<{ policy: Policy; repo: string; missing?: MissingSetting[] }> = ({
  policy,
  repo,
  missing,
}) => (
  <Layout title="About" path="/about" missing={missing}>
    <h2>What dockhand does</h2>
    <p class="sub">
      It reads the compose files in <code>{repo || 'your repo'}</code>, asks the registries
      what newer image tags exist, and turns each one into a pull request that bumps the{' '}
      <code>image:</code> line. A model finds and reads the release notes and writes its
      judgement into that pull request. What policy allows, it merges; what merges, it
      deploys with a real <code>docker compose up -d</code>.
    </p>

    <div class="rule">
      <strong>The one rule everything else hangs off.</strong> The model is a
      one-directional damper: its verdict can <em>withhold</em> a merge and can never{' '}
      <em>cause</em> one. Release notes are untrusted text from the internet, so the worst
      a hostile changelog can achieve is a stopped update.
    </div>

    <h2>The journey of one update</h2>
    <p class="sub">
      Each step names the settings that govern it. Nothing skips a step; a step can only
      decide to stop.
    </p>
    <ol class="flow">
      <li>
        <b>Found.</b> A nightly scan compares every watched image against its registry.
        <span class="knob">
          <code>dockhand.watch</code>, <code>dockhand.pattern</code>,{' '}
          <a href="/settings#finding-updates">Finding updates</a>
        </span>
      </li>
      <li>
        <b>Placed on the ladder.</b> How large the jump is, plus any per-service label,
        decides how much may happen without you.
        <span class="knob">
          <code>dockhand.policy</code>,{' '}
          <a href="/settings#what-may-happen-without-you">What may happen without you</a>
        </span>
      </li>
      <li>
        <b>Opened.</b> A branch off the true tip of <code>main</code>, one commit, nothing
        but the image line. Companions that must move together share one pull request.
        <span class="knob">
          <code>dockhand.group</code>, <a href="/settings#pull-requests">Pull requests</a>
        </span>
      </li>
      <li>
        <b>Read.</b> The model resolves the upstream project, reads what it released, and
        writes a verdict into the pull request body: approve, caution, or block.
        <span class="knob">
          <code>dockhand.source</code>,{' '}
          <a href="/settings#reading-the-changelog">Reading the changelog</a>
        </span>
      </li>
      <li>
        <b>Drafted, if the tag is not enough.</b> When the verdict reports breakage, a
        second commit can carry the config changes it needs. That pull request then always
        waits for a person.
        <span class="knob">
          <code>dockhand.propose</code>,{' '}
          <a href="/settings#drafting-config-changes">Drafting config changes</a>
        </span>
      </li>
      <li>
        <b>Merged.</b> By you, or — for tag-only pull requests on the auto rung with a
        clean verdict — by dockhand.
        <span class="knob">
          <a href="/settings#merging">Merging</a>
        </span>
      </li>
      <li>
        <b>Deployed.</b> The checkout fast-forwards and the stack comes up, then is
        watched until it is healthy.
        <span class="knob">
          <code>dockhand.deploy</code>, <a href="/settings#deploying">Deploying</a>
        </span>
      </li>
    </ol>

    <h2>The ladder</h2>
    <p class="sub">
      One axis, four rungs: how much happens without you. Set the default per magnitude
      under <a href="/settings#what-may-happen-without-you">Settings</a>, and override it
      for one service with a <code>dockhand.policy</code> label. A label always wins.
    </p>
    <Table>
      <thead>
        <tr>
          <th>Rung</th>
          <th>What happens</th>
          <th>Reach for it when</th>
        </tr>
      </thead>
      <tbody>
        <Rung
          name="auto"
          cls="ok"
          what="A pull request opens and dockhand merges it, unless the changelog review objects."
          when="the service is disposable and its upstream is well behaved"
        />
        <Rung
          name="manual"
          cls="muted"
          what="A pull request opens. You merge it."
          when="a bad version would cost you an evening — infrastructure, anything load-bearing"
        />
        <Rung
          name="on-request"
          cls="warn"
          what="Nothing opens. The update is listed on the dashboard until you press Open PR."
          when="applying it is a migration, not a bump — every datastore lives here"
        />
        <Rung
          name="skip"
          cls="muted"
          what="Not tracked at all. No row, no pull request, no notification."
          when="you have deliberately pinned it and do not want to be told again"
        />
      </tbody>
    </Table>
    <p class="sub">
      <code>gated</code> is still accepted and means <code>manual</code>. It used to be a
      fifth rung that behaved identically to <code>manual</code> in every decision, which
      is a choice with no consequence — so it became a spelling instead.
    </p>

    <h2>What is never automatic</h2>
    <p class="sub">These are not settings. No configuration reaches them.</p>
    <ul class="never">
      <li>
        <b>Major versions.</b> Always a pull request a person merges, whatever the
        defaults say.
      </li>
      <li>
        <b>Digest moves.</b> The same tag, rebuilt. There is no changelog to read, so
        there is nothing to judge.
      </li>
      <li>
        <b>Any pull request carrying more than an image line</b> — drafted by dockhand or
        edited by you. Nothing has reviewed those changes.
      </li>
      <li>
        <b>A branch you have pushed to.</b> It becomes yours; dockhand comments instead of
        force-pushing.
      </li>
      <li>
        <b>dockhand's own stack, and its own policy file.</b> A limit that can be
        configured away is not a limit.
      </li>
    </ul>

    <h2>The one bounded exception</h2>
    <p class="sub">
      A service labelled <code>dockhand.policy: model</code> asks the review to decide
      whether an update is routine, instead of deciding it by version magnitude. It is the
      only place a model can raise a rung rather than only lower one, so promotion needs
      every one of: the image resolves to a real upstream; <em>every URL the verdict cited
      lives under that repository</em>; the verdict is <code>approve</code> at{' '}
      <code>high</code> confidence; and it reported no breaking changes and no migration
      steps. Any failure falls back to a human. Nothing here reads the prose of a
      changelog — every guard is a structural fact — so a release note claiming to be
      routine has no path to the outcome. Currently{' '}
      <strong>{policy.model_tier.mode}</strong>; the track record is on{' '}
      <a href="/system">System</a>.
    </p>

    <h2>Where configuration lives</h2>
    <Table>
      <thead>
        <tr>
          <th>Layer</th>
          <th>Holds</th>
          <th>Takes effect</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="mono nowrap">environment</td>
          <td>
            Which repository, where it is on disk, and the credentials. Things that
            identify this deployment.
          </td>
          <td class="sub">on restart</td>
        </tr>
        <tr>
          <td class="mono nowrap">policy.yaml</td>
          <td>
            Every semantic decision, declared once. Tracked, reviewable, and editable from{' '}
            <a href="/settings">Settings</a> — which writes the file in place and commits
            it.
          </td>
          <td class="sub">immediately</td>
        </tr>
        <tr>
          <td class="mono nowrap">dockhand.* labels</td>
          <td>
            Per-service data and exceptions, so they travel with the thing they describe.
            Read from the compose <em>files</em>, never from running containers.
          </td>
          <td class="sub">next scan — nothing recreated</td>
        </tr>
        <tr>
          <td class="mono nowrap">prompts</td>
          <td>
            What the models are actually told. Stored separately so upgrades keep shipping
            new defaults you can return to.
          </td>
          <td class="sub">next call</td>
        </tr>
      </tbody>
    </Table>
    <p class="sub">
      The split between the middle two is the whole point: policy stated once centrally,
      data stated where it belongs. This repository once restated a six-clause trigger
      string on 94 services, and a deliberate carve-out was silently reverted in a
      refactor because nobody could see the policy in one place.
    </p>

    <h2>Labels</h2>
    <p class="sub">
      On the service, in its compose file. Only <code>dockhand.watch</code> is required.
    </p>
    <Table>
      <thead>
        <tr>
          <th>Label</th>
          <th>Values</th>
          <th>What it does</th>
        </tr>
      </thead>
      <tbody>
        <Label name="dockhand.watch" values='"true"' what="Opt this service in. Nothing else is watched." />
        <Label
          name="dockhand.pattern"
          values="semver, v-semver, semver-minor, semver-quad, major-only, semver-variant, lsio-ls, date, digest, latest, regex…"
          what="The shape of this image's tags, so a comparison is possible at all. Inferred from the pinned tag when absent."
        />
        <Label
          name="dockhand.tag.include"
          values="a regex"
          what="Narrow the candidates — hold a major, or keep to one flavour. A newer release it suppresses is shown as constrained rather than hidden."
        />
        <Label
          name="dockhand.policy"
          values="auto | manual | on-request | skip | model"
          what="This service's rung, overriding the magnitude defaults."
        />
        <Label
          name="dockhand.pr"
          values="on-request"
          what="The original spelling of the on-request rung. Still honoured; dockhand.policy now expresses the whole ladder in one label."
        />
        <Label
          name="dockhand.source"
          values="a GitHub URL"
          what="Where the release notes actually live, for the ~half of images whose OCI annotation is missing or points at a packaging repo."
        />
        <Label
          name="dockhand.claude"
          values="required"
          what="Fail closed: refuse to auto-merge this service without a verdict, rather than falling back to static policy."
        />
        <Label
          name="dockhand.propose"
          values="none | service | compose-file | compose-dir | repo"
          what="How far a drafted config change may reach, derived from where the compose file sits. Defaults to this service's own block."
        />
        <Label
          name="dockhand.group"
          values="a name"
          what="Force services into one pull request when the shared-upstream heuristic misses them."
        />
        <Label
          name="dockhand.deploy"
          values="rm-first"
          what="Remove and recreate rather than update, so environment baked into the old image cannot survive the bump."
        />
      </tbody>
    </Table>

    <h2>Three git locations</h2>
    <Table kv>
      <tbody>
        <tr>
          <th>the live checkout</th>
          <td>
            The only place deploys run. Touched solely to fetch, fast-forward and bring
            services up — dockhand stands down entirely whenever it is off{' '}
            <code>main</code> or mid-operation, so it never fights you for the working
            tree.
          </td>
        </tr>
        <tr>
          <th>dockhand's own clone</th>
          <td>
            All branch, edit, commit and push work happens here, which is why your
            uncommitted work is irrelevant to it.
          </td>
        </tr>
        <tr>
          <th>GitHub</th>
          <td>
            Where pull requests live and merge. <code>main</code> is published as part of
            the loop — a branch cut from a stale origin silently reverts unpushed local
            commits when it merges, so publishing is a precondition, not a preference.
          </td>
        </tr>
      </tbody>
    </Table>
  </Layout>
)

const Rung: FC<{ name: string; cls: string; what: string; when: string }> = ({
  name,
  cls,
  what,
  when,
}) => (
  <tr>
    <td class="nowrap">
      <span class={`pill ${cls}`}>{name}</span>
    </td>
    <td>{what}</td>
    <td class="sub">{when}</td>
  </tr>
)

const Label: FC<{ name: string; values: string; what: string }> = ({ name, values, what }) => (
  <tr>
    <td class="mono nowrap">{name}</td>
    <td class="mono sub">{values}</td>
    <td>{what}</td>
  </tr>
)
