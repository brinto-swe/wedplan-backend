import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { MongoClient, ObjectId } from "mongodb";

import { authCollections, authDatabase } from "../src/auth/schema.js";
import { atSeedStage, connectWithRetry, createSeedAuth, readSeedConfig, seedAccounts, SeedError, seedFailure, type SeedStore } from "./seed-accounts-core.js";

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY ||
    ["CI", "VERCEL", "VERCEL_ENV", "NETLIFY", "GITHUB_ACTIONS"].some((name) => process.env[name] !== undefined)) {
    throw new SeedError("Run this command from an interactive local terminal outside CI and hosting environments.");
  }

  const { error } = loadEnv({
    path: fileURLToPath(new URL("../.env", import.meta.url)),
    quiet: true,
  });
  if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new SeedError("Could not read the backend .env file.");
  }

  const config = readSeedConfig(process.env);
  const client = await atSeedStage("MongoDB client configuration",
    () => new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000 }));
  let failed = false;
  try {
    await atSeedStage("MongoDB connection and authentication", () => connectWithRetry(() => client.connect()));
    const db = client.db(config.database);
    const users = db.collection(authCollections.user);
    const accounts = db.collection(authCollections.account);
    const store: SeedStore = {
      async hasUniqueEmailIndex() {
        return (await users.listIndexes().toArray()).some((index) =>
          index.unique === true && Object.keys(index.key).length === 1 &&
          [1, -1].includes(index.key.email) && !index.sparse && !index.partialFilterExpression &&
          (!index.collation || index.collation.locale === "simple"),
        );
      },
      async findUsers(email) {
        const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const matches = await users.find({ email: { $regex: "^" + escapedEmail + "$", $options: "i" } })
          .project({ email: 1, role: 1, isBlocked: 1, seedMarker: 1 }).limit(2).toArray();
        return matches.map((user) => ({
          id: user._id.toString(), email: user.email, role: user.role,
          isBlocked: user.isBlocked, seedMarker: user.seedMarker,
        }));
      },
      async hasCredential(userId) {
        if (!ObjectId.isValid(userId)) return false;
        const credentials = await accounts.find({
          userId: new ObjectId(userId), providerId: "credential",
        }).project({ accountId: 1, password: 1 }).limit(2).toArray();
        const credential = credentials[0];
        return credentials.length === 1 && credential?.accountId === userId &&
          typeof credential.password === "string" && credential.password.length > 0;
      },
    };

    // Initialize Better Auth only after index and account preflight succeeds.
    let auth: ReturnType<typeof createSeedAuth> | undefined;
    await seedAccounts(store, config.targets, async ({ name, email, password }) => {
      auth ??= await atSeedStage("Better Auth seed initialization", async () => {
        const instance = createSeedAuth(authDatabase(db, client), config.secret, config.targets);
        await instance.$context;
        return instance;
      });
      const result = await auth.api.signUpEmail({ body: { name, email, password } });
      return result.user.id;
    }, (role, outcome) => console.log(role + " account: " + outcome));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (!failed) throw seedFailure("MongoDB connection cleanup", error);
    }
  }
}

main().catch((error: unknown) => {
  console.error(seedFailure("Seed CLI", error).reason);
  process.exitCode = 1;
});
