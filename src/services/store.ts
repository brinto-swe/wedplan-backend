import { ObjectId, type ClientSession, type Db, type Filter, type MongoClient } from "mongodb";

import { authCollections } from "../auth/schema.js";
import { findVendorDisplay } from "../auth/vendor-display.js";
import { hasPremiumEntitlement } from "../payments/entitlement.js";
import type { AdminServiceQuery, ListQuery, ServiceInput } from "./schemas.js";

export type Service = ServiceInput & {
  _id: ObjectId;
  vendorId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ServiceManager = { id: string; role: "vendor" | "admin" };

export class ServiceError extends Error {
  constructor(public status: 403 | 404 | 409, message: string) {
    super(message);
  }
}

type VendorAccount = {
  _id: ObjectId;
  role?: string;
  isBlocked?: boolean;
  subscriptionPlan?: string;
  subscriptionExpiresAt?: Date | null;
  serviceCapacityVersion?: number;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function searchFilter({ q, category }: Pick<ListQuery, "q" | "category">): Filter<Service> {
  const filter: Filter<Service> = {};
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, "i");
  if (q) {
    const search = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ title: search }, { description: search }];
  }
  return filter;
}

function ownership(manager: ServiceManager): Filter<Service> {
  return manager.role === "admin" ? {} : { vendorId: manager.id };
}

export function createServiceStore(client: MongoClient, db: Db) {
  const services = db.collection<Service>("services");
  // Better Auth's existing MongoDB configuration uses the user collection and ObjectIds.
  const users = db.collection<VendorAccount>(authCollections.user);

  async function ensureCapacity(vendorId: string, session: ClientSession, requester: ServiceManager) {
    // A write to the same vendor document serializes all additions to active inventory.
    const vendor = await users.findOneAndUpdate(
      { _id: new ObjectId(vendorId), role: "vendor" },
      { $inc: { serviceCapacityVersion: 1 } },
      { session, returnDocument: "after" },
    );
    if (!vendor || (requester.role === "vendor" && vendor.isBlocked === true)) {
      throw new ServiceError(403, "Vendor account unavailable");
    }

    if (hasPremiumEntitlement(vendor.subscriptionPlan, vendor.subscriptionExpiresAt)) return;

    const active = await services.countDocuments({ vendorId, isActive: true }, { session, limit: 3 });
    if (active >= 3) throw new ServiceError(409, "Free vendors may have at most 3 active services");
  }

  function transaction<T>(operation: (session: ClientSession) => Promise<T>) {
    return client.withSession((session) => session.withTransaction(() => operation(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }));
  }

  async function list(filter: Filter<Service>, { page, limit }: ListQuery) {
    const [data, total] = await Promise.all([
      services.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      services.countDocuments(filter),
    ]);
    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  return {
    listPublic(query: ListQuery) {
      const filter: Filter<Service> = { ...searchFilter(query), isActive: true };
      if (query.location) filter.location = new RegExp(`^${escapeRegex(query.location)}$`, "i");
      return list(filter, query);
    },

    async listAdmin(query: AdminServiceQuery) {
      const filter = searchFilter(query);
      if (query.vendorId) filter.vendorId = query.vendorId;
      if (query.visibility) filter.isActive = query.visibility === "active";
      const result = await list(filter, query);
      const display = await findVendorDisplay(db, result.data.map(({ vendorId }) => vendorId));
      return { ...result, data: result.data.map((service) => ({
        service, vendor: display.get(service.vendorId) ?? null,
      })) };
    },

    listManaged(manager: ServiceManager, query: ListQuery) {
      return list(ownership(manager), query);
    },

    findPublic(id: ObjectId) {
      return services.findOne({ _id: id, isActive: true });
    },

    findManaged(manager: ServiceManager, id: ObjectId) {
      return services.findOne({ _id: id, ...ownership(manager) });
    },

    async create(manager: ServiceManager, input: ServiceInput) {
      if (manager.role !== "vendor") throw new ServiceError(403, "Only vendors can create services");
      const now = new Date();
      const service = {
        ...input, _id: new ObjectId(), vendorId: manager.id, createdAt: now, updatedAt: now,
      };
      if (!service.isActive) {
        await services.insertOne(service);
        return service;
      }
      return transaction(async (session) => {
        await ensureCapacity(manager.id, session, manager);
        await services.insertOne(service, { session });
        return service;
      });
    },

    async update(manager: ServiceManager, id: ObjectId, changes: Partial<ServiceInput>) {
      const filter = { _id: id, ...ownership(manager) };
      const update = { $set: { ...changes, updatedAt: new Date() } };
      if (changes.isActive !== true) {
        return services.findOneAndUpdate(filter, update, { returnDocument: "after" });
      }

      return transaction(async (session) => {
        const service = await services.findOne(filter, { session });
        if (!service) return null;
        if (!service.isActive) await ensureCapacity(service.vendorId, session, manager);
        return services.findOneAndUpdate(filter, update, { session, returnDocument: "after" });
      });
    },

    async remove(manager: ServiceManager, id: ObjectId) {
      const result = await services.deleteOne({ _id: id, ...ownership(manager) });
      return result.deletedCount === 1;
    },
  };
}

export type ServiceStore = ReturnType<typeof createServiceStore>;
