import type { IdentityProviderAdmin } from './providerAdmin.js'

export type SupabaseAdminConfig = {
  /** Project URL, e.g. https://<ref>.supabase.co */
  url: string
  /** Service-role key. Secret; server-side only. */
  serviceKey: string
  /** Only identities from this issuer belong to this project. */
  issuer: string
}

const TIMEOUT_MS = 5000

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
        headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok && res.status !== 404) throw new Error(`Supabase admin deleteUser failed with HTTP ${res.status}`)
    },
  }
}
