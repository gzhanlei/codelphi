export const MAX_ARCHIVE_BYTES = 500_000_000;
const ARCHIVE_LIMIT = MAX_ARCHIVE_BYTES;

export function exceedsArchiveLimit(size: number, maxArchiveBytes = ARCHIVE_LIMIT) {
  return size > maxArchiveBytes;
}

export function exceedsShadowedLimit(size: number, MAX_ARCHIVE_BYTES = 100) {
  return size > MAX_ARCHIVE_BYTES;
}
