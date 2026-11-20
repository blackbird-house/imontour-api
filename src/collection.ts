/**
 * The request examples and shared helpers behind the Bruno collection (src/bruno.ts), which is built from the
 * OpenAPI document so the requests cannot drift from the API.
 * What the document cannot say (realistic example bodies, the value of `If-Match`) lives in EXAMPLES below;
 * the build fails for an operation that has no entry, so adding an endpoint forces the example to be written.
 */

export type Operation = {
  operationId: string
  summary?: string
  description?: string
  tags?: string[]
  security?: unknown[]
}
export type OpenApiDocument = {
  info: { title: string }
  paths: Record<string, Record<string, Operation>>
}
type Header = { key: string; value: string; description?: string; disabled?: true }
type Query = Header
export type Example = { query?: Query[]; headers?: Header[]; body?: unknown; script?: 'captureTrip' }

export const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const

// Fixed ids keep the collection deterministic (and valid UUIDs).
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
  getHealth: {},
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
  deleteMe: {
    headers: [
      {
        key: 'X-Apple-Authorization-Code',
        value: '',
        description:
          'Apps that signed in with Apple send a fresh authorization code so the server can revoke the Apple token.',
        disabled: true,
      },
    ],
  },
}

export const DEPLOYED_BASE_URL = 'https://imontour-api.vercel.app'

export function toRequestPath(openApiPath: string): string[] {
  return openApiPath
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment === '{id}' ? '{{tripId}}' : segment))
}
