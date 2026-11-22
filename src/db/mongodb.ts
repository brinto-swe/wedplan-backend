import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is not defined");
}

const client = new MongoClient(uri, {
  maxPoolSize: 10,
  connectTimeoutMS: 10_000,
  serverSelectionTimeoutMS: 10_000,
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let connection: Promise<void> | undefined;

export function connectDatabase(): Promise<void> {
  connection ??= initializeConnection().catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

async function initializeConnection(): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    reportAtlasDnsError(error);
    throw error;
  }

  try {
    await client.db("admin").command({ ping: 1 });
  } catch (error) {
    console.error("MongoDB ping failed.");
    throw error;
  }

  console.log("MongoDB ping succeeded.");
}

function reportAtlasDnsError(error: unknown): void {
  if (typeof error !== "object" || error === null ||
    !("syscall" in error) || (error.syscall !== "querySrv" && error.syscall !== "queryTxt") ||
    !("hostname" in error) || typeof error.hostname !== "string" ||
    !/^(?:_[a-z0-9-]+\._tcp\.)?(?:[a-z0-9-]+\.)+mongodb\.net\.?$/i.test(error.hostname) ||
    !("code" in error) || typeof error.code !== "string" || !/^E[A-Z0-9_]{1,30}$/.test(error.code)
  ) return;

  const stage = error.syscall === "querySrv" ? "SRV" : "TXT";
  console.error("MongoDB DNS resolution failed", stage, error.hostname, error.code);
}

export function getDatabase() {
  return client.db(process.env.MONGODB_DATABASE || "wedplan");
}

export { client };