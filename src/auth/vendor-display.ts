import { ObjectId, type Db } from "mongodb";

import { authCollections } from "./schema.js";

export async function findVendorDisplay(db: Db, vendorIds: string[]) {
  const ids = [...new Set(vendorIds)].filter((id) => ObjectId.isValid(id));
  if (!ids.length) return new Map();
  const vendors = await db.collection<{ _id: ObjectId; role: string; name?: string; businessName?: string }>(authCollections.user)
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) }, role: "vendor" },
      { projection: { _id: 1, name: 1, businessName: 1 } }).toArray();
  return new Map(vendors.map(({ _id, name, businessName }) => [
    _id.toHexString(), {
      id: _id.toHexString(),
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof businessName === "string" && businessName ? { businessName } : {}),
    },
  ]));
}
