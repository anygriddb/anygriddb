/** What `pnpm test:e2e:coverage` reads of a page and of its reports. */

export type CoverageFile = {
  s: Record<string, number>;
  f: Record<string, number>;
};

export type CoverageTotals = {
  files: number;
  statements: number;
  statementsRun: number;
  functions: number;
  functionsRun: number;
};

const RECORD_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The path of a script the app's build made; null for anything else. */
export function appScriptPath(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const { pathname } = new URL(url);
  return /^\/assets\/[^/]+\.js$/.test(pathname) ? pathname : null;
}

/** A page's path with its ids taken out, so that its reports group. */
export function pagePath(url: string): string {
  if (!URL.canParse(url)) return url;
  return new URL(url).pathname.replace(RECORD_ID, "<id>");
}

export function coverageTotals(files: Iterable<CoverageFile>): CoverageTotals {
  const totals: CoverageTotals = {
    files: 0,
    statements: 0,
    statementsRun: 0,
    functions: 0,
    functionsRun: 0,
  };
  for (const file of files) {
    const statements = Object.values(file.s);
    const functions = Object.values(file.f);
    totals.files += 1;
    totals.statements += statements.length;
    totals.statementsRun += statements.filter((count) => count > 0).length;
    totals.functions += functions.length;
    totals.functionsRun += functions.filter((count) => count > 0).length;
  }
  return totals;
}
