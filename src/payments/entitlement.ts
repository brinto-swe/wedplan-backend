const premiumPlan = "premium";

export function hasPremiumEntitlement(plan: unknown, expiresAt: unknown, now = Date.now()) {
  return plan === premiumPlan && expiresAt instanceof Date && expiresAt.getTime() > now;
}

// MongoDB version of the same rule so dashboards can aggregate without loading users.
export function premiumEntitlementExpression(now: Date) {
  return { $and: [
    { $eq: ["$subscriptionPlan", premiumPlan] },
    { $eq: [{ $type: "$subscriptionExpiresAt" }, "date"] },
    { $gt: ["$subscriptionExpiresAt", now] },
  ] };
}
