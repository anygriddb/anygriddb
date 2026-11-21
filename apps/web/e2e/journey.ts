// Every journey takes its `test` here. It is Playwright's own, unless
// E2E_COVERAGE_DIR is set (`pnpm test:e2e:coverage`): its pages then give
// their JavaScript coverage and what they reported as going wrong.
import { mergeProcessCovs, type ProcessCov } from "@bcoe/v8-coverage";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
  test as base,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { appScriptPath, pagePath } from "../lib/journey-coverage";

export * from "@playwright/test";

/** A document's coverage is lost when the page loads another. */
const TAKE_EVERY_MS = 1_500;

type Reader = { take: () => Promise<void>; stop: () => Promise<void> };

function measuredTest(dir: string): typeof base {
  mkdirSync(`${dir}/client-raw`, { recursive: true });
  mkdirSync(`${dir}/pages`, { recursive: true });
  const log = `${dir}/pages/${String(process.pid)}.jsonl`;
  const hooked = new WeakSet<BrowserContext>();
  const readers = new Map<Page, Reader>();
  let covered: ProcessCov = { result: [] };
  let title = "";

  const note = (
    kind: string,
    level: string,
    url: string,
    test: string,
    detail: string,
  ): void => {
    const line = { kind, level, test, url: pagePath(url), detail };
    appendFileSync(log, `${JSON.stringify(line)}\n`);
  };

  const watch = (page: Page): void => {
    page.on("console", (message) => {
      const type = message.type();
      if (type !== "error" && type !== "warning") return;
      note("console", type, page.url(), title, message.text().slice(0, 2000));
    });
    page.on("pageerror", (error) => {
      const stack = (error.stack ?? "").slice(0, 1500);
      const detail = `${error.name}: ${error.message}\n${stack}`;
      note("pageerror", "", page.url(), title, detail);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "";
      if (failure === "net::ERR_ABORTED") return;
      const detail = `${request.method()} ${pagePath(request.url())}`;
      note("requestfailed", failure, page.url(), title, detail);
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status < 400 && status !== 207) return;
      // The body arrives after the test may have ended: its name is kept.
      const test = title;
      const url = page.url();
      const asked = `${response.request().method()} ${pagePath(response.url())}`;
      void response
        .text()
        .catch(() => "")
        .then((body) => {
          const codes = [...body.matchAll(/"reason":\{"code":"([a-z_]+)"/g)];
          const said =
            codes.map((match) => match[1]).join(",") || body.slice(0, 200);
          note("http", String(status), url, test, `${asked} ${said}`);
        });
    });
  };

  const read = async (session: CDPSession): Promise<void> => {
    const { result } = await session.send("Profiler.takePreciseCoverage");
    const kept = result.flatMap((entry) => {
      const url = appScriptPath(entry.url);
      return url
        ? [{ scriptId: entry.scriptId, url, functions: entry.functions }]
        : [];
    });
    if (kept.length > 0) {
      covered = mergeProcessCovs([covered, { result: kept }]);
    }
  };

  const startReading = (page: Page): Reader => {
    const lost = (error: unknown): undefined => {
      // A page that closed under the question gave what it ran before.
      if (!page.isClosed()) {
        note("coverage", "lost", page.url(), title, String(error));
      }
      return undefined;
    };
    const ready = (async () => {
      const session = await page.context().newCDPSession(page);
      await session.send("Profiler.enable");
      await session.send("Profiler.startPreciseCoverage", {
        callCount: false,
        detailed: true,
      });
      return session;
    })().catch(lost);
    let taking: Promise<void> | undefined;
    const take = (): Promise<void> => {
      taking ??= ready
        .then((session) => (session ? read(session) : undefined))
        .catch(lost)
        .finally(() => {
          taking = undefined;
        });
      return taking;
    };
    const timer = setInterval(() => void take(), TAKE_EVERY_MS);
    timer.unref();
    page.once("close", () => {
      clearInterval(timer);
      readers.delete(page);
    });
    return {
      take,
      stop: async () => {
        clearInterval(timer);
        if (!page.isClosed()) await take();
      },
    };
  };

  const finish = async (page: Page): Promise<void> => {
    const reader = readers.get(page);
    readers.delete(page);
    await reader?.stop();
  };

  const startPage = (page: Page): void => {
    const reader = startReading(page);
    readers.set(page, reader);
    watch(page);
    const close = page.close.bind(page);
    page.close = async (options) => {
      await finish(page);
      return close(options);
    };
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      await reader.take();
      return goto(url, options);
    };
    const reload = page.reload.bind(page);
    page.reload = async (options) => {
      await reader.take();
      return reload(options);
    };
  };

  const hook = (context: BrowserContext): void => {
    if (hooked.has(context)) return;
    hooked.add(context);
    context.pages().forEach(startPage);
    context.on("page", startPage);
    const close = context.close.bind(context);
    context.close = async (options) => {
      await Promise.all(context.pages().map(finish));
      return close(options);
    };
  };

  return base.extend<{ measuredTest: void }, { measuredWorker: void }>({
    measuredWorker: [
      async ({ browser }, use, workerInfo) => {
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (options) => {
          const context = await newContext(options);
          hook(context);
          return context;
        };
        await use();
        const name = `${String(workerInfo.workerIndex)}-${String(process.pid)}`;
        writeFileSync(
          `${dir}/client-raw/${name}.json`,
          JSON.stringify(covered),
        );
      },
      { scope: "worker", auto: true },
    ],
    // It asks for the context so that it ends before the context closes.
    measuredTest: [
      async ({ context }, use, testInfo) => {
        hook(context);
        title = testInfo.titlePath.slice(1).join(" › ");
        await use();
        await Promise.all([...readers.keys()].map(finish));
      },
      { auto: true },
    ],
  }) as unknown as typeof base;
}

const coverageDir = process.env.E2E_COVERAGE_DIR;

export const test = coverageDir ? measuredTest(coverageDir) : base;
