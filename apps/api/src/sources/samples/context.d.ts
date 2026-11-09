import type { SampleEndpoint } from "./types.js";

declare module "vitest" {
  export interface ProvidedContext {
    sampleEndpoints: SampleEndpoint[];
  }
}

export {};
