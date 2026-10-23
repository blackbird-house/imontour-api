import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { UnauthorizedError } from '../../src/errors.js'
import { createFileConfigSource } from '../../src/routes/config.js'
import { stubDeps } from '../helpers/app.js'

const verify = () => Promise.reject(new UnauthorizedError())

let dir: string
let file: string

function appFor(path: string) {
  return createApp(stubDeps({ verify, remoteConfig: createFileConfigSource(path) }))
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'remote-config-'))
  file = join(dir, 'remote-config.json')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('GET /v1/config', () => {
  it('serves the document with an ETag and no token', async () => {
    await writeFile(file, '{"schemaVersion":1,"flags":{}}\n')
    const res = await appFor(file).request('/v1/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ schemaVersion: 1, flags: {} })
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]{16}"$/)
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('answers 304 with an empty body when If-None-Match matches', async () => {
    const app = appFor(file)
    const etag = (await app.request('/v1/config')).headers.get('ETag')!
    const res = await app.request('/v1/config', { headers: { 'If-None-Match': etag } })
    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    expect(res.headers.get('ETag')).toBe(etag)
  })

  it('accepts weak, list and wildcard If-None-Match forms', async () => {
    const app = appFor(file)
    const etag = (await app.request('/v1/config')).headers.get('ETag')!
    for (const value of [`W/${etag}`, `"other", ${etag}`, `W/"x",W/${etag}`, '*']) {
      const res = await app.request('/v1/config', { headers: { 'If-None-Match': value } })
      expect(res.status, value).toBe(304)
    }
    const stale = await app.request('/v1/config', { headers: { 'If-None-Match': '"nope"' } })
    expect(stale.status).toBe(200)
  })

  it('changes the ETag when the file content changes', async () => {
    const app = appFor(file)
    await writeFile(file, '{"schemaVersion":1,"flags":{}}\n')
    const first = (await app.request('/v1/config')).headers.get('ETag')
    await writeFile(file, '{"schemaVersion":2,"flags":{}}\n')
    const res = await app.request('/v1/config', { headers: { 'If-None-Match': first! } })
    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).not.toBe(first)
    expect(await res.json()).toEqual({ schemaVersion: 2, flags: {} })
  })

  it('serves the file verbatim without validating it', async () => {
    const doc = { minimumSupportedVersion: '1.2.0', flags: { x: { value: true, rolloutPercent: 50 } } }
    await writeFile(file, JSON.stringify(doc))
    const res = await appFor(file).request('/v1/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(doc)

    const odd = { schemaVersion: 'nope', flags: 7, extra: [1] }
    await writeFile(file, JSON.stringify(odd))
    const res2 = await appFor(file).request('/v1/config')
    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual(odd)
  })

  it('returns a JSON 500 when the file is missing or unparsable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const missing = await appFor(join(dir, 'missing.json')).request('/v1/config')
      expect(missing.status).toBe(500)
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('internal')

      await writeFile(file, '{not json')
      const bad = await appFor(file).request('/v1/config')
      expect(bad.status).toBe(500)
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('internal')
    } finally {
      spy.mockRestore()
    }
  })

  it('stays public while /v1/trips still requires a token', async () => {
    await writeFile(file, '{"schemaVersion":1,"flags":{}}')
    const app = appFor(file)
    expect((await app.request('/v1/config')).status).toBe(200)
    expect((await app.request('/v1/trips')).status).toBe(401)
  })

  it('is documented as a public endpoint', async () => {
    const doc = appFor(file).getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } })
    const op = doc.paths?.['/v1/config']?.get
    expect(op).toBeDefined()
    // An empty list, not a missing key: explicitly public, so no default security applies.
    expect(op?.security).toEqual([])
  })
})
