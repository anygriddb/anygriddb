// Lingui's Vite plugin compiles a PO catalog when it is imported.
declare module "*.po" {
  export const messages: Record<string, string>;
}
