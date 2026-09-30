/**
 * Headless shim for the browser-only `file-saver` package. The export builders
 * import { saveAs } at module top-level but the headless script only calls the
 * pure build functions, so this never executes.
 */
export function saveAs(_blob: unknown, _name?: string): void {
  throw new Error("saveAs is browser-only; headless export never calls it.");
}
export default { saveAs };
