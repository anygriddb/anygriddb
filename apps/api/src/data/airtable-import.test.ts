import { describe, expect, it } from "vitest";
import { readAirtableBase } from "./airtable-import.js";

const meta = {
  tables: [
    {
      id: "tblA",
      name: "Clients",
      primaryFieldId: "fld1",
      fields: [{ id: "fld1", name: "Name", type: "singleLineText" }],
      views: [{ id: "viw1", name: "Grid view", type: "grid" }],
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readAirtableBase", () => {
  it("reads the schema, then every page, waiting when Airtable asks", async () => {
    const calls: string[] = [];
    const headers: string[] = [];
    let limited = false;
    const fetcher = ((url: string, init?: RequestInit) => {
      calls.push(url.replace("https://api.airtable.com/v0", ""));
      headers.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.includes("/meta/")) return Promise.resolve(json(meta));
      if (!url.includes("offset=")) {
        if (!limited) {
          limited = true;
          return Promise.resolve(json({ errors: [] }, 429));
        }
        return Promise.resolve(
          json({
            records: [{ id: "rec1", fields: { fld1: "Acme" } }],
            offset: "p2",
          }),
        );
      }
      return Promise.resolve(json({ records: [{ id: "rec2", fields: {} }] }));
    }) as typeof fetch;
    const waits: number[] = [];
    const progress: string[] = [];
    const base = await readAirtableBase(
      "patSECRET.token1234567890abcdef",
      "appAAAAAAAAAAAAAA",
      {
        fetcher,
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        onProgress: (done, total) => {
          progress.push(`${String(done)}/${String(total)}`);
          return Promise.resolve();
        },
      },
    );
    expect(calls).toEqual([
      "/meta/bases/appAAAAAAAAAAAAAA/tables",
      "/appAAAAAAAAAAAAAA/tblA?pageSize=100&returnFieldsByFieldId=true",
      "/appAAAAAAAAAAAAAA/tblA?pageSize=100&returnFieldsByFieldId=true",
      "/appAAAAAAAAAAAAAA/tblA?pageSize=100&returnFieldsByFieldId=true&offset=p2",
    ]);
    expect(
      headers.every(
        (value) => value === "Bearer patSECRET.token1234567890abcdef",
      ),
    ).toBe(true);
    expect(waits).toContain(30_000);
    expect(base.records.get("tblA")?.map((record) => record.id)).toEqual([
      "rec1",
      "rec2",
    ]);
    expect(progress).toEqual(["1/1"]);
  });

  it("names a refused token and a missing base", async () => {
    const answer = (status: number) =>
      (() => Promise.resolve(json({}, status))) as unknown as typeof fetch;
    const wait = () => Promise.resolve();
    await expect(
      readAirtableBase("pat", "appAAAAAAAAAAAAAA", {
        fetcher: answer(401),
        wait,
      }),
    ).rejects.toThrow("Airtable refused the token");
    await expect(
      readAirtableBase("pat", "appAAAAAAAAAAAAAA", {
        fetcher: answer(404),
        wait,
      }),
    ).rejects.toThrow("Airtable base not found");
    await expect(
      readAirtableBase("pat", "appAAAAAAAAAAAAAA", {
        fetcher: answer(500),
        wait,
      }),
    ).rejects.toThrow("Airtable did not answer");
  });
});
