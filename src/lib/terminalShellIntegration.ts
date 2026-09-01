/**
 * The last path segment, for a tab label.
 *
 * Falls back to the whole path for a root, which is the only case where the
 * last segment is empty and the path still means something.
 */
export function workingDirectoryLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
