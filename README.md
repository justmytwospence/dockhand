# dockhand

A Docker image update bot for a single-host Docker Compose homelab.

It polls registries for new image tags, opens **real GitHub pull requests** that bump the
`image:` line, asks **Claude** to find and read the upstream changelog and judge the
release, auto-merges what policy allows, and then deploys the change on the host with a
true `docker compose up -d`.

Think Renovate, but scoped to one operator's compose repo, and with the part Renovate
structurally cannot do: an LLM that goes and finds the changelog when the image doesn't
tell you where it lives.

## Why it exists

The usual homelab updater (WUD, Diun, Watchtower) either just notifies you, or rewrites
the compose file and restarts the container behind your back. Renovate opens proper PRs
but has two problems here:

1. **No changelog for most homelab images.** Renovate finds release notes by reading the
   `org.opencontainers.image.source` OCI annotation. Measured across 37 images from the
   repo this was built against: only ~49% carry an annotation pointing at the real
   upstream project. ~27% point at a *packaging* repo (`traefik` →
   `traefik-library-image`, every linuxserver image → `linuxserver/docker-<app>`), which
   is technically correct and useless. ~24% carry nothing at all. Renovate has no
   override for this and simply renders an empty changelog section.
2. **No extension point for an LLM.** Renovate has no hook that can write to a PR body,
   so any AI summary has to be a separate bot commenting afterwards.

dockhand resolves the source repo in three tiers — OCI annotations, then a curated
override map (the LinuxServer API's `project_url` field resolves their entire tier for
free), then Claude web search for the residue — and caches the answer permanently.

It also fixes a subtler thing. WUD's compose trigger recreates a container by cloning the
*running* container's config and swapping only the image, so it never re-reads the
compose file. Label and image-env changes silently never apply. dockhand deploys with a
real `docker compose up -d`, and reads its own configuration from the compose files in
git rather than from live container labels, so that failure class cannot occur.

## How it works

```
registry poll ──▶ new tag ──▶ resolve source repo ──▶ fetch changelog ──▶ Claude verdict
                                                                              │
                              ┌───────────────────────────────────────────────┘
                              ▼
                      open PR on GitHub ──▶ policy: auto-merge? ──▶ merge
                                                                     │
                              sync into the live checkout ◀──────────┘
                                          │
                                          ▼
                              docker compose up -d ──▶ health check ──▶ ntfy
```

Three git locations, with strict roles:

| Location | Role |
|---|---|
| the live checkout | the **only** place deploys run; touched solely to fetch, fast-forward, and `compose up` |
| the tool's own clone (`/data/repo`) | all branch, edit, commit, and push work — immune to your uncommitted WIP |
| GitHub | where PRs live and merge |

## Configuration

Two layers, deliberately.

**Per-service data** lives as labels on the service itself, so it travels with the thing
it describes — and is read from the compose files rather than from running containers,
so editing one takes effect on the next scan with nothing recreated.

**Policy semantics** live once, centrally, in `policy.yaml`, never restated per service.
That separation matters more than it looks: the repository this was built against had
previously copy-pasted a six-clause trigger string onto 94 services, and a deliberate
carve-out got silently reverted in a refactor because nobody could see the policy in one
place.

Both are covered with examples under [Running it yourself](#running-it-yourself), and
the policy file is editable from the Settings page.

## The policy model

The static tier and Claude's verdict combine by taking **the more conservative of the
two**. Claude is a one-directional damper:

| Static tier | Verdict | Result |
|---|---|---|
| auto | approve, confident | auto-merge, then deploy |
| auto | caution / block / unsure | PR stays open for a human |
| auto | *analysis unavailable* | merge per static policy (fail-open) |
| manual or gated | anything | PR always; never auto-merged |

Claude can **block** an update that policy would have merged. It can never **promote**
one. Majors and gated services are never auto-merged, and that is not configurable.

This is also the prompt-injection boundary: release notes are untrusted input, and the
worst a hostile changelog can achieve is to stop an update.

## Running it yourself

dockhand watches a git repository full of Docker Compose files, so it needs to know
which repository and where that checkout lives on disk. Nothing else is required to
start.

### Environment

| Variable | Required | Default | What it is |
|---|---|---|---|
| `REPO_DIR` | **yes** | — | The checkout of your compose repository. Must be bind-mounted at the *identical* path inside the container (see below). |
| `GITHUB_REPO` | **yes** | — | `owner/repo` of that repository, for pull requests. |
| `GITHUB_TOKEN` | for PRs | — | Fine-grained PAT scoped to that repo: **Contents** read+write, **Pull requests** read+write. |
| `ANTHROPIC_API_KEY` | for analysis | — | Without it PRs still open, labelled `needs-analysis`. |
| `POLICY_FILE` | no | `$REPO_DIR/dockhand/config/policy.yaml` | Where the tracked policy file lives. |
| `SELF_STACK` | no | `dockhand` | Stack directory holding dockhand, excluded so it never updates itself. |
| `BOT_EMAIL` | no | `dockhand@localhost` | Git author for dockhand's commits. |
| `DATA_DIR` | no | `/data` | SQLite database and dockhand's own working clone. |
| `PORT` / `TZ` | no | `8080` / `UTC` | |
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` | no | — | Push notifications. Unset means no notifications. |
| `DOCKER_HUB_LOGIN` / `_PASSWORD` | no | — | Doubles the Docker Hub pull allowance (100→200 per 6h). |

Start it with nothing set and it will tell you what is missing rather than crash-loop.

### Why the mount path must match

`docker compose` resolves relative volume paths (`./data`) and derives the project name
**client-side**, before it talks to the daemon. If dockhand saw your repo at a different
path than the host does, it would hand the daemon paths that do not exist. So the bind
mount is `/your/path:/your/path`, not `/your/path:/repo`.

```yaml
services:
  dockhand:
    build: ./app          # or image: ghcr.io/justmytwospence/dockhand:latest
    restart: unless-stopped
    user: "1000:1000"     # match the owner of the checkout
    environment:
      REPO_DIR: /srv/compose
      GITHUB_REPO: you/your-compose-repo
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    volumes:
      - /srv/compose:/srv/compose                  # identical path, read-write
      - ./data:/data                               # create it first: mkdir -p data
      - /var/run/docker.sock:/var/run/docker.sock  # deploys run compose
    ports:
      - "8080:8080"
```

Put a web server with authentication in front of it. The UI has no login of its own,
because it is designed to sit behind one you already run.

### Labelling services

dockhand only watches services that opt in, via labels on the service in your compose
file. It reads them from the **files**, not from running containers, so a label change
takes effect on the next scan without recreating anything.

```yaml
    labels:
      dockhand.watch: "true"
      dockhand.pattern: semver     # semver | v-semver | semver-minor | v-semver-minor
                                   #  | semver-quad | major-only | v-major-only
                                   #  | semver-variant | semver-minor-variant
                                   #  | major-variant | lsio-ls | lsio-r-ls | date
                                   #  | digest | latest | regex
      # Optional:
      dockhand.tag.include: '^\d{1,3}\.\d+\.\d+$$'  # narrow the candidates ($$ escapes $)
      dockhand.policy: gated       # auto | gated | manual | skip | model
      dockhand.pr: on-request      # detect and show, but only open a PR when asked
      dockhand.source: https://github.com/owner/repo   # if the image lacks an OCI source label
      dockhand.claude: required    # refuse to auto-merge without a verdict
      dockhand.group: mygroup      # force services into one PR
      dockhand.deploy: rm-first    # recreate rather than update (re-reads image env)
```

### Letting the model decide (opt-in, off by default)

`dockhand.policy: model` defers the auto-versus-review question to the changelog
review, instead of deciding it by version magnitude. It is the one place a model can
*raise* a tier rather than only lower it, so promotion requires all of:

- the image resolves to a real upstream (its own OCI annotation, a curated override,
  LinuxServer's API, or your `dockhand.source` label);
- **every URL the verdict cited lives under that upstream repository** — this is the
  actual guard. Web search is domain-restricted but page fetches are not, and GitHub
  hosts content anyone can create, so "it turned up in a search" proves nothing;
- the verdict is `approve` at `high` confidence, with no breaking changes and no
  migration steps.

Any failure falls back to what static policy alone would say, which for a major is a
human. Nothing here reads the prose of a changelog: every guard is a structural fact
about provenance or about fields the model filled in, so a release note claiming to be
routine has no path to the outcome.

`model_tier.mode` is `shadow` by default — decisions are recorded on the System page
and nothing acts on them, so you can see the track record before deciding whether to
`enforce`. Per-service labels remain the default and the recommendation; this is for
when you would rather not maintain them.

If you already label services for another updater, `npm run migrate-labels` derives
`dockhand.*` labels from `wud.*` ones and writes them in place, validating each
refinement against the tag actually pinned.

### Policy

A starter `policy.yaml`, which the Settings page also edits for you:

```yaml
merge_method: squash          # must match what your repo allows
prs:
  enabled: true
  scope: coexist              # coexist | full -- see below
  max_open: 5
defaults:
  patch: auto
  minor: auto
  major: manual               # forced; majors always need a human
  digest: manual
claude:
  mode: advisory              # advisory | off
  model: claude-haiku-4-5-20251001
  min_confidence: medium
  monthly_budget_usd: 10
scan:
  cron: "0 0 3 * * *"         # seconds first
```

`scope: coexist` is for running alongside an updater that already applies routine
patches itself — dockhand then takes only what such a tool leaves alone (majors, digest
pins, anything not on the auto tier), so the two can never write to the same file for
the same reason. Use `full` when dockhand is your only updater.

### One-time repository settings

Allow the merge method you configured, and enable auto-delete of head branches.
dockhand pushes `main` as part of its loop: a branch cut from a stale `origin/main`
silently reverts unpushed local commits when it merges, so publishing is a
precondition, not a preference. `sync.push_main: false` disables it, which also
disables pull requests.


## Status

Working today: detection across every registry, digest watching, grouped pull requests,
changelog analysis with merge/hold verdicts, and a web UI. Merged pull requests are
synced into the checkout and the deploy command is sent to you; running it
automatically, and auto-merging what policy allows, is the next milestone.

## Licence

MIT.
