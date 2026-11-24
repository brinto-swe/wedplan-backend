import { betterAuth, type BetterAuthOptions } from "better-auth";
import { isAPIError } from "better-auth/api";
import { MongoNetworkError, MongoParseError, MongoServerSelectionError } from "mongodb";
import { z } from "zod";

import { accountOptions, authCollections, initialUserFields, userFields } from "../src/auth/schema.js";

const databaseName = z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/).refine(
  (name) => !["admin", "config", "local"].includes(name.toLowerCase()),
);
const name = z.string().trim().min(1).max(100);
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(16).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/)
  .regex(/[^a-zA-Z0-9\s]/).refine((value) => value === value.trim());

const seedEnvironment = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/\S+$/),
  MONGODB_DATABASE: databaseName,
  WEDPLAN_SEED_EXPECTED_DATABASE: databaseName,
  WEDPLAN_SEED_AUTH_SECRET: z.string().min(32).regex(/^\S+$/),
  WEDPLAN_SEED_ADMIN_NAME: name,
  WEDPLAN_SEED_ADMIN_EMAIL: email,
  WEDPLAN_SEED_ADMIN_PASSWORD: password,
  WEDPLAN_SEED_VENDOR_NAME: name,
  WEDPLAN_SEED_VENDOR_EMAIL: email,
  WEDPLAN_SEED_VENDOR_PASSWORD: password,
});

export class SeedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const mongoHints = new Map<number | string, string>([
  [13, "MongoDB permission denied. Check the database user's privileges for this operation."],
  [18, "MongoDB authentication failed. Check the Atlas database user, credentials, and authentication database."],
  [20, "MongoDB rejected this operation. Confirm the deployment supports transactions and the URI targets the replica set or mongos."],
  [26, "MongoDB collection is missing. Verify the database and provision the expected auth collections and indexes."],
  [50, "MongoDB operation timed out. Check cluster availability and retry."],
  [112, "MongoDB transaction hit a write conflict. Wait for competing writes to finish before retrying."],
  [251, "MongoDB transaction was aborted or is no longer active. Check Atlas health and retry."],
  [8000, "Atlas rejected the operation. Check the database user's credentials, privileges, and Atlas logs."],
  [11000, "MongoDB rejected a duplicate key. Check for a conflicting account or index entry without modifying either account."],
  ["ENOTFOUND", "MongoDB hostname lookup failed. Check the Atlas hostname and DNS resolver."],
  ["ETIMEOUT", "MongoDB DNS lookup timed out. Check SRV/TXT resolution from this workstation."],
  ["ECONNREFUSED", "MongoDB connection refused. Check the connection target, firewall, and Atlas network access."],
  ["ECONNRESET", "The MongoDB connection was reset. Check the local VPN or network route and Atlas network access."],
  ["ETIMEDOUT", "A MongoDB connection timed out. Check the Atlas IP access list and the local network route."],
  ["CERT_HAS_EXPIRED", "TLS certificate validation failed because a certificate expired. Check the workstation clock and certificate chain."],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "The TLS certificate did not match the MongoDB hostname. Check DNS and any VPN or proxy interception."],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "Node.js could not verify the MongoDB TLS certificate chain. Check the local trust configuration and any VPN or proxy interception."],
  ["SELF_SIGNED_CERT_IN_CHAIN", "Node.js rejected an untrusted certificate in the MongoDB TLS chain. Check the local trust configuration and any VPN or proxy interception."],
]);

function mongoHint(error: unknown) {
  const candidates: unknown[] = [error];
  if (error instanceof MongoServerSelectionError && error.reason) {
    for (const server of error.reason.servers.values()) candidates.push(server.error);
  }
  for (let candidate of candidates) {
    for (let depth = 0; depth < 4 && candidate instanceof Error; depth++) {
      if ("code" in candidate && (typeof candidate.code === "number" || typeof candidate.code === "string")) {
        const hint = mongoHints.get(candidate.code);
        if (hint) return { code: candidate.code, hint };
      }
      candidate = candidate.cause;
    }
  }
}

export async function connectWithRetry<T>(connect: () => Promise<T>): Promise<T> {
  try {
    return await connect();
  } catch (error) {
    if (!(error instanceof MongoServerSelectionError || error instanceof MongoNetworkError)) throw error;
    const diagnosis = mongoHint(error);
    if (diagnosis && !["ETIMEOUT", "ETIMEDOUT", "ECONNRESET"].includes(String(diagnosis.code))) throw error;
    return connect();
  }
}

export function seedFailure(stage: string, original: unknown): SeedError {
  if (original instanceof SeedError) return original;
  const diagnosis = mongoHint(original);
  if (diagnosis) return new SeedError(`${stage}: ${diagnosis.hint}`);
  let hint = "Unexpected failure. Check the database and auth configuration for this stage.";
  if (original instanceof MongoParseError) {
    hint = "MongoDB rejected the URI syntax. Check the Atlas connection string and percent-encoding of credentials.";
  } else if (original instanceof MongoServerSelectionError || original instanceof MongoNetworkError) {
    hint = "MongoDB could not reach a usable server. Check Atlas network access, DNS, and TLS from this workstation.";
  } else if (isAPIError(original)) {
    switch (original.body?.code) {
      case "FAILED_TO_CREATE_USER":
        hint = "Better Auth could not persist the user. Check write privileges and the user collection's validators and indexes.";
        break;
      case "INVALID_EMAIL":
      case "PASSWORD_TOO_SHORT":
      case "PASSWORD_TOO_LONG":
        hint = "Better Auth rejected the signup fields. Check the configured email and password requirements.";
        break;
      default:
        hint = "Better Auth rejected signup. Check the auth configuration and database write privileges.";
    }
  }
  return new SeedError(`${stage}: ${hint}`);
}

export async function atSeedStage<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw seedFailure(stage, error);
  }
}

type SeedTarget = { role: "admin" | "vendor"; name: string; email: string; password: string };
type SeedUser = { id: string; email: unknown; role: unknown; isBlocked: unknown; seedMarker: unknown };
export type SeedStore = {
  hasUniqueEmailIndex(): Promise<boolean>;
  findUsers(email: string): Promise<SeedUser[]>;
  hasCredential(userId: string): Promise<boolean>;
};

export function readSeedConfig(environment: NodeJS.ProcessEnv) {
  const parsed = seedEnvironment.safeParse(environment);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(({ path }) => path.join(".")))];
    throw new SeedError("Invalid environment variables: " + fields.join(", "));
  }
  const env = parsed.data;
  if (env.MONGODB_DATABASE !== env.WEDPLAN_SEED_EXPECTED_DATABASE) {
    throw new SeedError("Database names do not match.");
  }
  if (env.WEDPLAN_SEED_ADMIN_EMAIL === env.WEDPLAN_SEED_VENDOR_EMAIL) {
    throw new SeedError("Account emails must be distinct.");
  }
  if (env.WEDPLAN_SEED_ADMIN_PASSWORD === env.WEDPLAN_SEED_VENDOR_PASSWORD) {
    throw new SeedError("Account passwords must be distinct.");
  }

  const targets: SeedTarget[] = [
    { role: "admin", name: env.WEDPLAN_SEED_ADMIN_NAME, email: env.WEDPLAN_SEED_ADMIN_EMAIL, password: env.WEDPLAN_SEED_ADMIN_PASSWORD },
    { role: "vendor", name: env.WEDPLAN_SEED_VENDOR_NAME, email: env.WEDPLAN_SEED_VENDOR_EMAIL, password: env.WEDPLAN_SEED_VENDOR_PASSWORD },
  ];
  return { uri: env.MONGODB_URI, database: env.MONGODB_DATABASE, secret: env.WEDPLAN_SEED_AUTH_SECRET, targets };
}

function markerFor(role: SeedTarget["role"]) {
  return "wedplan-initial-account:v1:" + role;
}

export function createSeedAuth(database: NonNullable<BetterAuthOptions["database"]>, secret: string, targets: SeedTarget[]) {
  return betterAuth({
    database,
    baseURL: "http://localhost",
    basePath: "/api/auth",
    secret,
    emailAndPassword: { enabled: true, autoSignIn: false },
    account: accountOptions,
    user: {
      modelName: authCollections.user,
      additionalFields: userFields,
    },
    databaseHooks: {
      user: { create: { before: async (user, context) => {
        const target = targets.find(({ email }) => email === user.email);
        if (context?.path !== "/sign-up/email" || !target) {
          throw new SeedError("Seed signup hook: the request did not match a configured seed target.");
        }
        return { data: { ...user, ...initialUserFields(target.role), seedMarker: markerFor(target.role) } };
      } } },
    },
    logger: { disabled: true },
  });
}

async function inspectTarget(store: SeedStore, target: SeedTarget) {
  const users = await atSeedStage(`${target.role} user lookup`, () => store.findUsers(target.email));
  const user = users[0];
  if (!user) return undefined;
  if (users.length !== 1 || user.email !== target.email || user.role !== target.role ||
    user.isBlocked !== false || user.seedMarker !== markerFor(target.role)) {
    throw new SeedError("Conflicting " + target.role + " account. No existing account will be changed.");
  }
  if (!await atSeedStage(`${target.role} credential lookup`, () => store.hasCredential(user.id))) {
    throw new SeedError(`Conflicting ${target.role} account: credential linkage is missing or invalid. No existing account will be changed.`);
  }
  return user;
}

export async function seedAccounts(
  store: SeedStore,
  targets: SeedTarget[],
  signUp: (target: SeedTarget) => Promise<string>,
  report: (role: SeedTarget["role"], outcome: "created" | "already present") => void,
) {
  if (!await atSeedStage("Unique email index preflight", () => store.hasUniqueEmailIndex())) {
    throw new SeedError("The auth user collection requires a full unique email index.");
  }
  const existing = await Promise.all(targets.map((target) => inspectTarget(store, target)));

  for (const [index, target] of targets.entries()) {
    if (existing[index]) {
      report(target.role, "already present");
      continue;
    }
    let createdId: string | undefined;
    let signupFailure: SeedError | undefined;
    try {
      createdId = await signUp(target);
    } catch (error) {
      // A competing signup or an ambiguous commit can only be classified by reading MongoDB.
      signupFailure = seedFailure(`${target.role} Better Auth signup transaction`, error);
    }
    const persisted = await inspectTarget(store, target);
    if (!persisted) {
      throw new SeedError(`Could not create and verify the ${target.role} account. ${signupFailure?.reason ??
        "Signup returned without a verifiable persisted account. Check the selected database and auth collection mappings."}`);
    }
    report(target.role, persisted.id === createdId ? "created" : "already present");
  }
}
