import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLocalKeyFile, signLocalToken } from '../../src/auth/localKeys.js'
import { createVerifier } from '../../src/auth/verifier.js'
import { UnauthorizedError } from '../../src/errors.js'

const sub = '00000000-0000-4000-8000-000000000001'

describe('local keys', () => {
  it('creates the key file (mode 0600, nested dirs) once and keeps it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imontour-keys-'))
    const path = join(dir, 'nested', '.local', 'keys.json')
    await ensureLocalKeyFile(path)
    const first = await readFile(path, 'utf8')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(first)).sort()).toEqual(['kid', 'privateJwk', 'publicJwk'])
    await ensureLocalKeyFile(path)
    expect(await readFile(path, 'utf8')).toBe(first)
  })

  it('signs tokens that the local-key verifier accepts, and rejects other issuers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imontour-keys-'))
    const path = join(dir, 'keys.json')
    await ensureLocalKeyFile(path)
    const token = await signLocalToken(path, { sub, iss: 'http://iss.local', aud: 'authenticated' })
    const verify = createVerifier({ issuer: 'http://iss.local', audience: 'authenticated', localKeyFile: path })
    await expect(verify(token)).resolves.toEqual({ issuer: 'http://iss.local', subject: sub })
    const wrong = createVerifier({ issuer: 'http://other.local', audience: 'authenticated', localKeyFile: path })
    await expect(wrong(token)).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
