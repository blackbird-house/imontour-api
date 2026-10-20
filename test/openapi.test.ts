import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildOpenApiDocument, formatOpenApiDocument } from '../src/openapi.js'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const doc = buildOpenApiDocument() as Json
const METHODS = ['get', 'put', 'post', 'patch', 'delete']

function operations(): { path: string; method: string; op: Json }[] {
  return Object.entries(doc.paths as Json).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((method) => ({ path, method, op: item[method] as Json })),
  )
}

function resolve(ref: string): unknown {
  expect(ref.startsWith('#/')).toBe(true)
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((node, key) => (node as Json | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc)
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v)
      else collectRefs(v, out)
    }
  }
  return out
}

describe('OpenAPI document', () => {
  it('is OpenAPI 3.1 with the expected info', () => {
    expect(doc.openapi).toMatch(/^3\.1\./)
    expect(doc.info.title).toBe('Imontour API')
    expect(doc.info.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version)
    expect(doc.info.description).toMatch(/If-Match/)
    expect(doc.info.description).toMatch(/Supabase/)
    expect(doc.servers).toEqual([{ url: '/', description: 'Same origin' }])
  })

  it('contains the expected paths and methods', () => {
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/trips', '/v1/trips/{id}', '/v1/config', '/v1/me']),
    )
    expect(Object.keys(doc.paths['/v1/me']).sort()).toEqual(['delete', 'get', 'patch'])
    expect(Object.keys(doc.paths['/v1/trips/{id}']).sort()).toEqual(['delete', 'get', 'patch', 'put'])
  })

  it('documents PUT with a required If-Match and all error responses', () => {
    const put = doc.paths['/v1/trips/{id}'].put as Json
    const ifMatch = (put.parameters as Json[]).find((p) => p.name === 'If-Match')
    expect(ifMatch).toMatchObject({ in: 'header', required: true })
    expect(Object.keys(put.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '412', '413', '422', '428']),
    )
    expect(put.description).toMatch(/If-Match.*required/i)
    expect(put.responses['200'].headers.ETag).toBeDefined()
  })

  it('documents POST with one CreateTripBody schema (destinations optional, max 200)', () => {
    const schema = doc.paths['/v1/trips'].post.requestBody.content['application/json'].schema as Json
    expect(schema).toEqual({ $ref: '#/components/schemas/CreateTripBody' })
    const body = doc.components.schemas.CreateTripBody as Json
    expect(body.required ?? []).not.toContain('destinations')
    expect(body.properties.destinations.maxItems).toBe(200)
    expect(doc.components.schemas.NewTripNameOnly).toBeUndefined()
    expect(doc.components.schemas.NewTripNameOnlyBody).toBeUndefined()
  })

  it('types schemaVersion as an integer enum [1]', () => {
    for (const name of ['Trip', 'TripInput', 'CreateTripBody']) {
      const sv = doc.components.schemas[name].properties.schemaVersion as Json
      expect(sv.type, name).toBe('integer')
      expect(sv.enum, name).toEqual([1])
      expect(sv.description, name).toMatch(/above 1/)
    }
    expect(doc.components.schemas.TripInput.properties.schemaVersion.default).toBe(1)
  })

  it('tags operations Trips, Me and Config', () => {
    const tags = new Set(operations().flatMap(({ op }) => op.tags as string[]))
    expect([...tags].sort()).toEqual(['Config', 'Me', 'Trips'])
  })

  it('defines the bearerAuth scheme and applies it to trips and me only', () => {
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    const ops = operations()
    for (const { path, op } of ops.filter((o) => o.path.startsWith('/v1/trips') || o.path === '/v1/me')) {
      expect(op.security, path).toEqual([{ bearerAuth: [] }])
    }
    expect(doc.paths['/v1/config'].get.security ?? []).toEqual([])
  })

  it('keeps color, place.type and timing.mode as open strings', () => {
    const { Destination, Place, Timing } = doc.components.schemas as Json
    for (const prop of [Destination.properties.color, Place.properties.type, Timing.properties.mode]) {
      expect(prop.type).toBe('string')
      expect(prop.enum).toBeUndefined()
      expect(prop.description).toMatch(/Known values/)
    }
  })

  it('documents the remote config caching headers and 304', () => {
    const get = doc.paths['/v1/config'].get as Json
    expect(get.responses['304']).toBeDefined()
    for (const status of ['200', '304']) {
      expect(Object.keys(get.responses[status].headers ?? {}), status).toEqual(
        expect.arrayContaining(['ETag', 'Cache-Control']),
      )
    }
  })

  it('documents POST 201 with ETag and Location, and 409', () => {
    const post = doc.paths['/v1/trips'].post as Json
    expect(Object.keys(post.responses['201'].headers)).toEqual(expect.arrayContaining(['ETag', 'Location']))
    expect(post.responses['409']).toBeDefined()
  })

  it('documents the ETag on every trip-returning response', () => {
    const ok = [
      doc.paths['/v1/trips/{id}'].get.responses['200'],
      doc.paths['/v1/trips/{id}'].put.responses['200'],
      doc.paths['/v1/trips/{id}'].patch.responses['200'],
      doc.paths['/v1/trips'].post.responses['201'],
    ] as Json[]
    for (const r of ok) expect(r.headers.ETag).toBeDefined()
  })

  it('declares 413 only on operations that accept a body, and 500 everywhere', () => {
    for (const { path, method, op } of operations()) {
      const hasBody = ['post', 'put', 'patch'].includes(method) && (path.startsWith('/v1/trips') || path === '/v1/me')
      expect(op.responses['413'] !== undefined, `${method} ${path} 413`).toBe(hasBody)
      expect(op.responses['500'], `${method} ${path} 500`).toBeDefined()
    }
  })

  it('declares 503 on every authenticated operation and nowhere else', () => {
    for (const { path, method, op } of operations()) {
      expect(op.responses['503'] !== undefined, `${method} ${path} 503`).toBe((op.security ?? []).length > 0)
    }
  })

  it('gives every operation a summary and tags', () => {
    for (const { path, method, op } of operations()) {
      expect(op.summary, `${method} ${path}`).toBeTruthy()
      expect(op.tags?.length, `${method} ${path}`).toBeGreaterThan(0)
    }
  })

  it('assigns the agreed unique operationIds', () => {
    const ids = Object.fromEntries(operations().map(({ path, method, op }) => [`${method} ${path}`, op.operationId]))
    expect(ids).toEqual({
      'get /v1/trips': 'listTrips',
      'post /v1/trips': 'createTrip',
      'get /v1/trips/{id}': 'getTrip',
      'put /v1/trips/{id}': 'replaceTrip',
      'patch /v1/trips/{id}': 'renameTrip',
      'delete /v1/trips/{id}': 'deleteTrip',
      'get /v1/config': 'getConfig',
      'get /v1/me': 'getMe',
      'patch /v1/me': 'updateMe',
      'delete /v1/me': 'deleteMe',
    })
    expect(new Set(Object.values(ids)).size).toBe(10)
  })

  it('documents the Me schemas: User fields, and UpdateUser with both fields optional and nullable', () => {
    const { User, UpdateUser } = doc.components.schemas as Json
    expect(User.required).toEqual(expect.arrayContaining(['id', 'displayName', 'email', 'locale', 'createdAt', 'updatedAt']))
    expect(UpdateUser.required ?? []).toEqual([])
    expect(Object.keys(UpdateUser.properties).sort()).toEqual(['displayName', 'locale'])
    expect(doc.paths['/v1/me'].get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/User',
    })
    expect(doc.paths['/v1/me'].delete.responses['204']).toBeDefined()
  })

  it('has no dangling $ref', () => {
    const refs = collectRefs(doc)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(resolve(ref), ref).toBeDefined()
  })

  it('matches the committed openapi.json byte for byte', () => {
    expect(readFileSync('openapi.json', 'utf8')).toBe(formatOpenApiDocument(doc))
  })
})
