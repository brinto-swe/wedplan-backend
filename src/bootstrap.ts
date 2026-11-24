import { z } from "zod";

import type { createApp } from "./app.js";
import { createAdminUserStore } from "./admin/store.js";
import { createAdminTransactionStore } from "./admin/transactions.js";
import { createAdminOverviewStore } from "./admin/overview.js";
import { mongoEnvSchema } from "./db/config.js";

const httpOrigin = z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);
const stripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/),
  STRIPE_PREMIUM_PRICE_ID: z.string().regex(/^price_[A-Za-z0-9]+$/),
});
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  CLIENT_URL: httpOrigin.default("http://localhost:3000"),
  BETTER_AUTH_URL: httpOrigin.default("http://localhost:5000"),
  BETTER_AUTH_SECRET: z.string().min(32),
  ...mongoEnvSchema.shape,
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
});

type Application = { app: ReturnType<typeof createApp>; port: number };
let initialization: Promise<Application> | undefined;

export function getApplication(): Promise<Application> {
  initialization ??= initialize().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

async function initialize(): Promise<Application> {
  const config = envSchema.safeParse(process.env);
  if (!config.success) {
    console.error("Missing or invalid startup environment:", config.error.issues.map(({ path }) => path.join(".")).join(", "));
    throw new Error("Invalid startup environment");
  }

  const env = config.data;
  let stage = "MongoDB configuration (check MONGODB_URI syntax and options)";
  try {
    const { client, connectDatabase, getDatabase } = await import("./db/mongodb.js");
    stage = "MongoDB connection";
    await connectDatabase();

    stage = "booking index initialization";
    const { createBookingStore } = await import("./bookings/store.js");
    const { createServiceStore } = await import("./services/store.js");
    const db = getDatabase();
    const services = createServiceStore(client, db);
    const bookings = createBookingStore(db, services);
    await bookings.ensureIndexes();

    stage = "authentication initialization";
    const { createAuth } = await import("./auth/auth.js");
    const { createApp } = await import("./app.js");
    const auth = createAuth({
      origin: env.CLIENT_URL,
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    });
    await auth.$context;

    stage = "Stripe configuration";
    let payments;
    if (Object.keys(stripeEnvSchema.shape).some((key) => process.env[key])) {
      const stripeEnv = stripeEnvSchema.safeParse(process.env);
      if (!stripeEnv.success) throw new Error("Invalid Stripe environment");
      const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PREMIUM_PRICE_ID } = stripeEnv.data;
      const { default: Stripe } = await import("stripe");
      const { createPaymentStore } = await import("./payments/store.js");
      const { createPayments } = await import("./payments/service.js");
      const store = createPaymentStore(client, db);
      stage = "Stripe index initialization";
      await store.ensureIndexes();
      payments = createPayments(new Stripe(STRIPE_SECRET_KEY, { timeout: 8_000, maxNetworkRetries: 1 }), store, {
        priceId: STRIPE_PREMIUM_PRICE_ID,
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        origin: env.CLIENT_URL,
        liveMode: /^(sk|rk)_live_/.test(STRIPE_SECRET_KEY),
      });
    }
    return {
      app: createApp(
        auth, env.CLIENT_URL, services, bookings, payments,
        createAdminUserStore(db), createAdminTransactionStore(db), createAdminOverviewStore(db),
      ),
      port: env.PORT,
    };
  } catch {
    console.error(`WedPlan initialization failed during ${stage}.`);
    throw new Error("API initialization failed");
  }
}
