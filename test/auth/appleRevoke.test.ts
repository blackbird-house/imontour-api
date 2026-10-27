import { exportPKCS8, generateKeyPair, jwtVerify, decodeProtectedHeader } from 'jose'
import { describe, expect, it } from 'vitest'
import { createAppleRevoker, createNoopAppleRevoker } from '../../src/auth/appleRevoke.js'

const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
const pem = await exportPKCS8(privateKey)
const config = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: pem, clientId: 'com.example.imontour' }

type Call = { url: string; form: URLSearchParams }

/** Answers each call in order with the given responses. */
function fakeFetch(...responses: Response[]) {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(init.body as URLSearchParams) })
    return responses[calls.length - 1] ?? new Response(null, { status: 500 })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('createAppleRevoker', () => {
  it('exchanges the code for a refresh token and revokes it', async () => {
    const { calls, fetchFn } = fakeFetch(json({ refresh_token: 'r-token' }), new Response(null, { status: 200 }))
    await createAppleRevoker(config, fetchFn).revoke('the-code')

    expect(calls.map((c) => c.url)).toEqual([
      'https://appleid.apple.com/auth/token',
      'https://appleid.apple.com/auth/revoke',
    ])
    expect(calls[0]!.form.get('grant_type')).toBe('authorization_code')
    expect(calls[0]!.form.get('code')).toBe('the-code')
    expect(calls[0]!.form.get('client_id')).toBe(config.clientId)
    expect(calls[1]!.form.get('token')).toBe('r-token')
    expect(calls[1]!.form.get('token_type_hint')).toBe('refresh_token')
    expect(calls[1]!.form.get('client_id')).toBe(config.clientId)
  })

  it('signs the client secret as Apple specifies', async () => {
    const { calls, fetchFn } = fakeFetch(json({ refresh_token: 'r' }), new Response(null, { status: 200 }))
    await createAppleRevoker(config, fetchFn).revoke('c')
    const secret = calls[0]!.form.get('client_secret')!
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: config.keyId })
    const { payload } = await jwtVerify(secret, publicKey, {
      issuer: config.teamId,
      subject: config.clientId,
      audience: 'https://appleid.apple.com',
    })
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300)
  })

  it('accepts a private key with literal \\n sequences', async () => {
    const { fetchFn } = fakeFetch(json({ refresh_token: 'r' }), new Response(null, { status: 200 }))
    await expect(
      createAppleRevoker({ ...config, privateKey: pem.trim().replaceAll('\n', '\\n') }, fetchFn).revoke('c'),
    ).resolves.toBeUndefined()
  })

  it('rejects when the exchange fails, without calling revoke', async () => {
    const { calls, fetchFn } = fakeFetch(json({ error: 'invalid_grant' }, 400))
    await expect(createAppleRevoker(config, fetchFn).revoke('used')).rejects.toThrow(/exchange failed with HTTP 400/)
    expect(calls).toHaveLength(1)
  })

  it('rejects when the exchange returns no refresh token', async () => {
    const { fetchFn } = fakeFetch(json({ access_token: 'a' }))
    await expect(createAppleRevoker(config, fetchFn).revoke('c')).rejects.toThrow(/no refresh token/)
  })

  it('rejects when the revoke call fails', async () => {
    const { fetchFn } = fakeFetch(json({ refresh_token: 'r' }), new Response(null, { status: 503 }))
    await expect(createAppleRevoker(config, fetchFn).revoke('c')).rejects.toThrow(/revoke failed with HTTP 503/)
  })

  it('never puts the key or the code in an error message', async () => {
    const { fetchFn } = fakeFetch(json({}, 400))
    const err = await createAppleRevoker(config, fetchFn)
      .revoke('secret-code')
      .catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain('secret-code')
    expect(String((err as Error).message)).not.toContain('PRIVATE')
  })
})

describe('createNoopAppleRevoker', () => {
  it('does nothing', async () => {
    await expect(createNoopAppleRevoker().revoke('x')).resolves.toBeUndefined()
  })
})
