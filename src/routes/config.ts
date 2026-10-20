/** Supplies the remote config document and its ETag (content hash). */
export type RemoteConfigSource = () => Promise<{ body: unknown; etag: string }>
