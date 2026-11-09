# 0020 — Pieces kept as they are

- Status: Accepted
- Date: 2026-11-07

Each of these was challenged and kept on its merits:

| Piece                              | Why it stays                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify 5                          | Mature, fast, with official plugins for WebSocket, multipart, and rate limits. Hono adds nothing off the edge; NestJS adds ceremony                                                                                       |
| tRPC 11                            | A typed contract between the web app and the API. The public REST API stays a separate, versioned product contract                                                                                                        |
| Zod 4                              | Shared validation for client and server                                                                                                                                                                                   |
| TanStack Query, TanStack Virtual   | Server state and virtualization, both maintained and well integrated                                                                                                                                                      |
| Tailwind 4, lucide, sonner, cmdk   | Styling, icons, toasts, command palette: small, maintained, no lock-in                                                                                                                                                    |
| sharp                              | WebP thumbnails; prebuilt libvips (LGPL, linked dynamically)                                                                                                                                                              |
| nodemailer                         | Optional email through the operator's SMTP                                                                                                                                                                                |
| exceljs                            | XLSX import and export, behind an interface. Upstream has not released since 2023; evaluate `excelts` (a maintained TypeScript rewrite) before any switch, checking its license and streaming reader                      |
| Formula engine (homemade)          | No library compiles spreadsheet formulas to SQL                                                                                                                                                                           |
| One physical table per table       | Real SQL performance, indexes, foreign keys, and audit triggers. We accept DDL on schema changes and a growing catalog. JSONB loses types, foreign keys, and per-field audit; a SQLite file per document loses PostgreSQL |
| Vitest, Testcontainers, Playwright | Unit, integration on real engines, end to end. The end-to-end journeys grow and run in CI                                                                                                                                 |
| Apache ECharts (for dashboards)    | Replaces the hand-drawn SVG charts when dashboards grow. Apache-2.0, large data sets, accessible descriptions                                                                                                             |
