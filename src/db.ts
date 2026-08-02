import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from './config.ts'

/**
 * Runtime state only. Policy is tracked YAML in the homelab repo; per-service config is
 * `dockhand.*` labels in the compose files. Everything here except verdict/cost history
 * is reconstructible from the registries, git, and those two sources.
 */

export type Db = Database.Database

let db: Db | null = null

export function getDb(): Db {
  if (db) return db
  mkdirSync(dirname(paths.db), { recursive: true })
  db = new Database(paths.db)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001-initial',
    sql: `
    -- One row per (stack, service) found in the compose files, refreshed every scan.
    CREATE TABLE images (
      stack           TEXT NOT NULL,
      service         TEXT NOT NULL,
      compose_file    TEXT NOT NULL,
      image_ref       TEXT NOT NULL,   -- full ref as written, e.g. lscr.io/x/y:1.2.3
      registry        TEXT NOT NULL,   -- docker.io | ghcr.io | lscr.io | quay.io | ...
      repository      TEXT NOT NULL,   -- namespace/name
      current_tag     TEXT,
      current_digest  TEXT,            -- when pinned tag@sha256:...
      watched         INTEGER NOT NULL DEFAULT 0,
      pattern         TEXT,            -- semver | v-semver | ... | regex
      tag_include     TEXT,
      policy_label    TEXT,            -- auto | gated | manual | skip (label override)
      source_label    TEXT,            -- dockhand.source override
      claude_label    TEXT,            -- 'required' => fail-closed for this service
      deploy_label    TEXT,            -- 'rm-first'
      unwatchable     TEXT,            -- reason: build | interpolated | disabled
      last_seen_at    TEXT NOT NULL,
      PRIMARY KEY (stack, service)
    );

    -- Tag inventory per repository, so "new since last scan" is answerable offline.
    CREATE TABLE tags_seen (
      registry     TEXT NOT NULL,
      repository   TEXT NOT NULL,
      tag          TEXT NOT NULL,
      digest       TEXT,
      published_at TEXT,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (registry, repository, tag)
    );

    -- image -> upstream source repo. Permanent: resolution is expensive (manifest walks
    -- count against the Docker Hub pull budget) and the answer effectively never changes.
    CREATE TABLE resolutions (
      registry    TEXT NOT NULL,
      repository  TEXT NOT NULL,
      source_url  TEXT,
      tier        TEXT NOT NULL,     -- annotation | override | lsio | claude | none
      detail      TEXT,
      resolved_at TEXT NOT NULL,
      PRIMARY KEY (registry, repository)
    );

    -- The update state machine.
    CREATE TABLE updates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      stack        TEXT NOT NULL,
      service      TEXT NOT NULL,
      image        TEXT NOT NULL,
      from_tag     TEXT NOT NULL,
      to_tag       TEXT NOT NULL,
      magnitude    TEXT NOT NULL,    -- major | minor | patch | digest
      tier         TEXT NOT NULL,    -- resolved static tier at detection time
      state        TEXT NOT NULL,    -- detected|pr_open|analyzed|merged|deploying
                                     -- |deployed|verified|superseded|failed|held
      detail       TEXT,
      detected_at  TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE (stack, service, from_tag, to_tag)
    );
    CREATE INDEX idx_updates_state ON updates(state);

    CREATE TABLE prs (
      update_id       INTEGER PRIMARY KEY REFERENCES updates(id) ON DELETE CASCADE,
      number          INTEGER NOT NULL,
      branch          TEXT NOT NULL,
      -- The sha the tool itself last pushed. If the remote branch has moved past this,
      -- the user has edited it: the branch becomes user-owned and is never force-pushed.
      head_sha_pushed TEXT NOT NULL,
      state           TEXT NOT NULL,  -- open | merged | closed
      user_owned      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      merged_at       TEXT
    );

    -- Keyed by image+versions, NOT by service: the same postgres bump in three stacks is
    -- analyzed once.
    CREATE TABLE verdicts (
      image           TEXT NOT NULL,
      from_tag        TEXT NOT NULL,
      to_tag          TEXT NOT NULL,
      summary         TEXT,
      severity        TEXT,
      breaking_changes TEXT,          -- JSON array
      migration_steps TEXT,           -- JSON array
      recommendation  TEXT,           -- approve | caution | block
      confidence      TEXT,           -- low | medium | high
      sources         TEXT,           -- JSON array
      model           TEXT,
      cost_usd        REAL,
      error           TEXT,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (image, from_tag, to_tag)
    );

    CREATE TABLE events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      level      TEXT NOT NULL,       -- info | warn | error
      kind       TEXT NOT NULL,       -- scan | sync | pr | analysis | deploy | policy
      stack      TEXT,
      service    TEXT,
      message    TEXT NOT NULL,
      detail     TEXT
    );
    CREATE INDEX idx_events_at ON events(at DESC);

    CREATE TABLE http_cache (
      url        TEXT PRIMARY KEY,
      etag       TEXT,
      body       TEXT,
      fetched_at TEXT NOT NULL
    );

    -- Docker Hub pull ledger and Claude monthly spend live here as simple counters.
    CREATE TABLE budgets (
      key        TEXT PRIMARY KEY,
      value      REAL NOT NULL,
      window     TEXT,
      updated_at TEXT NOT NULL
    );
  `,
  },
  {
    id: '002-digests-groups',
    sql: `
    -- Last-acknowledged digest for a rolling tag. Keyed by IMAGE, not service: huginn
    -- runs huginn-single-process:latest twice, so one baseline serves both and movement
    -- fans out per service at handling time.
    --
    -- Deliberately NOT tags_seen.digest: that column is refreshed as inventory on every
    -- scan, which would silently advance the baseline and swallow the movement event. A
    -- baseline may only advance when the digest checker acknowledges movement.
    CREATE TABLE digest_baselines (
      registry     TEXT NOT NULL,
      repository   TEXT NOT NULL,
      tag          TEXT NOT NULL,
      digest       TEXT NOT NULL,
      observed_at  TEXT NOT NULL,
      checked_at   TEXT NOT NULL,
      PRIMARY KEY (registry, repository, tag)
    );

    -- prs gains its own id plus group support, because one PR can carry several
    -- updates: immich-server and immich-machine-learning must move together or Immich
    -- runs version-skewed. Safe to drop and recreate -- no PR has ever been created.
    DROP TABLE prs;
    CREATE TABLE prs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      number          INTEGER NOT NULL,
      branch          TEXT NOT NULL,
      -- The sha the tool itself last pushed. A remote branch past this means the user
      -- edited it: it becomes user-owned and is never force-pushed again.
      head_sha_pushed TEXT NOT NULL,
      state           TEXT NOT NULL,          -- open | merged | closed
      user_owned      INTEGER NOT NULL DEFAULT 0,
      group_key       TEXT,                   -- null = singleton
      created_at      TEXT NOT NULL,
      merged_at       TEXT
    );
    CREATE TABLE pr_updates (
      pr_id     INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      update_id INTEGER NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      PRIMARY KEY (pr_id, update_id)
    );

    -- Latest named non-update outcome per service, so "needs a human" states are visible
    -- on the images page without log spelunking.
    ALTER TABLE images ADD COLUMN last_status TEXT;
    ALTER TABLE images ADD COLUMN last_detail TEXT;

    CREATE INDEX idx_updates_svc ON updates(stack, service, state);
  `,
  },
  {
    id: '003-constrained',
    sql: `
    -- A newer version exists but a deliberate tag.include pin suppressed it. Recorded
    -- so the UI can say "constrained" rather than showing the service as current -- a
    -- deliberate pin should look deliberate, not accidental.
    ALTER TABLE images ADD COLUMN constrained_from TEXT;
  `,
  },
  {
    id: '004-pr-scope',
    sql: `
    -- Whether a pull request still contains only the image-tag change dockhand wrote.
    -- 'tag-only' | 'modified'.
    --
    -- Every dockhand-authored PR starts tag-only by construction (the editor refuses to
    -- commit anything else), so the default backfills existing rows correctly. It flips
    -- to 'modified' when a human pushes to the branch -- which some updates genuinely
    -- require, e.g. an upstream that renames its image.
    --
    -- LOAD-BEARING FOR AUTO-MERGE: when that lands, the predicate must require
    -- scope = 'tag-only' in addition to canAutoMerge(). An edited branch contains work
    -- no policy or changelog verdict ever evaluated, so it always needs a human.
    ALTER TABLE prs ADD COLUMN scope TEXT NOT NULL DEFAULT 'tag-only';
  `,
  },
]

function migrate(d: Db): void {
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const applied = new Set(
    d.prepare(`SELECT id FROM _migrations`).all().map((r) => (r as { id: string }).id),
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    d.transaction(() => {
      d.exec(m.sql)
      d.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`).run(
        m.id,
        new Date().toISOString(),
      )
    })()
  }
}

export type EventLevel = 'info' | 'warn' | 'error'
export type EventKind = 'scan' | 'sync' | 'pr' | 'analysis' | 'deploy' | 'policy' | 'system'

export function logEvent(e: {
  level: EventLevel
  kind: EventKind
  message: string
  stack?: string
  service?: string
  detail?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO events (at, level, kind, stack, service, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      e.level,
      e.kind,
      e.stack ?? null,
      e.service ?? null,
      e.message,
      e.detail ?? null,
    )
  const tag = `[${e.kind}]${e.stack ? ` ${e.stack}/${e.service ?? ''}` : ''}`
  const line = `${tag} ${e.message}${e.detail ? ` -- ${e.detail}` : ''}`
  if (e.level === 'error') console.error(line)
  else if (e.level === 'warn') console.warn(line)
  else console.log(line)
}
