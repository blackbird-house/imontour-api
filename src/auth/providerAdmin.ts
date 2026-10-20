import type { Identity } from './verifier.js'

/**
 * Provider-side account cleanup, used when a user deletes their account. The
 * only code that talks to an identity provider's admin API sits behind this port.
 * Deleting an identity the provider does not know (already gone) must succeed.
 */
export interface IdentityProviderAdmin {
  deleteIdentity(identity: Identity): Promise<void>
}

/** For local development and for deployments with no admin credentials configured. */
export function createNoopIdentityAdmin(): IdentityProviderAdmin {
  return { deleteIdentity: async () => {} }
}
