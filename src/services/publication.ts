import type { Document } from "mongodb";

import { authCollections } from "../auth/schema.js";
import { premiumEntitlementExpression } from "../payments/entitlement.js";

export const moderationStatuses = ["pending", "approved", "rejected"] as const;
export type ModerationStatus = typeof moderationStatuses[number];
export const newestServices = { createdAt: -1, _id: -1 } as const;

// Stored isActive is the owner's availability preference, including on legacy records.
// Only absent moderation status is grandfathered. Rank before applying catalogue filters.
export function publicationStages(now = new Date()): Document[] {
  return [
    { $set: {
      moderationStatus: { $cond: [{ $eq: [{ $type: "$moderationStatus" }, "missing"] }, "approved", "$moderationStatus"] },
      vendorAvailable: { $eq: ["$isActive", true] },
    } },
    { $setWindowFields: {
      partitionBy: { vendor: "$vendorId", moderation: "$moderationStatus" },
      sortBy: newestServices,
      output: { publicationRank: { $sum: 1, window: { documents: ["unbounded", "current"] } } },
    } },
    { $set: { publicationVendorId: {
      $convert: { input: "$vendorId", to: "objectId", onError: null, onNull: null },
    } } },
    { $lookup: {
      from: authCollections.user,
      localField: "publicationVendorId",
      foreignField: "_id",
      pipeline: [
        { $match: { role: "vendor", isBlocked: { $ne: true } } },
        { $project: { premium: premiumEntitlementExpression(now) } },
      ],
      as: "publicationVendor",
    } },
    { $set: { vendorPremium: { $in: [true, "$publicationVendor.premium"] } } },
    { $set: { isActive: { $and: [
      { $eq: ["$moderationStatus", "approved"] },
      "$vendorAvailable",
      { $gt: [{ $size: "$publicationVendor" }, 0] },
      { $or: [
        { $lte: ["$publicationRank", 3] },
        "$vendorPremium",
      ] },
    ] } } },
    { $unset: ["publicationRank", "publicationVendorId", "publicationVendor"] },
  ];
}
