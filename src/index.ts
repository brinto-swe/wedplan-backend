import "dotenv/config";
import { z } from "zod";

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

async function startServer(): Promise<void> {
  const config = envSchema.safeParse(process.env);
  if (!config.success) {
    console.error("Invalid startup environment:", config.error.issues.map(({ path }) => path.join(".")).join(", "));
    process.exitCode = 1;
    return;
  }

  const env = config.data;
  let stage = "MongoDB connection";
  try {
    const { client, connectDatabase, getDatabase } = await import("./db/mongodb.js");
    await connectDatabase();

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

    const { createServiceStore } = await import("./services/store.js");
    const db = getDatabase();
    const services = createServiceStore(client, db);
    stage = "booking index initialization";
    const { createBookingStore } = await import("./bookings/store.js");
    const bookings = createBookingStore(db, services);
    await bookings.ensureIndexes();

    stage = "API listener";
    const server = createApp(auth, env.CLIENT_URL, services, bookings).listen(env.PORT, () => {
      console.log(`WedPlan API listening on port ${env.PORT}.`);
    });
    server.on("error", () => {
      console.error("WedPlan could not bind the API listener.");
      process.exit(1);
    });
  } catch (error) {
    const dnsTimeout = stage === "MongoDB connection" && typeof error === "object" &&
      error !== null && "code" in error && error.code === "ETIMEOUT";
    console.error(`WedPlan startup failed during ${stage}${dnsTimeout ? " (DNS timeout)" : ""}.`);
    process.exit(1);
  }
}

void startServer();
