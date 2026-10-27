import { SignJWT, importPKCS8 } from 'jose'

/**
 * Apple requires an app that offers Sign in with Apple to revoke the user's token when they delete their account.
 * Supabase does not do this, and a native sign-in leaves us without a refresh token, so the app sends a fresh
 * authorization code at deletion time; we trade it for a refresh token and revoke that.
 */
export interface AppleTokenRevoker {
  /** Exchanges a one-time authorization code and revokes the resulting grant. Rejects if Apple refuses. */
  revoke(authorizationCode: string): Promise<void>
}

export type AppleRevokeConfig = {
  /** Apple Developer team id (10 characters). */
  teamId: string
  /** Id of the Sign in with Apple private key (.p8). */
  keyId: string
  /** Contents of the .p8 file. Literal `\n` sequences are accepted so it fits on one env line. */
  privateKey: string
  /** The app's bundle id (native sign-in) or Services id (web). Must be the client the code was issued for. */
  clientId: string
}

const APPLE_ORIGIN = 'https://appleid.apple.com'
const TIMEOUT_MS = 5000

/** For local development and for deployments with no Apple credentials configured. */
export function createNoopAppleRevoker(): AppleTokenRevoker {
  return { revoke: async () => {} }
}

export function createAppleRevoker(config: AppleRevokeConfig, fetchFn: typeof fetch = fetch): AppleTokenRevoker {
  const pem = config.privateKey.replaceAll('\\n', '\n')

  /** Apple's "client secret" is a short-lived JWT signed with the team's key. */
  async function clientSecret(): Promise<string> {
    const key = await importPKCS8(pem, 'ES256')
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
      .setIssuer(config.teamId)
      .setSubject(config.clientId)
      .setAudience(APPLE_ORIGIN)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key)
  }

  async function post(path: string, form: Record<string, string>): Promise<Response> {
    return fetchFn(`${APPLE_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  return {
    async revoke(authorizationCode) {
      const secret = await clientSecret()
      const exchanged = await post('/auth/token', {
        client_id: config.clientId,
        client_secret: secret,
        code: authorizationCode,
        grant_type: 'authorization_code',
      })
      if (!exchanged.ok) throw new Error(`Apple token exchange failed with HTTP ${exchanged.status}`)
      const { refresh_token: refreshToken } = (await exchanged.json()) as { refresh_token?: string }
      if (!refreshToken) throw new Error('Apple token exchange returned no refresh token')

      const revoked = await post('/auth/revoke', {
        client_id: config.clientId,
        client_secret: secret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      })
      if (!revoked.ok) throw new Error(`Apple token revoke failed with HTTP ${revoked.status}`)
    },
  }
}
