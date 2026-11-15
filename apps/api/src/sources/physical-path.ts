import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The path after every symlink is followed. Segments that do not exist
 * yet (a SQLite file not created) keep their names under the deepest
 * ancestor that does, so a link under an allowed prefix cannot point
 * outside it.
 */
export function physicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const missing: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
  const root = realpathSync(current);
  return missing.length === 0 ? root : path.join(root, ...missing);
}
