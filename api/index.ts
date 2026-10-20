// Vercel adapter (Node.js runtime). Thin on purpose: all wiring lives in src/deps.ts.
// Migrations are never run here; deploys run `npm run migrate`.
import { handle } from 'hono/vercel'
import { createApp } from '../src/app.js'
import { buildDeps } from '../src/deps.js'
import { loadConfig } from '../src/env.js'

// Built once per cold start.
const handler = handle(createApp(buildDeps(loadConfig(process.env))))

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
export const HEAD = handler
