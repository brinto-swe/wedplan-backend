import { createHmac } from "node:crypto";
import type { Db } from "mongodb";

type Window = { _id: string; endsAt: Date; total: number; clients: Record<string, number> };
const duration = 60 * 60 * 1000;
const totalLimit = 40;
const clientLimit = 10;
const key = "signup-profile";

export function createSignupUploadLimiter(db: Db, secret: string) {
  const limits = db.collection<Window>("uploadRateLimits");
  return async (clientAddress: string) => {
    const now = new Date();
    const endsAt = new Date(Math.floor(+now / duration) * duration + duration);
    const fresh = { endsAt, total: 0, clients: {} };
    await limits.updateOne({ _id: key }, { $setOnInsert: fresh }, { upsert: true });
    await limits.updateOne({ _id: key, endsAt: { $lte: now } }, { $set: fresh });
    const digest = createHmac("sha256", secret).update(clientAddress).digest("hex");
    const counter = `clients.${digest}`;
    const result = await limits.updateOne({
      _id: key, endsAt, total: { $lt: totalLimit },
      $or: [{ [counter]: { $exists: false } }, { [counter]: { $lt: clientLimit } }],
    }, { $inc: { total: 1, [counter]: 1 } });
    return result.modifiedCount === 1;
  };
}
