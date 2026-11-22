import { z } from "zod";

import type { createApp } from "./app.js";

const httpOrigin = z.url({ protocol: /^https?$/ }).transform((value) => new URL(value).origin);
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  CLIENT_URL: httpOrigin.default("http://localhost:3000"),
  BETTER_AUTH_URL: httpOrigin.default("http://localhost:5000"),
  BETTER_AUTH_SECRET: z.string().min(32),
  MONGODB_URI: z.string().min(1),
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
    console.error("Invalid startup environment:", config.error.issues.map(({ path }) => path.join(".")).join(", "));
    throw new Error("Invalid startup environment");
  }

  const env = config.data;
  let stage = "MongoDB connection";
  try {
    const { client, connectDatabase, getDatabase } = await import("./db/mongodb.js");
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

    return { app: createApp(auth, env.CLIENT_URL, services, bookings), port: env.PORT };
  } catch {
    console.error(`WedPlan initialization failed during ${stage}.`);
    throw new Error("API initialization failed");
  }
}
