/**
 * The client engines the sample suites run against, as the global setup
 * (`world-global.ts`) provided them: the docker/lab compose or containers it
 * started. Every suite shares them.
 */
import { inject } from "vitest";
import type { SampleEndpoint } from "./types.js";

export type SampleWorld = {
  endpoints: SampleEndpoint[];
};

export function sampleWorld(): SampleWorld {
  return { endpoints: inject("sampleEndpoints") };
}
