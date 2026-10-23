import type { IdentityProviderAdmin } from './providerAdmin.js'

export type SupabaseAdminConfig = {
  /** Project URL, e.g. https://<ref>.supabase.co */
  url: string
  /** Secret server-side key: a new `sb_secret_...` API key, or the legacy `service_role` JWT. Never expose it. */
  serviceKey: string
  /** Only identities from this issuer belong to this project. */
  issuer: string
}

const TIMEOUT_MS = 5000

/**
 * New-style secret keys (`sb_secret_...`) are opaque, not JWTs: they go in the `apikey` header only.
 * The legacy `service_role` key is a JWT and is also sent as the bearer token.
 */
function authHeaders(key: string): Record<string, string> {
  return key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` }
}

/**
 * Supabase Auth adapter: deletes the auth user through the GoTrue admin API
 * (`DELETE /auth/v1/admin/users/{id}`; for Supabase the token subject is that id).
 * Not yet exercised against a real Supabase project.
 */
export function createSupabaseIdentityAdmin(
  config: SupabaseAdminConfig,
  fetchFn: typeof fetch = fetch,
): IdentityProviderAdmin {
  const base = config.url.replace(/\/+$/, '')
  return {
    async deleteIdentity({ issuer, subject }) {
      if (issuer !== config.issuer) return
      const res = await fetchFn(`${base}/auth/v1/admin/users/${encodeURIComponent(subject)}`, {
        method: 'DELETE',
        headers: authHeaders(config.serviceKey),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok && res.status !== 404) throw new Error(`Supabase admin deleteUser failed with HTTP ${res.status}`)
    },
  }
}
