import { z } from '@hono/zod-openapi'
import { text } from './trip.js'

export const MAX_DISPLAY_NAME_LENGTH = 100
export const MAX_LOCALE_LENGTH = 35

// BCP 47-shaped (en, en-GB, zh-Hans-CN); iOS may send `_` as separator, which is accepted as is.
const LOCALE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/

export const userSchema = z
  .object({
    id: z.uuid().openapi({ description: 'Our own user id (not the identity provider subject).' }),
    displayName: z.string().nullable(),
    email: z
      .string()
      .nullable()
      .openapi({ description: 'Copied from the token at first sign-in; informational only.' }),
    locale: z.string().nullable().openapi({ example: 'en-GB' }),
    createdAt: z.iso.datetime().openapi({ example: '2026-10-20T09:00:00.000Z' }),
    updatedAt: z.iso.datetime().openapi({ example: '2026-10-20T09:00:00.000Z' }),
  })
  .openapi('User')

export const updateUserSchema = z
  .object({
    displayName: text
      .max(MAX_DISPLAY_NAME_LENGTH)
      .nullable()
      .optional()
      .openapi({
        description: `Up to ${MAX_DISPLAY_NAME_LENGTH} characters. \`null\` clears it; absent leaves it unchanged.`,
      }),
    locale: text
      .max(MAX_LOCALE_LENGTH)
      .regex(LOCALE, 'Expected a BCP 47 language tag such as en or en-GB')
      .nullable()
      .optional()
      .openapi({
        description: 'BCP 47 language tag. `null` clears it; absent leaves it unchanged.',
        example: 'en-GB',
      }),
  })
  .refine((v) => v.displayName !== undefined || v.locale !== undefined, 'Send at least one of displayName, locale')
  .openapi('UpdateUser')

export type User = z.infer<typeof userSchema>
export type UpdateUser = z.infer<typeof updateUserSchema>
