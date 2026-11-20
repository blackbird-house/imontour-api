/**
 * Builds the Bruno collection (bruno/, plain-text `.bru` files) from the OpenAPI document and EXAMPLES, so the
 * requests cannot drift from the API.
 * Open the `bruno/` folder in Bruno ("Open Collection") and pick an environment (local, dev, staging, prod).
 */
import {
  DEPLOYED_BASE_URL,
  EXAMPLES,
  METHODS,
  toRequestPath,
  type Example,
  type OpenApiDocument,
  type Operation,
} from './collection.js'

/** Variables Bruno requests may use. `tripId` and `etag` are set by the requests themselves (runtime variables). */
export const BRUNO_ENVIRONMENT_VARIABLES = ['baseUrl', 'token', 'adminApiKey', 'appleAuthCode'] as const
export const BRUNO_RUNTIME_VARIABLES = ['tripId', 'etag'] as const

/** Secret variables: Bruno keeps their values in the app (never in the .bru file, so never in git). */
export const BRUNO_SECRET_VARIABLES = ['token', 'adminApiKey', 'appleAuthCode'] as const

/** The environments the API has (README, "Environments"). staging and prod have no deployed URL yet. */
export const BRUNO_ENVIRONMENTS: Record<string, string> = {
  local: 'http://localhost:3000',
  dev: DEPLOYED_BASE_URL,
  staging: 'https://imontour-staging.invalid',
  prod: 'https://imontour-prod.invalid',
}

/** Not in openapi.yaml on purpose (the iOS app never calls it), so it is described here. Own folder, own secret. */
const ADMIN_FOLDER = 'Admin'
const ADMIN_EXPORT = {
  name: 'Export user data (operator only)',
  docs: [
    'Answers an access/portability request by email. Only exists where ADMIN_API_KEY is set on the environment (otherwise 404).',
    'Authenticates with the operator key in the `adminApiKey` environment secret, not a user token.',
    'Verify the requester before replying, and send the file through a secure channel.',
  ].join('\n\n'),
  body: { email: 'person@example.com' },
}

const SET_TRIP_VARS = [
  '// Keeps {{tripId}} and {{etag}} up to date for the next request.',
  'if (res.getStatus() < 300) {',
  '  bru.setVar("tripId", res.getBody().id);',
  '  bru.setVar("etag", res.getHeader("etag"));',
  '}',
]

const indent = (text: string, spaces = 2) =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
    .join('\n')

const block = (name: string, lines: string[]) => `${name} {\n${lines.map((l) => indent(l)).join('\n')}\n}\n`

function fileName(title: string): string {
  return `${title
    .replace(/[^A-Za-z0-9 ()-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()}.bru`
}

type BruRequest = {
  name: string
  seq: number
  method: string
  url: string
  auth: 'inherit' | 'none' | 'bearer'
  bearerVar?: string
  query?: { key: string; value: string; disabled?: true }[]
  headers: { key: string; value: string; disabled?: true }[]
  body?: unknown
  script?: string[]
  docs?: string
}

function renderRequest(r: BruRequest): string {
  const parts: string[] = [
    block('meta', [`name: ${r.name}`, 'type: http', `seq: ${r.seq}`]),
    block(r.method.toLowerCase(), [
      `url: ${r.url}`,
      `body: ${r.body === undefined ? 'none' : 'json'}`,
      `auth: ${r.auth}`,
    ]),
  ]
  if (r.query?.length) {
    parts.push(
      block(
        'params:query',
        r.query.map((q) => `${q.disabled ? '~' : ''}${q.key}: ${q.value}`),
      ),
    )
  }
  parts.push(
    block(
      'headers',
      r.headers.map((h) => `${h.disabled ? '~' : ''}${h.key}: ${h.value}`),
    ),
  )
  if (r.auth === 'bearer') parts.push(block('auth:bearer', [`token: {{${r.bearerVar}}}`]))
  if (r.body !== undefined) parts.push(block('body:json', JSON.stringify(r.body, null, 2).split('\n')))
  if (r.script) parts.push(block('script:post-response', r.script))
  if (r.docs) parts.push(block('docs', r.docs.split('\n')))
  return parts.join('\n')
}

function fromOperation(path: string, method: string, op: Operation, example: Example, seq: number): BruRequest {
  const query = example.query?.map((q) => ({
    key: q.key,
    value: q.value,
    ...(q.disabled ? { disabled: true as const } : {}),
  }))
  const enabled = (query ?? []).filter((q) => !q.disabled)
  const queryString = enabled.length > 0 ? `?${enabled.map((q) => `${q.key}=${q.value}`).join('&')}` : ''
  const isPublic = Array.isArray(op.security) && op.security.length === 0
  const headers = [...(example.headers ?? [])].map((h) => ({
    key: h.key,
    // The Apple authorization code is a secret variable, not a blank value.
    value: h.key === 'X-Apple-Authorization-Code' ? '{{appleAuthCode}}' : h.value,
    ...(h.disabled ? { disabled: true as const } : {}),
  }))
  if (example.body !== undefined) headers.push({ key: 'Content-Type', value: 'application/json' })
  headers.push({ key: 'Accept', value: 'application/json' })
  return {
    name: op.summary ?? op.operationId,
    seq,
    method,
    url: `{{baseUrl}}/${toRequestPath(path).join('/')}${queryString}`,
    auth: isPublic ? 'none' : 'inherit',
    query,
    headers,
    body: example.body,
    script: example.script === 'captureTrip' ? SET_TRIP_VARS : undefined,
    docs: [op.summary, op.description].filter(Boolean).join('\n\n'),
  }
}

function environmentFile(baseUrl: string): string {
  return [
    block('vars', [`baseUrl: ${baseUrl}`]),
    `vars:secret [\n${BRUNO_SECRET_VARIABLES.map((v) => `  ${v}`).join(',\n')}\n]\n`,
  ].join('\n')
}

const COLLECTION_FILE = [
  block('docs', [
    'Generated from openapi.yaml by `npm run collection`; do not edit by hand (CI fails if it is out of date).',
    '',
    'Pick an environment (local, dev, staging, prod), then set its secrets in Bruno (they are never stored in git):',
    '- token: local server: run `npm run -s token` and paste the output. Deployed: the access_token of a Supabase test user.',
    '- adminApiKey: only for the Admin folder (the operator key, ADMIN_API_KEY on that environment).',
    '- appleAuthCode: optional, a fresh Sign in with Apple authorization code for "Delete the account".',
    '',
    'tripId and etag are filled in by the trip requests themselves (run "Create a trip" first).',
  ]),
  block('auth', ['mode: bearer']),
  block('auth:bearer', ['token: {{token}}']),
].join('\n')

/** Every file the generator owns, by path relative to the bruno/ folder. */
export function buildBrunoFiles(doc: OpenApiDocument): Record<string, string> {
  const files: Record<string, string> = {
    'bruno.json': `${JSON.stringify({ version: '1', name: doc.info.title, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2)}\n`,
    'collection.bru': COLLECTION_FILE,
  }
  for (const [name, baseUrl] of Object.entries(BRUNO_ENVIRONMENTS))
    files[`environments/${name}.bru`] = environmentFile(baseUrl)

  const folders = new Map<string, BruRequest[]>()
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
      const folder = op.tags?.[0] ?? 'Other'
      const list = folders.get(folder) ?? []
      list.push(fromOperation(path, method, op, example, list.length + 1))
      folders.set(folder, list)
    }
  }
  for (const id of Object.keys(EXAMPLES)) {
    if (!seen.has(id)) throw new Error(`EXAMPLES has an entry for ${id}, which is not an operation in openapi.yaml.`)
  }

  folders.set(ADMIN_FOLDER, [
    {
      name: ADMIN_EXPORT.name,
      seq: 1,
      method: 'POST',
      url: '{{baseUrl}}/v1/admin/export',
      auth: 'bearer',
      bearerVar: 'adminApiKey',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Accept', value: 'application/json' },
      ],
      body: ADMIN_EXPORT.body,
      docs: ADMIN_EXPORT.docs,
    },
  ])

  let folderSeq = 0
  for (const [folder, requests] of folders) {
    files[`${folder}/folder.bru`] = block('meta', [`name: ${folder}`, `seq: ${++folderSeq}`])
    for (const r of requests) files[`${folder}/${fileName(r.name)}`] = renderRequest(r)
  }
  return files
}
