/**
 * src/util/paths.ts — cross-platform display-path helper.
 *
 * pgwen normalises paths to forward slashes wherever they are DISPLAYED
 * (HTML/JSON reports, error messages, scope bindings such as
 * `pgwen.feature.file.path`) so that:
 *   - reports are byte-consistent across OSes and match unix-generated
 *     reference reports (report parity), and
 *   - pgwen's own behaviour is identical on Windows / macOS / Linux.
 *
 * Node's `fs` accepts forward slashes on Windows, so a normalised path is
 * still valid for file I/O — this is purely about consistent presentation.
 * Do NOT use this to build paths for the OS shell; use `path.*` for that.
 */
export function toPosixPath(p: string): string {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}
