# WedPlan Backend

## Vercel deployment

Import this repository as an **Express** project with the repository root as the root directory. Select Node.js **24.x** and use Vercel’s native Express integration. The root `app.ts` default export is the hosted entry. Leave the output directory override unset. The hosted application does not use a start command or a manually configured port.

`npm run build` emits `dist/app.js` for the Vercel entry and `dist/src/index.js` for the local listener. Vercel bundles the source entry directly.

### Runtime environment

Set these in Vercel for the environment you intend to deploy. Store credential values only in the platform’s environment settings.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas driver connection string for the deployment database user |
| `MONGODB_DATABASE` | Explicit target database name |
| `BETTER_AUTH_SECRET` | Stable high-entropy secret, at least 32 characters |
| `CLIENT_URL` | Exact public HTTPS Netlify frontend origin |
| `BETTER_AUTH_URL` | Browser-facing HTTPS API origin, without `/api/auth` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth Web client credentials |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app credentials |

The frontend’s `NEXT_PUBLIC_API_URL` must point to the browser-facing API origin at build time. For reliable session cookies use HTTPS sibling domains under one parent domain, or configure Netlify to proxy `/api/*` to Vercel with the original path, cookies and response headers preserved. With the proxy, use the Netlify origin for `NEXT_PUBLIC_API_URL` and `BETTER_AUTH_URL`. Register `<BETTER_AUTH_URL>/api/auth/callback/google` and `<BETTER_AUTH_URL>/api/auth/callback/github` with their providers. Use the exact public origins for each environment.

Allow the deployment’s approved egress addresses in Atlas. The database user needs application read/write and index-creation privileges. The first request per function instance waits for Atlas and booking index readiness. Concurrent requests share that attempt. Index creation is idempotent across instances and a failed attempt can be retried. Existing duplicate active booking records must be resolved before the unique index can become ready.

After a manual deployment, check `GET /api/auth/ok` and `GET /api/services` for HTTP 200, and anonymous `GET /api/bookings/my` for HTTP 401. The API has no homepage at `/`. Verify credentialed CORS, email and OAuth login, session persistence and JWT issuance from the deployed frontend. If startup returns 503, inspect the sanitized initialization stage in Vercel Function Logs.

Stripe is not used by the current application.

## Local development

Use Node.js 24, run `npm ci`, and configure a local ignored `.env` from `.env.example`. Use `npm run dev` for watch mode or `npm run build` followed by `npm start` for the local production-style listener. The default local port is 5000. Run `npm run typecheck` and `npm test` to verify changes. The default suite uses test doubles. Keep `BOOKINGS_MONGO_INTEGRATION` unset when avoiding database writes.
