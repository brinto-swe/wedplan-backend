import type { Db, Filter, ObjectId } from "mongodb";

import type { Role } from "../auth/auth.js";
import { authCollections } from "../auth/schema.js";
import type { UserQuery, UserStatus } from "./schemas.js";

type User = {
  _id: ObjectId;
  name: string;
  email: string;
  role?: Role;
  isBlocked?: boolean;
  emailVerified?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const projection = {
  _id: 1,
  name: 1,
  email: 1,
  role: 1,
  isBlocked: 1,
  emailVerified: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

function serialize(user: User) {
  return {
    id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    role: user.role === "admin" || user.role === "vendor" ? user.role : "customer",
    status: user.isBlocked === true ? "blocked" : "active",
    emailVerified: user.emailVerified === true,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function createAdminUserStore(db: Db) {
  const users = db.collection<User>(authCollections.user);

  return {
    async list({ q, role, status, page, limit }: UserQuery) {
      const filter: Filter<User> = {};
      if (q) {
        const search = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: search }, { email: search }];
      }
      // Match the authorization middleware's handling of legacy roles and status.
      if (role === "customer") filter.role = { $nin: ["admin", "vendor"] };
      else if (role) filter.role = role;
      if (status) filter.isBlocked = status === "blocked" ? true : { $ne: true };

      const [rows, total] = await Promise.all([
        users.find(filter, { projection }).sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).toArray(),
        users.countDocuments(filter),
      ]);
      return { data: rows.map(serialize), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
    },

    async find(id: ObjectId) {
      const user = await users.findOne({ _id: id }, { projection });
      return user ? serialize(user) : null;
    },

    async setStatus(id: ObjectId, status: UserStatus) {
      const user = await users.findOneAndUpdate(
        { _id: id },
        { $set: { isBlocked: status === "blocked", updatedAt: new Date() } },
        { projection, returnDocument: "after" },
      );
      return user ? serialize(user) : null;
    },
  };
}

export type AdminUserStore = ReturnType<typeof createAdminUserStore>;
