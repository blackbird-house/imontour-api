/**
 * Builds the Bruno collection (bruno/, OpenCollection YAML: `opencollection.yml` and `.yml` files) from the OpenAPI document and EXAMPLES, so the
 * requests cannot drift from the API.
 * Open the `bruno/` folder in Bruno as a workspace (it holds the collection) and pick an environment (local, dev, staging, prod).
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

/** Secret variables: Bruno keeps their values in the app (never in the environment file, so never in git). */
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
].join('\n')

/** A YAML scalar: JSON strings are valid double-quoted YAML, so quoting is always safe. */
const str = (value: string) => JSON.stringify(value)

/** A multi-line text as a literal block (`|-`) whose lines sit `spaces` deeper than the key. */
const lines = (text: string, spaces: number) =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
    .join('\n')

const block = (key: string, text: string, spaces: number) => `${key}: |-\n${lines(text, spaces + 2)}`

function fileName(title: string): string {
  return `${title
    .replace(/[^A-Za-z0-9 ()-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()}.yml`
}

type Entry = { key: string; value: string; disabled?: true }

type BruRequest = {
  name: string
  seq: number
  method: string
  url: string
  auth: 'inherit' | 'none' | 'bearer'
  bearerVar?: string
  query?: Entry[]
  headers: Entry[]
  body?: unknown
  script?: string
  docs?: string
}

function renderRequest(r: BruRequest): string {
  const http = [`  method: ${r.method.toUpperCase()}`, `  url: ${str(r.url)}`]
  if (r.query?.length) {
    http.push('  params:')
    for (const q of r.query) {
      http.push(`    - name: ${str(q.key)}`, `      value: ${str(q.value)}`, '      type: query')
      if (q.disabled) http.push('      disabled: true')
    }
  }
  http.push('  headers:')
  for (const h of r.headers) {
    http.push(`    - name: ${str(h.key)}`, `      value: ${str(h.value)}`)
    if (h.disabled) http.push('      disabled: true')
  }
  if (r.body !== undefined) {
    http.push('  body:', '    type: json', `    ${block('data', JSON.stringify(r.body, null, 2), 4)}`)
  }
  if (r.auth === 'bearer') http.push('  auth:', '    type: bearer', `    token: ${str(`{{${r.bearerVar}}}`)}`)
  else http.push(`  auth: ${r.auth}`)

  const parts = [
    ['info:', `  name: ${str(r.name)}`, '  type: http', `  seq: ${r.seq}`].join('\n'),
    ['http:', ...http].join('\n'),
  ]
  if (r.script) {
    parts.push(
      ['runtime:', '  scripts:', '    - type: after-response', `      ${block('code', r.script, 6)}`].join('\n'),
    )
  }
  parts.push('settings:\n  encodeUrl: true')
  if (r.docs) parts.push(block('docs', r.docs, 0))
  return `${parts.join('\n\n')}\n`
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
  const headers: Entry[] = [...(example.headers ?? [])].map((h) => ({
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

const VARIABLE_DESCRIPTIONS: Record<(typeof BRUNO_SECRET_VARIABLES)[number], string> = {
  token: 'Access token of a test user (local: npm run -s token). Sent as the bearer token.',
  adminApiKey: 'Operator key (ADMIN_API_KEY on that environment). Only for the Admin folder.',
  appleAuthCode: 'Optional fresh Sign in with Apple authorization code for "Delete the account".',
}

function environmentFile(name: string, baseUrl: string): string {
  return [
    `name: ${name}`,
    'variables:',
    '  - name: baseUrl',
    `    value: ${str(baseUrl)}`,
    ...BRUNO_SECRET_VARIABLES.flatMap((v) => [
      '  - secret: true',
      `    name: ${v}`,
      `    description: ${str(VARIABLE_DESCRIPTIONS[v])}`,
    ]),
  ].join('\n')
}

const COLLECTION_DOCS = [
  'Generated from openapi.yaml by `npm run collection`; do not edit by hand (CI fails if it is out of date).',
  '',
  'Pick an environment (local, dev, staging, prod), then set its secrets in Bruno (they are never stored in git):',
  '- token: local server: run `npm run -s token` and paste the output. Deployed: the access_token of a Supabase test user.',
  '- adminApiKey: only for the Admin folder (the operator key, ADMIN_API_KEY on that environment).',
  '- appleAuthCode: optional, a fresh Sign in with Apple authorization code for "Delete the account".',
  '',
  'tripId and etag are filled in by the trip requests themselves (run "Create a trip" first).',
].join('\n')

function collectionFile(title: string): string {
  return [
    'opencollection: 1.0.0',
    ['info:', `  name: ${str(title)}`].join('\n'),
    ['request:', '  auth:', '    type: bearer', `    token: ${str('{{token}}')}`].join('\n'),
    block('docs', COLLECTION_DOCS, 0),
    ['extensions:', '  bruno:', '    ignore:', '      - node_modules', '      - .git'].join('\n'),
  ].join('\n\n')
}

/** Where the collection lives inside the workspace (bruno/). */
export const COLLECTION_DIR = 'collections/imontour-api'

/** Every file of the collection, by path relative to the collection folder. */
export function buildBrunoCollectionFiles(doc: OpenApiDocument): Record<string, string> {
  const files: Record<string, string> = { 'opencollection.yml': `${collectionFile(doc.info.title)}\n` }
  for (const [name, baseUrl] of Object.entries(BRUNO_ENVIRONMENTS)) {
    files[`environments/${name}.yml`] = `${environmentFile(name, baseUrl)}\n`
  }

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
    files[`${folder}/folder.yml`] = `info:\n  name: ${str(folder)}\n  type: folder\n  seq: ${++folderSeq}\n`
    for (const r of requests) files[`${folder}/${fileName(r.name)}`] = renderRequest(r)
  }
  return files
}

/** The workspace file: open the bruno/ folder as a workspace in Bruno and the collection is already in it. */
function workspaceFile(title: string): string {
  return [
    'opencollection: 1.0.0',
    ['info:', '  name: "Imontour"', '  type: workspace'].join('\n'),
    ['collections:', `  - name: ${str(title)}`, `    path: ${str(COLLECTION_DIR)}`].join('\n'),
  ].join('\n\n')
}

/** Every file the generator owns, by path relative to the bruno/ folder (the workspace). */
export function buildBrunoFiles(doc: OpenApiDocument): Record<string, string> {
  const files: Record<string, string> = { 'workspace.yml': `${workspaceFile(doc.info.title)}\n` }
  for (const [name, content] of Object.entries(buildBrunoCollectionFiles(doc))) {
    files[`${COLLECTION_DIR}/${name}`] = content
  }
  return files
}
