/**
 * Builds an API client collection (Postman Collection v2.1, which RapidAPI, Postman, Insomnia and Bruno all
 * import) and its environments from the OpenAPI document, so the requests cannot drift from the API.
 * What the document cannot say (realistic example bodies, the value of `If-Match`) lives in EXAMPLES below;
 * the build fails for an operation that has no entry, so adding an endpoint forces the example to be written.
 */

type Json = Record<string, unknown>
type Operation = { operationId: string; summary?: string; description?: string; tags?: string[]; security?: unknown[] }
type OpenApiDocument = {
  info: { title: string }
  paths: Record<string, Record<string, Operation>>
}
type Header = { key: string; value: string; description?: string; disabled?: true }
type Query = Header
type Example = { query?: Query[]; headers?: Header[]; body?: unknown; script?: 'captureTrip' }

const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const

/** Variables the requests use. `tripId` and `etag` are filled by the collection scripts (or by hand). */
export const ENVIRONMENT_VARIABLES = ['baseUrl', 'token'] as const
export const COLLECTION_VARIABLES = ['baseUrl', 'token', 'tripId', 'etag'] as const

// Fixed ids keep the collection deterministic (and valid UUIDs, which Postman dynamic variables would not be elsewhere).
const TOKYO_ID = '3f1c2b8e-6a47-4d0e-9f5b-1c2d3e4f5a61'
const LISBON_ID = '7a9d4c10-2b3e-4f65-8a71-9b0c1d2e3f42'

const tokyo = {
  id: TOKYO_ID,
  rawInput: 'tokyo 5 days',
  color: 'coral',
  place: { displayName: 'Tokyo', type: 'city', latitude: 35.68, longitude: 139.69, countryCode: 'JP' },
  timing: {
    mode: 'explicitDates',
    startDay: '2027-04-01',
    endDay: '2027-04-05',
    durationDays: 5,
    isPlaceholder: false,
  },
}

const lisbon = {
  id: LISBON_ID,
  rawInput: 'lisbon 4 days',
  color: 'teal',
  place: { displayName: 'Lisbon', type: 'city', latitude: 38.72, longitude: -9.14, countryCode: 'PT' },
  timing: { mode: 'durationOnly', durationDays: 4, isPlaceholder: false },
}

const lisbonInMay = {
  ...lisbon,
  timing: { mode: 'fuzzyMonth', targetYear: 2027, targetMonth: 5, isPlaceholder: false },
}

export const EXAMPLES: Record<string, Example> = {
  getConfig: {
    headers: [
      {
        key: 'If-None-Match',
        value: '',
        description: 'Send the ETag from a previous response to get 304 when nothing changed.',
        disabled: true,
      },
    ],
  },
  listTrips: {
    query: [
      { key: 'limit', value: '20', description: 'Page size, 1-100.' },
      { key: 'cursor', value: '', description: 'nextCursor from the previous page.', disabled: true },
    ],
  },
  createTrip: {
    script: 'captureTrip',
    body: { schemaVersion: 1, name: 'Japan and Portugal', destinations: [tokyo, lisbon] },
  },
  getTrip: { script: 'captureTrip' },
  replaceTrip: {
    script: 'captureTrip',
    headers: [
      {
        key: 'If-Match',
        value: '{{etag}}',
        description: 'Required. The ETag of the revision you are replacing (a stale one gets 412).',
      },
    ],
    body: { schemaVersion: 1, name: 'Japan and Portugal (revised)', destinations: [tokyo, lisbonInMay] },
  },
  renameTrip: { script: 'captureTrip', body: { name: 'Japan and Portugal, renamed' } },
  deleteTrip: {},
  getMe: {},
  updateMe: { body: { displayName: 'Test User', locale: 'en-GB' } },
  deleteMe: {},
}

const CAPTURE_TRIP_SCRIPT = [
  '// Postman only: keeps {{tripId}} and {{etag}} up to date for the next request. Other clients ignore this.',
  'if (pm.response.code < 300) {',
  '  const trip = pm.response.json();',
  "  pm.collectionVariables.set('tripId', trip.id);",
  "  pm.collectionVariables.set('etag', pm.response.headers.get('ETag'));",
  '}',
]

const DEPLOYED_BASE_URL = 'https://imontour-api.vercel.app'
const COLLECTION_ID = '5b0c8e2a-4d6f-4a31-9c7e-2f1a0b9d8c71'
const LOCAL_ENV_ID = '0e6d1f3b-8a2c-4b97-a5d4-7c9e1b2a3f80'
const DEPLOYED_ENV_ID = '9a4b7c5d-1e3f-4062-b8a9-0d2c4e6f8a13'

const DESCRIPTION = [
  'Generated from openapi.yaml by `npm run collection`; do not edit by hand (CI fails if it is out of date).',
  '',
  'Setup: import this collection, then set the `token` variable (kept empty in the repo). The `baseUrl` variable',
  'defaults to the deployed API; the environment files (local, deployed) are optional and override both.',
  '- Local server: run `npm run token` and paste the output.',
  '- Deployed API: sign in a test user and use the access token (see "API client" in the README).',
  '',
  '`tripId` and `etag` are filled in by the requests themselves in Postman; in other clients copy them by hand',
  'from the previous response (`id` and the `ETag` header).',
].join('\n')

function toRequestPath(openApiPath: string): string[] {
  return openApiPath
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment === '{id}' ? '{{tripId}}' : segment))
}

function buildRequest(path: string, method: string, op: Operation, example: Example): Json {
  const segments = toRequestPath(path)
  const enabledQuery = (example.query ?? []).filter((q) => !q.disabled)
  const queryString = enabledQuery.length > 0 ? `?${enabledQuery.map((q) => `${q.key}=${q.value}`).join('&')}` : ''
  const isPublic = Array.isArray(op.security) && op.security.length === 0

  const headers: Header[] = [...(example.headers ?? [])]
  if (example.body !== undefined) headers.push({ key: 'Content-Type', value: 'application/json' })
  headers.push({ key: 'Accept', value: 'application/json' })

  const request: Json = {
    method: method.toUpperCase(),
    header: headers,
    url: {
      raw: `{{baseUrl}}/${segments.join('/')}${queryString}`,
      host: ['{{baseUrl}}'],
      path: segments,
      ...(example.query ? { query: example.query } : {}),
    },
    description: [op.summary, op.description].filter(Boolean).join('\n\n'),
  }
  if (isPublic) request.auth = { type: 'noauth' }
  if (example.body !== undefined) {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(example.body, null, 2),
      options: { raw: { language: 'json' } },
    }
  }
  return request
}

export function buildCollection(doc: OpenApiDocument): Json {
  const folders = new Map<string, Json[]>()
  const seen = new Set<string>()

  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = operations[method]
      if (!op) continue
      const example = EXAMPLES[op.operationId]
      if (!example) {
        throw new Error(
          `No example for ${method.toUpperCase()} ${path} (${op.operationId}). Add an entry to EXAMPLES in src/collection.ts.`,
        )
      }
      seen.add(op.operationId)
      const item: Json = {
        name: op.summary ?? op.operationId,
        request: buildRequest(path, method, op, example),
      }
      if (example.script === 'captureTrip') {
        item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: CAPTURE_TRIP_SCRIPT } }]
      }
      const folder = op.tags?.[0] ?? 'Other'
      folders.set(folder, [...(folders.get(folder) ?? []), item])
    }
  }

  for (const id of Object.keys(EXAMPLES)) {
    if (!seen.has(id)) throw new Error(`EXAMPLES has an entry for ${id}, which is not an operation in openapi.yaml.`)
  }

  return {
    info: {
      _postman_id: COLLECTION_ID,
      name: doc.info.title,
      description: DESCRIPTION,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    // `baseUrl` and `token` are also defined here, not only in the environments, because a collection
    // file never carries its environments: clients that import just the collection (RapidAPI does) still
    // get the variables. A selected environment overrides these. The token stays empty in the repo.
    variable: [
      { key: 'baseUrl', value: DEPLOYED_BASE_URL },
      { key: 'token', value: '' },
      { key: 'tripId', value: '' },
      { key: 'etag', value: '"1"' },
    ],
    item: [...folders.entries()].map(([name, item]) => ({ name, item })),
  }
}

function environment(id: string, name: string, baseUrl: string): Json {
  return {
    id,
    name,
    values: [
      { key: 'baseUrl', value: baseUrl, type: 'default', enabled: true },
      { key: 'token', value: '', type: 'secret', enabled: true },
    ],
    _postman_variable_scope: 'environment',
  }
}

export function buildEnvironments(): Record<string, Json> {
  return {
    'local.postman_environment.json': environment(LOCAL_ENV_ID, 'Imontour API (local)', 'http://localhost:3000'),
    'deployed.postman_environment.json': environment(DEPLOYED_ENV_ID, 'Imontour API (deployed)', DEPLOYED_BASE_URL),
  }
}

/** Deterministic serialization: 2-space indent, trailing newline, generation key order. */
export function formatCollectionFile(doc: object): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Every file the generator owns, by path relative to the postman/ folder. */
export function buildCollectionFiles(doc: OpenApiDocument): Record<string, string> {
  const files: Record<string, string> = {
    'imontour-api.postman_collection.json': formatCollectionFile(buildCollection(doc)),
  }
  for (const [name, env] of Object.entries(buildEnvironments())) files[name] = formatCollectionFile(env)
  return files
}
