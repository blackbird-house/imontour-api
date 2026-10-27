import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  COLLECTION_VARIABLES,
  ENVIRONMENT_VARIABLES,
  EXAMPLES,
  buildCollection,
  buildCollectionFiles,
} from '../src/collection.js'
import { buildOpenApiDocument } from '../src/openapi.js'
import { createTripBodySchema, renameSchema, tripInputSchema } from '../src/schemas/trip.js'
import { updateUserSchema } from '../src/schemas/user.js'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const doc = buildOpenApiDocument() as Parameters<typeof buildCollection>[0]
const collection = buildCollection(doc) as Json
const requests: { folder: string; item: Json }[] = collection.item.flatMap((f: Json) =>
  f.item.map((item: Json) => ({ folder: f.name as string, item })),
)

describe('API client collection', () => {
  it('has one request per OpenAPI operation, in folders named after the tags', () => {
    const operations = Object.values(doc.paths).flatMap((ops) => Object.values(ops))
    expect(requests).toHaveLength(operations.length)
    expect(Object.keys(EXAMPLES).sort()).toEqual(operations.map((o) => o.operationId).sort())
    expect(collection.item.map((f: Json) => f.name)).toEqual(['Config', 'Health', 'Trips', 'Me'])
  })

  it('points every request at a real path and method of the API', () => {
    const known = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace('{id}', '{{tripId}}')}`),
      ),
    )
    for (const { item } of requests) {
      const url = item.request.url
      expect(known.has(`${item.request.method} /${url.path.join('/')}`), item.name).toBe(true)
      expect(url.raw.startsWith('{{baseUrl}}/')).toBe(true)
    }
  })

  it('sends bearer auth by default and nothing on the public requests', () => {
    expect(collection.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] })
    const isPublic = (folder: string) => folder === 'Config' || folder === 'Health'
    for (const { folder, item } of requests) {
      if (isPublic(folder)) expect(item.request.auth).toEqual({ type: 'noauth' })
      else expect(item.request.auth).toBeUndefined()
    }
  })

  it('example bodies are accepted by the real request schemas', () => {
    expect(createTripBodySchema.safeParse(EXAMPLES.createTrip!.body).success).toBe(true)
    expect(tripInputSchema.safeParse(EXAMPLES.replaceTrip!.body).success).toBe(true)
    expect(renameSchema.safeParse(EXAMPLES.renameTrip!.body).success).toBe(true)
    expect(updateUserSchema.safeParse(EXAMPLES.updateMe!.body).success).toBe(true)
  })

  it('only uses variables that an environment or the collection defines', () => {
    const defined = new Set<string>([...ENVIRONMENT_VARIABLES, ...COLLECTION_VARIABLES])
    const used = new Set(
      JSON.stringify(collection)
        .match(/\{\{[^}]+\}\}/g)
        ?.map((v) => v.slice(2, -2)),
    )
    for (const name of used) expect(defined.has(name), name).toBe(true)
  })

  it('keeps secrets out of the repo: the token is empty in every environment', () => {
    const files = buildCollectionFiles(doc)
    for (const [name, content] of Object.entries(files)) {
      if (!name.endsWith('environment.json')) continue
      const token = (JSON.parse(content) as Json).values.find((v: Json) => v.key === 'token')
      expect(token).toMatchObject({ value: '', type: 'secret' })
    }
  })

  it('keeps the token empty in the collection itself too, and defaults baseUrl to a public URL', () => {
    const vars = Object.fromEntries((collection.variable as Json[]).map((v) => [v.key, v.value]))
    expect(vars.token).toBe('')
    expect(String(vars.baseUrl)).toMatch(/^https:\/\//)
  })

  it('fails loudly for an operation that has no example yet', () => {
    const extended = structuredClone(doc)
    extended.paths['/v1/new'] = { get: { operationId: 'newThing', summary: 'New', tags: ['Trips'] } }
    expect(() => buildCollection(extended)).toThrow(/No example for GET \/v1\/new/)
  })

  it('matches the committed files in postman/ byte for byte', () => {
    for (const [name, content] of Object.entries(buildCollectionFiles(doc))) {
      expect(readFileSync(`postman/${name}`, 'utf8'), name).toBe(content)
    }
  })
})
