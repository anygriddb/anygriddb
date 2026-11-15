import { describe, expect, it } from "vitest";
import { hostAddresses } from "./cassandra.js";

const source = {
  engine: "cassandra" as const,
  host: "127.0.0.1",
  port: 9042,
  database: "shop",
  username: "reader",
  password: "secret",
  tlsCa: null,
  queryTimeoutMs: 5000,
};

describe("the Cassandra host a copy may reach", () => {
  it("is the named address and its port, as the driver names a node", async () => {
    expect(await hostAddresses(source)).toEqual(["127.0.0.1:9042"]);
  });

  it("refuses a host that resolves to nothing", async () => {
    await expect(
      hostAddresses({ ...source, host: "no-such-host.invalid" }),
    ).rejects.toMatchObject({ code: "source_unreachable" });
  });
});
