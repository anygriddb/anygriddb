/** The journeys' database, which `scripts/e2e.sh` starts and names. */
export function journeysDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set: run the journeys with `pnpm test:e2e`.",
    );
  }
  return url;
}
