# WedPlan Backend

## Vercel deployment

Import this repository as an **Express** project with the repository root as the root directory. Select Node.js **24.x** and use Vercel’s native Express integration. The root `app.ts` default export is the hosted entry. Leave the output directory override unset. The hosted application does not use a start command or a manually configured port.

`npm run build` emits `dist/app.js` for the Vercel entry and `dist/src/index.js` for the local listener. Vercel bundles the source entry directly.

### Runtime environment

Set these in Vercel for the environment you intend to deploy. Store credential values only in the platform’s environment settings.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas driver connection string for the deployment database user |
| `MONGODB_DATABASE` | Required explicit target database name, using 1–63 letters, digits, hyphens or underscores |
| `BETTER_AUTH_SECRET` | Stable high-entropy secret, at least 32 characters |
| `CLIENT_URL` | Exact public HTTPS Netlify frontend origin |
| `BETTER_AUTH_URL` | Browser-facing HTTPS API origin, without `/api/auth` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth Web client credentials |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth app credentials |

The frontend’s `NEXT_PUBLIC_API_URL` must point to the browser-facing API origin at build time. For reliable session cookies use HTTPS sibling domains under one parent domain, or configure Netlify to proxy `/api/*` to Vercel with the original path, cookies and response headers preserved. With the proxy, use the Netlify origin for `NEXT_PUBLIC_API_URL` and `BETTER_AUTH_URL`. Register `<BETTER_AUTH_URL>/api/auth/callback/google` and `<BETTER_AUTH_URL>/api/auth/callback/github` with their providers. Use the exact public origins for each environment.

Allow the deployment’s approved egress addresses in Atlas. The database user needs application read/write and index-creation privileges. The first request per function instance waits for Atlas and booking index readiness. Concurrent requests share that attempt. Index creation is idempotent across instances and a failed attempt can be retried. Existing duplicate active booking records must be resolved before the unique index can become ready.

After a manual deployment, check `GET /api/auth/ok` and `GET /api/services` for HTTP 200, and anonymous `GET /api/bookings/my` for HTTP 401. The API has no homepage at `/`. Verify credentialed CORS, email and OAuth login, session persistence and JWT issuance from the deployed frontend. If startup returns 503, inspect the sanitized initialization stage in Vercel Function Logs.

See [Stripe subscriptions](#stripe-subscriptions) for Vercel billing configuration.

## Image uploads

`POST /api/uploads/images` requires a bearer token for an unblocked Vendor or Customer. Send `multipart/form-data` with exactly one file part named `images`. The endpoint accepts JPEG, PNG, and WebP up to **4 MiB (4,194,304 bytes)**. It checks the file signature before sending the image to ImgBB. The upload uses the backend-only `IMGBB_API_KEY`.

A successful request returns HTTP `201` with `{"data":[{"url":"https://i.ibb.co/example/image.png","displayUrl":"https://i.ibb.co/example/display.png"}]}`. The `data` array contains one entry, and `displayUrl` is optional. URLs are public and the application does not store them in this phase.

The multipart body is capped at **4,259,840 bytes (4 MiB + 64 KiB)** including overhead, below Vercel’s default 4.5 MB request limit. The endpoint returns `413` if either size limit is exceeded and `400` for zero or multiple file parts. To upload several images, send one request per image. Reduce any image larger than 4 MiB before uploading.

### Service image persistence

Vendor `POST /api/services` requires an ordered `images` array of 1–10 HTTPS image URLs from `i.ibb.co`. Upload each file first, then send the returned URL in that array. Service PATCH requests, including Admin updates, preserve images when the field is omitted. Send a complete replacement array to add, remove, or reorder images. An empty array clears the service’s image references. Updating the record does not delete files from ImgBB.

Public, Vendor, and Admin service responses include `images`. Existing documents without the field return `images: []` without a database migration.

## Local development

Use Node.js 24, run `npm ci`, and configure a local ignored `.env` from `.env.example`. Use `npm run dev` for watch mode or `npm run build` followed by `npm start` for the local production-style listener. The default local port is 5000. Run `npm run typecheck` and `npm test` to verify changes. The default suite uses test doubles. Keep `BOOKINGS_MONGO_INTEGRATION` unset when avoiding database writes.

## Seed the initial admin and vendor

Run this command only on an authorized workstation in an interactive terminal. It has no HTTP route or startup, build, deployment, or CI hook.

1. Confirm the Atlas cluster and database in the Atlas console. Allow the workstation's IP through the Atlas network access rules and use a database credential authorized for the target database. The seed uses MongoDB transactions through the same Better Auth adapter as the API. Use Atlas or another replica set for testing.
2. Verify the auth `user` collection has a full, single-field unique index on `email` with simple collation. The CLI checks for it and stops if it is missing. If needed, have the database operator review existing emails and provision the index separately before seeding.
3. Set the variables below in the backend root's ignored `.env` file or inject them into the local terminal environment using your secret manager. The CLI loads the file before validation and gives existing terminal variables precedence. Keep seed credentials out of Vercel, CI, source control, and shell history.

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Connection string for the verified target Atlas cluster |
| `MONGODB_DATABASE` | Explicit target database name |
| `WEDPLAN_SEED_EXPECTED_DATABASE` | Independently confirm this exact database name against Atlas |
| `WEDPLAN_SEED_AUTH_SECRET` | Separate, randomly generated Better Auth secret of at least 32 characters |
| `WEDPLAN_SEED_ADMIN_NAME` | Initial admin's full name |
| `WEDPLAN_SEED_ADMIN_EMAIL` | Initial admin's email address |
| `WEDPLAN_SEED_ADMIN_PASSWORD` | Initial admin's password |
| `WEDPLAN_SEED_VENDOR_NAME` | Initial vendor's full name |
| `WEDPLAN_SEED_VENDOR_EMAIL` | Initial vendor's email address |
| `WEDPLAN_SEED_VENDOR_PASSWORD` | Initial vendor's password |

Use distinct email addresses and distinct, randomly generated passwords of 16 to 128 characters. Include upper- and lowercase letters, a digit, and a symbol. From the backend repository after installing dependencies, run:

```sh
npm run seed:accounts
```

The command checks both targets before attempting signup and reports only the role and outcome. An existing marked account is accepted only when it has the expected role, is unblocked, and has a valid credential linkage. Conflicts require operator review. A retry after partial success creates only missing accounts. Reruns do not rotate credentials. New accounts use the ordinary email verification default and receive no sessions from seeding. Remove the seed variables from the terminal environment when finished.

## Stripe subscriptions

Set all three Stripe variables to enable payments. Leaving all three unset disables the payment routes. Partial or invalid configuration fails startup. Keep secrets in the backend environment.

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret API key for the environment |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this exact webhook destination or local Stripe CLI listener |
| `STRIPE_PREMIUM_PRICE_ID` | Recurring Premium Price ID from the same Stripe account and mode |
| `CLIENT_URL` | Frontend origin used for Checkout return URLs |

### Local Test Mode

1. Use an isolated MongoDB replica-set database and a disposable Vendor account. Select a Stripe sandbox, create a product with a recurring Price, and set the sandbox key and Price ID in the backend environment.
2. Authenticate the Stripe CLI to that sandbox. Start a local listener in a dedicated terminal and keep its signing secret private.

   ```sh
   stripe login
   stripe listen --events checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted --forward-to localhost:5000/api/webhooks/stripe
   ```

3. Set `STRIPE_WEBHOOK_SECRET` to the listener's signing secret and start the backend with `npm run dev`. Use the local frontend origin for `CLIENT_URL`.
4. With the disposable Vendor's bearer token, send an empty POST to `/api/payments/create-checkout-session` and open the returned URL. Complete Checkout using a [Stripe sandbox payment method](https://docs.stripe.com/testing). Confirm that `GET /api/payments/subscription` and `GET /api/payments/transactions` reflect the signed webhooks. Generic `stripe trigger` fixtures can test delivery, but entitlement changes require a Stripe Customer and Subscription linked to the Vendor by WedPlan Checkout.
5. Use `POST /api/payments/cancel-subscription` to schedule cancellation at period end. For automated checks without Stripe API calls, run `npm test`. After building, run only the payment tests with `node --test test/payments.test.mjs`.

### Vercel setup

Set the backend environment variables in Vercel for the target deployment environment. Set `CLIENT_URL` to the exact HTTPS frontend origin. Use separate Stripe credentials and MongoDB databases for test and live billing. The database account must support transactions and be able to create the billing indexes at startup.

In Stripe Workbench, register `https://wedplan-backend-six.vercel.app/api/webhooks/stripe` as a **snapshot** destination for your Stripe account. Use API version `2026-11-18.endive`, which matches the installed Stripe SDK. Select the six events listed in the local listener command. Set `STRIPE_WEBHOOK_SECRET` from that destination before testing delivery. See [Stripe webhook setup](https://docs.stripe.com/webhooks) and [subscription events](https://docs.stripe.com/billing/subscriptions/webhooks).

### Billing behavior

- Vendor payment endpoints use bearer authentication. Checkout and cancellation accept an empty body. Transaction history accepts `page` and `limit` and reports amounts in the currency's minor unit.
- Premium requires a verified webhook, an active Stripe subscription, and a paid invoice covering the configured Price. Failed renewals without verified paid coverage remove Premium access. Scheduled cancellation retains access through the earlier of the paid period end or Stripe cancellation date. Expiration is checked when account status or service capacity is read.
- When a Vendor returns to Free, existing published services remain online. The API blocks creating or reactivating active services while the Vendor has three or more.
- MongoDB commits webhook receipts, entitlement changes and invoice transactions together. A 503 leaves the event eligible for Stripe retry.

### Admin transaction history

`GET /api/admin/transactions` and `GET /api/admin/transactions/:id` require an unblocked Admin. The list accepts `page`, `limit`, a case-sensitive invoice ID prefix (`q`), `status` (`paid` or `failed`), `vendorId`, `currency`, and inclusive UTC dates `from` and `to` in `YYYY-MM-DD` format.

`amount` is an integer in the currency's minor unit, identified by `amountUnit: "minor"`. The stored `createdAt` is the Stripe invoice webhook event timestamp. Date filters operate on that timestamp, identified by `dateBasis: "stripe_invoice_event"`. Historical invoice creation dates and billing periods are unavailable in the ledger and return as `null` in detail responses.

### Admin overview

`GET /api/admin/overview` requires an unblocked Admin. The `data` object groups users, services, bookings, subscriptions, and revenue. Premium counts require the Premium plan and a future paid-through date. Scheduled cancellations count current Vendor-linked Stripe subscriptions with a future cancellation date or a period-end cancellation still scheduled.

Revenue sums paid invoice ledger records in minor units per currency. Paid and failed counts reflect stored invoice records across all time. The ledger records Stripe webhook event timestamps, which are distinct from invoice creation dates. Empty collections return zero counts and an empty currency breakdown.
