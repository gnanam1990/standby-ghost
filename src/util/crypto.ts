import { createHash, randomBytes } from 'node:crypto';

/** Random id with a short type prefix, e.g. "prod_x7q...". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/** Bearer token for owner/session authentication. Raw value is never stored. */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
