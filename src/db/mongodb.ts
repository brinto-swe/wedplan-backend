import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is not defined");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

export async function connectDatabase(): Promise<void> {
  await client.connect();

  await client.db("admin").command({ ping: 1 });

  console.log("You successfully connected to MongoDB!");
}

export function getDatabase() {
  return client.db(process.env.MONGODB_DATABASE || "wedplan");
}

export { client };