import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRUNO_ENVIRONMENTS,
  BRUNO_ENVIRONMENT_VARIABLES,
  BRUNO_RUNTIME_VARIABLES,
  BRUNO_SECRET_VARIABLES,
  buildBrunoFiles,
} from '../src/bruno.js'
import { EXAMPLES } from '../src/collection.js'
import { buildOpenApiDocument } from '../src/openapi.js'
import { createTripBodySchema, renameSchema, tripInputSchema } from '../src/schemas/trip.js'
import { updateUserSchema } from '../src/schemas/user.js'

const doc = buildOpenApiDocument() as Parameters<typeof buildBrunoFiles>[0]

describe('request examples', () => {
  it('has exactly one example per OpenAPI operation', () => {
    const operations = Object.values(doc.paths).flatMap((ops) => Object.values(ops))
    expect(Object.keys(EXAMPLES).sort()).toEqual(operations.map((o) => o.operationId).sort())
  })

  it('example bodies are accepted by the real request schemas', () => {
    expect(createTripBodySchema.safeParse(EXAMPLES.createTrip!.body).success).toBe(true)
    expect(tripInputSchema.safeParse(EXAMPLES.replaceTrip!.body).success).toBe(true)
    expect(renameSchema.safeParse(EXAMPLES.renameTrip!.body).success).toBe(true)
    expect(updateUserSchema.safeParse(EXAMPLES.updateMe!.body).success).toBe(true)
  })

  it('fails loudly for an operation that has no example yet', () => {
    const extended = structuredClone(doc)
    extended.paths['/v1/new'] = { get: { operationId: 'newThing', summary: 'New', tags: ['Trips'] } }
    expect(() => buildBrunoFiles(extended)).toThrow(/No example for GET \/v1\/new/)
  })
})

describe('Bruno collection', () => {
  const files = buildBrunoFiles(doc)
  const requestFiles = Object.entries(files).filter(
    ([name]) => name.endsWith('.bru') && /^[A-Z][^/]*\//.test(name) && !name.endsWith('folder.bru'),
  )

  it('has one request per OpenAPI operation plus the operator export, in the same folders', () => {
    const operations = Object.values(doc.paths).flatMap((ops) => Object.values(ops))
    expect(requestFiles).toHaveLength(operations.length + 1)
    const folders = Object.keys(files)
      .filter((n) => n.endsWith('/folder.bru'))
      .map((n) => n.split('/')[0])
    expect(folders).toEqual(['Config', 'Health', 'Trips', 'Me', 'Admin'])
  })

  it('sends the collection bearer token by default and nothing on the public requests', () => {
    expect(files['collection.bru']).toContain('mode: bearer')
    expect(files['collection.bru']).toContain('token: {{token}}')
    for (const [name, content] of requestFiles) {
      const isPublic = name.startsWith('Config/') || name.startsWith('Health/')
      if (isPublic) expect(content, name).toContain('auth: none')
      else if (name.startsWith('Admin/')) expect(content, name).toContain('token: {{adminApiKey}}')
      else expect(content, name).toContain('auth: inherit')
    }
  })

  it('only uses variables an environment defines or a request sets', () => {
    const defined = new Set<string>([...BRUNO_ENVIRONMENT_VARIABLES, ...BRUNO_RUNTIME_VARIABLES])
    for (const [name, content] of requestFiles) {
      for (const v of content.match(/\{\{[^}]+\}\}/g) ?? []) {
        expect(defined.has(v.slice(2, -2)), `${name} ${v}`).toBe(true)
      }
    }
  })

  it('defines the four environments and keeps secret values out of them', () => {
    expect(Object.keys(BRUNO_ENVIRONMENTS)).toEqual(['local', 'dev', 'staging', 'prod'])
    for (const name of Object.keys(BRUNO_ENVIRONMENTS)) {
      const env = files[`environments/${name}.bru`]!
      for (const secret of BRUNO_SECRET_VARIABLES) {
        expect(env).toContain(`  ${secret}`)
        expect(env).not.toMatch(new RegExp(`^\\s*${secret}:`, 'm'))
      }
    }
  })

  it('keeps tripId and etag in step with the trip responses', () => {
    for (const [name, content] of requestFiles) {
      const sets = content.includes('bru.setVar("tripId"')
      expect(sets, name).toBe(/Create a trip|Get a trip|Replace a trip|Rename a trip/.test(name))
    }
  })

  it('matches the committed files in bruno/ byte for byte', () => {
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(`bruno/${name}`, 'utf8'), name).toBe(content)
    }
  })
})
