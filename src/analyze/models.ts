import { env } from '../config.ts'
import { getDb } from '../db.ts'

/**
 * The models this key can actually use, so the settings page offers a real list rather
 * than a hardcoded one that goes stale.
 */

const CACHE_KEY = 'anthropic:models'
const TTL_MS = 24 * 60 * 60 * 1000

export async function listModels(): Promise<string[]> {
  const cached = readCache()
  if (cached) return cached
  if (!env.anthropicApiKey) return []

  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      headers: { 'x-api-key': env.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { id: string }[] }
    const ids = (body.data ?? []).map((m) => m.id)
    if (ids.length > 0) writeCache(ids)
    return ids
  } catch {
    // The page must render without a working key.
    return []
  }
}

function readCache(): string[] | null {
  const row = getDb()
    .prepare(`SELECT body, fetched_at FROM http_cache WHERE url = ?`)
    .get(CACHE_KEY) as { body: string; fetched_at: string } | undefined
  if (!row) return null
  if (Date.now() - Date.parse(row.fetched_at) > TTL_MS) return null
  try {
    return JSON.parse(row.body) as string[]
  } catch {
    return null
  }
}

function writeCache(ids: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, NULL, ?, ?)
       ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
    )
    .run(CACHE_KEY, JSON.stringify(ids), new Date().toISOString())
}
