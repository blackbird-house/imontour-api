import { describe, expect, it } from 'vitest'
import { createNoopIdentityAdmin } from '../../src/auth/providerAdmin.js'
import { createSupabaseIdentityAdmin } from '../../src/auth/supabaseAdmin.js'

const ISSUER = 'https://ref.supabase.co/auth/v1'
const config = { url: 'https://ref.supabase.co/', serviceKey: 'service-key', issuer: ISSUER }

function fakeFetch(status: number) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(null, { status })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

describe('createSupabaseIdentityAdmin', () => {
  it('deletes the auth user through the admin API with the service key', async () => {
    const { calls, fetchFn } = fakeFetch(200)
    await createSupabaseIdentityAdmin(config, fetchFn).deleteIdentity({ issuer: ISSUER, subject: 'abc-123' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://ref.supabase.co/auth/v1/admin/users/abc-123')
    expect(calls[0]!.init.method).toBe('DELETE')
    expect(calls[0]!.init.headers).toEqual({ apikey: 'service-key', Authorization: 'Bearer service-key' })
  })

  it('sends a new sb_secret_ key as apikey only, never as a bearer token', async () => {
    const { calls, fetchFn } = fakeFetch(200)
    const key = 'sb_secret_abc123'
    await createSupabaseIdentityAdmin({ ...config, serviceKey: key }, fetchFn).deleteIdentity({
      issuer: ISSUER,
      subject: 'abc-123',
    })
    expect(calls[0]!.init.headers).toEqual({ apikey: key })
  })

  it('keeps sending a legacy JWT service_role key as apikey and bearer', async () => {
    const { calls, fetchFn } = fakeFetch(200)
    const key = 'eyJhbGciOiJIUzI1NiJ9.e30.sig'
    await createSupabaseIdentityAdmin({ ...config, serviceKey: key }, fetchFn).deleteIdentity({
      issuer: ISSUER,
      subject: 'abc-123',
    })
    expect(calls[0]!.init.headers).toEqual({ apikey: key, Authorization: `Bearer ${key}` })
  })

  it('encodes the subject into the path', async () => {
    const { calls, fetchFn } = fakeFetch(200)
    await createSupabaseIdentityAdmin(config, fetchFn).deleteIdentity({ issuer: ISSUER, subject: 'a/b?c' })
    expect(calls[0]!.url).toBe('https://ref.supabase.co/auth/v1/admin/users/a%2Fb%3Fc')
  })

  it('treats an already-deleted user (404) as success', async () => {
    const { fetchFn } = fakeFetch(404)
    await expect(
      createSupabaseIdentityAdmin(config, fetchFn).deleteIdentity({ issuer: ISSUER, subject: 'x' }),
    ).resolves.toBeUndefined()
  })

  it('throws on any other failure, without leaking the key', async () => {
    const { fetchFn } = fakeFetch(500)
    const err = await createSupabaseIdentityAdmin(config, fetchFn)
      .deleteIdentity({ issuer: ISSUER, subject: 'x' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/HTTP 500/)
    expect((err as Error).message).not.toContain('service-key')
  })

  it('ignores identities from other issuers', async () => {
    const { calls, fetchFn } = fakeFetch(200)
    await createSupabaseIdentityAdmin(config, fetchFn).deleteIdentity({ issuer: 'https://other.test', subject: 'x' })
    expect(calls).toHaveLength(0)
  })
})

describe('createNoopIdentityAdmin', () => {
  it('does nothing', async () => {
    await expect(createNoopIdentityAdmin().deleteIdentity({ issuer: ISSUER, subject: 'x' })).resolves.toBeUndefined()
  })
})
