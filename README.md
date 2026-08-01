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

Two layers, deliberately:

**Per-service data** lives as labels on the service itself, so it travels with the thing
it describes:

```yaml
labels:
  dockhand.watch: "true"
  dockhand.pattern: semver          # semver|v-semver|major-only|v-major-only|lsio-ls
                                    #   |lsio-r-ls|date|digest|latest|regex
  dockhand.tag.include: '^\d{1,3}\.\d+\.\d+$$'   # optional refinement
  dockhand.policy: gated            # optional: auto|gated|manual|skip
  dockhand.source: https://github.com/miniflux/v2   # optional resolver override
  dockhand.claude: required         # optional: fail-closed if analysis is unavailable
  dockhand.deploy: rm-first         # optional: rm -sf before up -d (re-reads image env)
```

**Policy semantics** live once, centrally, in `policy.yaml` — never restated per service.
That separation is the whole point: the repo this was built for previously carried a
six-clause trigger string copy-pasted onto 94 services, and a policy carve-out got
silently reverted in a refactor because of it.

```yaml
merge_method: squash
sync:
  push_main: true
  blackout: ["00:45-02:30"]
defaults:
  patch: auto
  minor: auto
  major: manual        # forced regardless; majors never auto-merge
  digest: manual
claude:
  mode: advisory
  min_confidence: medium
```

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

## Status

Under construction, milestone by milestone. M0 (scaffold, read-only inventory) is what
exists today; the registry poller, PR engine, analyzer, and deploy loop follow. Nothing
writes to git or Docker until the milestone that introduces it.

## Licence

MIT.
