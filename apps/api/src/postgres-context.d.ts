declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    templateDatabase: string;
  }
}

export {};
