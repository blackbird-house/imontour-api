import { readFileSync } from 'node:fs'
import { createApp } from './app.js'
import { stringify } from 'yaml'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

const unused = (): never => {
  throw new Error('OpenAPI generation must not call dependencies')
}

const DESCRIPTION =
  'REST API for Imontour trips. A trip is a document: it is read and replaced as a whole, ' +
  'with the revision as optimistic-concurrency token (ETag / If-Match). Trips and /v1/me require a ' +
  'JWT from the configured identity provider (Supabase today) sent as a Bearer token; the first ' +
  'authenticated request creates the user. GET /v1/config is public. Clients must accept unknown ' +
  '`color`, `place.type` and `timing.mode` values, since new ones may be added without a version bump.'

/** Builds the OpenAPI 3.1 document from the real route declarations. No I/O besides package.json. */
export function buildOpenApiDocument(): object {
  const app = createApp({
    repo: new Proxy({}, { get: () => unused }) as never,
    users: new Proxy({}, { get: () => unused }) as never,
    verify: unused,
    resolveUser: unused,
    identityAdmin: new Proxy({}, { get: () => unused }) as never,
    remoteConfig: unused,
  })
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'Imontour API', version: pkg.version, description: DESCRIPTION },
    servers: [{ url: '/', description: 'Same origin' }],
  })
}

/**
 * Deterministic YAML serialization: 2-space indent, no line folding, no anchors or aliases
 * (shared objects are written out in full so every generator reads them), generation key order.
 */
export function formatOpenApiDocument(doc: object): string {
  return stringify(doc, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false })
}
