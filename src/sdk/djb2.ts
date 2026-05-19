/**
 * DJB2 hash — a fast, non-cryptographic hash function.
 *
 * Used for ETags, cache keys, and content fingerprinting throughout the framework.
 * Produces consistent unsigned 32-bit integers.
 */

/** Compute a DJB2 hash and return the raw unsigned 32-bit integer. */
export function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** Compute a DJB2 hash and return a base-36 string. */
export function djb2Hex(str: string): string {
  return djb2(str).toString(36);
}
