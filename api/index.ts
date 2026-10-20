// Vercel adapter (Node.js runtime). Thin on purpose: all wiring lives in src/deps.ts.
// Migrations are never run here, and nothing in CI or Vercel runs them: apply them with
// `npm run migrate` against the environment before the new code goes live.
import { handle } from 'hono/vercel'
import { createApp } from '../src/app.js'
import { buildDeps } from '../src/deps.js'
import { assertVercelConfig, loadConfig } from '../src/env.js'

// Built once per cold start. Refuses APP_ENV=local: Vercel is never local.
const handler = handle(createApp(buildDeps(assertVercelConfig(loadConfig(process.env)))))

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
export const HEAD = handler
