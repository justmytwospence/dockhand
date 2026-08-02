import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPatch } from '../src/gitops/poll.ts'

const f = (filename: string, patch: string) => ({ filename, patch })

const IMAGE_ONLY = `@@ -48,7 +48,7 @@ services:

   arcane:
     container_name: arcane
-    image: ghcr.io/getarcaneapp/arcane:v1.18.1
+    image: ghcr.io/getarcaneapp/arcane:v2.6.0
     restart: unless-stopped`

test('a clean image bump stays tag-only', () => {
  assert.equal(classifyPatch([f('arcane/docker-compose.yaml', IMAGE_ONLY)], false), 'tag-only')
})

test('two image lines in one file are still tag-only', () => {
  // A grouped PR edits several services in the same compose file.
  const patch = `@@ -10,7 +10,7 @@
-    image: ghcr.io/immich-app/immich-server:v2.7.5
+    image: ghcr.io/immich-app/immich-server:v3.1.0
@@ -40,7 +40,7 @@
-    image: ghcr.io/immich-app/immich-machine-learning:v2.7.5
+    image: ghcr.io/immich-app/immich-machine-learning:v3.1.0`
  assert.equal(classifyPatch([f('immich/docker-compose.yaml', patch)], false), 'tag-only')
})

test('any non-image line makes it modified', () => {
  // The arcane upgrade genuinely needs this: the image renames AND env must change.
  const patch = `@@ -48,8 +48,9 @@
-    image: ghcr.io/getarcaneapp/arcane:v1.18.1
+    image: ghcr.io/getarcaneapp/manager:v2.6.0
     environment:
-      OIDC_ADMIN_CLAIM: groups
+      OIDC_GROUPS_CLAIM: groups`
  assert.equal(classifyPatch([f('arcane/docker-compose.yaml', patch)], false), 'modified')
})

test('a file that is not a compose file makes it modified', () => {
  assert.equal(
    classifyPatch(
      [f('arcane/docker-compose.yaml', IMAGE_ONLY), f('arcane/README.md', '+a note')],
      false,
    ),
    'modified',
  )
})

test('a truncated file list is treated as modified', () => {
  // A second page means we cannot see everything; guessing "clean" would be the
  // expensive direction once auto-merge trusts this.
  assert.equal(classifyPatch([f('a/docker-compose.yaml', IMAGE_ONLY)], true), 'modified')
})

test('diff headers are not mistaken for content', () => {
  const patch = `--- a/x/docker-compose.yaml
+++ b/x/docker-compose.yaml
@@ -1,3 +1,3 @@
-    image: nginx:1.27
+    image: nginx:1.28`
  assert.equal(classifyPatch([f('x/docker-compose.yaml', patch)], false), 'tag-only')
})

test('an empty or missing patch is not evidence of an edit', () => {
  // GitHub omits `patch` for very large or binary files; the filename check already
  // rejects anything that is not a compose file.
  assert.equal(classifyPatch([{ filename: 'x/docker-compose.yaml' }], false), 'tag-only')
  assert.equal(classifyPatch([], false), 'tag-only')
})

test('indentation variations on the image line still count as image lines', () => {
  const patch = `@@ -1,2 +1,2 @@
-  image: redis:7
+  image: redis:8`
  assert.equal(classifyPatch([f('x/docker-compose.yaml', patch)], false), 'tag-only')
})
