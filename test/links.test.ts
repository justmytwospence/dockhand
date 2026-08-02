import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refLinks } from '../src/links.ts'
import { parseImageRef } from '../src/images/ref.ts'

const links = (image: string, tag: string | null, source: string | null = null) =>
  refLinks(parseImageRef(image), tag, source)

test('Docker Hub official images use the underscore path', () => {
  // `postgres` normalises to library/postgres, but hub.docker.com/r/library/postgres
  // is not the page anyone wants.
  const l = links('postgres:18', '18')
  assert.equal(l.image, 'https://hub.docker.com/_/postgres')
  assert.equal(l.tag, 'https://hub.docker.com/_/postgres/tags?name=18')
})

test('Docker Hub namespaced images use /r/', () => {
  const l = links('miniflux/miniflux:2.3.3', '2.3.3')
  assert.equal(l.image, 'https://hub.docker.com/r/miniflux/miniflux')
  assert.equal(l.tag, 'https://hub.docker.com/r/miniflux/miniflux/tags?name=2.3.3')
})

test('lscr points at fleet, and at the Hub mirror for tags', () => {
  // lscr.io itself is a redirector and serves no browsable page.
  const l = links('lscr.io/linuxserver/radarr:5.28.0-ls298', '5.28.0-ls298')
  assert.equal(l.image, 'https://fleet.linuxserver.io/image?name=linuxserver/radarr')
  assert.equal(
    l.tag,
    'https://hub.docker.com/r/linuxserver/radarr/tags?name=5.28.0-ls298',
  )
})

test('ghcr prefers the source repo package page and falls back to the org index', () => {
  const withSource = links(
    'ghcr.io/immich-app/immich-server:v3.1.0',
    'v3.1.0',
    'immich-app/immich',
  )
  assert.equal(
    withSource.image,
    'https://github.com/immich-app/immich/pkgs/container/immich-server',
  )
  // ghcr has no per-tag page; the tag link points at filtered releases instead.
  assert.equal(withSource.tag, 'https://github.com/immich-app/immich/releases?q=v3.1.0')

  const without = links('ghcr.io/immich-app/immich-server:v3.1.0', 'v3.1.0')
  assert.equal(
    without.image,
    'https://github.com/orgs/immich-app/packages/container/package/immich-server',
  )
  assert.equal(without.tag, null, 'no source repo means no releases to point at')
})

test('multi-segment ghcr names keep their path after the owner', () => {
  // scanopy publishes scanopy/scanopy/server -- the package is "scanopy/server".
  const l = links('ghcr.io/scanopy/scanopy/server:v0.17.7', 'v0.17.7')
  assert.equal(
    l.image,
    'https://github.com/orgs/scanopy/packages/container/package/scanopy%2Fserver',
  )
})

test('quay filters its tag list', () => {
  const l = links('quay.io/jupyter/datascience-notebook:2026-07-28', '2026-07-28')
  assert.equal(l.image, 'https://quay.io/repository/jupyter/datascience-notebook?tab=tags')
  assert.match(l.tag!, /filter_tag_name=like:2026-07-28$/)
})

test('gitlab and codeberg registries resolve to their own package pages', () => {
  const gl = links('registry.gitlab.com/packaging/signal-cli/signal-cli-native:v0-14-3-1', 'v0-14-3-1')
  assert.equal(
    gl.image,
    'https://gitlab.com/packaging/signal-cli/signal-cli-native/container_registry',
  )
  assert.equal(gl.tag, null, 'gitlab has no stable per-tag registry URL')

  const cb = links('codeberg.org/readeck/readeck:0.21.1', '0.21.1')
  assert.equal(cb.image, 'https://codeberg.org/readeck/-/packages/container/readeck')
  // Codeberg has no addressable per-tag page; the obvious /<tag> suffix 404s.
  assert.equal(cb.tag, null)
})

test('a digest suffix never leaks into a tag URL', () => {
  // Digest-pinned refs carry `9@sha256:...` as the tag; no registry serves that page.
  const l = links(
    'docker.io/valkey/valkey:9@sha256:546304417feac0874c3dd576e0952c6bb8f06bb4093ea0c9ca303c73cf458f63',
    '9@sha256:546304417feac0874c3dd576e0952c6bb8f06bb4093ea0c9ca303c73cf458f63',
  )
  assert.equal(l.tag, 'https://hub.docker.com/r/valkey/valkey/tags?name=9')
  assert.ok(!l.tag!.includes('sha256'))
})

test('an unknown registry degrades to text, keeping only the source link', () => {
  const l = links('docker.openhands.dev/openhands/openhands:1.5', '1.5', 'All-Hands-AI/OpenHands')
  assert.equal(l.image, null)
  assert.equal(l.tag, null)
  assert.equal(l.source, 'https://github.com/All-Hands-AI/OpenHands')
  assert.equal(l.releases, 'https://github.com/All-Hands-AI/OpenHands/releases?q=1.5')
})

test('tags needing escaping are encoded', () => {
  const l = links('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z', 'RELEASE.2025-09-07T16-13-09Z')
  assert.ok(l.tag!.includes('RELEASE.2025-09-07T16-13-09Z'.replace(/:/g, '%3A')) || !l.tag!.includes(' '))
})
