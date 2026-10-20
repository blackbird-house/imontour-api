// Local development only (APP_ENV=local). Never used in deployed environments.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose'

export type LocalKeyFile = { kid: string; privateJwk: JWK; publicJwk: JWK }

export async function ensureLocalKeyFile(path: string): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  const content: LocalKeyFile = {
    kid: `local-${Date.now().toString(36)}`,
    privateJwk: await exportJWK(privateKey),
    publicJwk: await exportJWK(publicKey),
  }
  await mkdir(dirname(path), { recursive: true })
  try {
    // 'wx' never overwrites an existing file; mode applies at creation.
    await writeFile(path, JSON.stringify(content, null, 2), { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

export async function readLocalKeyFile(path: string): Promise<LocalKeyFile> {
  return JSON.parse(await readFile(path, 'utf8')) as LocalKeyFile
}

export async function signLocalToken(
  path: string,
  opts: { sub: string; iss: string; aud: string; expiresIn?: string },
): Promise<string> {
  const { kid, privateJwk } = await readLocalKeyFile(path)
  const key = await importJWK(privateJwk, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid })
    .setSubject(opts.sub)
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(key)
}
