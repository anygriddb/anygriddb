import { AppError } from "@anygriddb/core";
import { afterEach, describe, expect, it } from "vitest";
import { outboundFetch } from "./fetch.js";
import {
  closeLocalHttps,
  HOST,
  localHttps,
  pinAgent,
  publicLookup,
  resolvePublic,
} from "./local-https.test-helpers.js";

afterEach(closeLocalHttps);

describe("the outbound service as a fetch", () => {
  it("sends the call through the service and answers as fetch does", async () => {
    const { port, ca } = await localHttps((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            method: request.method,
            body,
            accept: request.headers.accept,
          }),
        );
      });
    });
    const send = outboundFetch({
      allowPrivate: false,
      maxBytes: 1_024,
      through: {
        resolve: resolvePublic,
        lookup: publicLookup,
        agent: pinAgent(port, ca),
        ca,
      },
    });
    const answer = await send(`https://${HOST}:${String(port)}/token`, {
      method: "POST",
      headers: { accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(await answer.json()).toEqual({
      method: "POST",
      body: "grant_type=authorization_code",
      accept: "application/json",
    });
  });

  it("refuses what the service refuses: plain HTTP, a private address, an answer too long", async () => {
    const send = outboundFetch({ allowPrivate: false, maxBytes: 8 });
    const refusal = async (call: Promise<unknown>) => {
      try {
        await call;
        return "ok";
      } catch (error) {
        return error instanceof AppError ? error.code : "thrown";
      }
    };
    expect(await refusal(send("http://idp.example.org/"))).toBe(
      "invalid_outbound_target",
    );
    expect(await refusal(send("https://10.0.0.7/"))).toBe(
      "invalid_outbound_target",
    );
    const { port, ca } = await localHttps((_request, response) => {
      response.end("a longer answer than eight bytes");
    });
    const capped = outboundFetch({
      allowPrivate: false,
      maxBytes: 8,
      through: {
        resolve: resolvePublic,
        lookup: publicLookup,
        agent: pinAgent(port, ca),
        ca,
      },
    });
    expect(await refusal(capped(`https://${HOST}:${String(port)}/`))).not.toBe(
      "ok",
    );
  });
});
