# 0011 — A Vite single-page app served by the API

- Status: Accepted
- Date: 2026-11-07

## Context

Every page of `apps/web` is a client component. Next.js 16 serves only
three purposes: routing, the CSP nonce, and a second Node server. It costs:

- **A build-time API address.** `NEXT_PUBLIC_API_URL` is fixed when the
  image is built (`docker/Dockerfile.web`). A self-hoster must rebuild the
  image to change their domain.
- **Two origins** (ports 3000 and 4000), so CORS, cookies, and CSP
  `connect-src` all need care.
- **Turbopack constraints.** It forced `moduleResolution: Bundler`.
- **Upgrade churn** at every major release: `params` became a Promise, and
  middleware was renamed proxy.
- **Telemetry on by default** in the build tool.

## Decision

- **Vite** builds a static app with React 19 and the React Compiler.
  **TanStack Router** gives typed routes, and view state (filters, sorts)
  validated in the URL, wired to TanStack Query.
- **The API serves the built files** (Fastify static) on the same origin.
  - The client uses relative URLs. Configuration comes at runtime, not at
    build time.
  - The CSP is `script-src 'self'`, with no nonce.
- **Public share links** (`/s/:token`) get their meta tags injected into
  `index.html` by the API.

## Consequences

- One image, one port, one origin.
- No server-side rendering. A spreadsheet behind a login gains nothing from
  it.
- About 14 routes move to TanStack Router.

## Rejected

- **Next.js** with server components. This app has no server-rendered data
  to gain from them.
- **React Router 7.** It fits, but TanStack Router integrates better with
  TanStack Query and types search parameters.
