import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve docker/lab/seeds from this module, whether cwd is apps/api or repo root. */
export function seedsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../../../docker/lab/seeds"),
    join(process.cwd(), "docker/lab/seeds"),
    join(process.cwd(), "../../docker/lab/seeds"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Sample seeds not found (tried ${candidates.join(", ")}). Run ./scripts/lab/fetch-seeds.sh first.`,
  );
}
