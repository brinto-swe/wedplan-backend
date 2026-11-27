import { ObjectId, type Db, type Filter } from "mongodb";

import { findVendorDisplay } from "../auth/vendor-display.js";
import { newestServices, publicationStages, type ModerationStatus } from "./publication.js";
import type { AdminServiceQuery, ListQuery, ServiceInput } from "./schemas.js";

type StoredService = Omit<ServiceInput, "images"> & {
  _id: ObjectId;
  images?: string[];
  vendorId: string;
  createdAt: Date;
  updatedAt: Date;
  moderationStatus?: ModerationStatus;
};

export type Service = StoredService & { moderationStatus: ModerationStatus; vendorAvailable: boolean };
export type ServiceManager = { id: string; role: "vendor" | "admin" };

export class ServiceError extends Error {
  constructor(public status: 403 | 404 | 409, message: string) {
    super(message);
  }
}

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

function ownership(manager: ServiceManager): Filter<StoredService> {
  return manager.role === "admin" ? {} : { vendorId: manager.id };
}

export function createServiceStore(db: Db) {
  const services = db.collection<StoredService>("services");
  const snapshot = { readConcern: { level: "snapshot" } } as const;

  async function list(filter: Filter<Service>, { page, limit }: ListQuery, vendorId?: string) {
    const [result] = await services.aggregate<{ data: Service[]; count: { total: number }[] }>([
      ...(vendorId ? [{ $match: { vendorId } }] : []),
      ...publicationStages(),
      { $match: filter },
      { $facet: {
        data: [{ $sort: newestServices }, { $skip: (page - 1) * limit }, { $limit: limit }],
        count: [{ $count: "total" }],
      } },
    ], snapshot).toArray();
    const total = result?.count[0]?.total ?? 0;
    return { data: result?.data ?? [], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async function find(filter: Filter<Service>, vendorId?: string) {
    return services.aggregate<Service>([
      ...(vendorId ? [{ $match: { vendorId } }] : []),
      ...publicationStages(),
      { $match: filter },
      { $limit: 1 },
    ], snapshot).next();
  }

  return {
    listPublic(query: ListQuery) {
      const filter: Filter<Service> = { ...searchFilter(query), isActive: true };
      if (query.location) filter.location = new RegExp(`^${escapeRegex(query.location)}$`, "i");
      return list(filter, query);
    },

    async listAdmin(query: AdminServiceQuery) {
      const filter: Filter<Service> = searchFilter(query);
      if (query.visibility) filter.isActive = query.visibility === "active";
      if (query.moderationStatus) filter.moderationStatus = query.moderationStatus;
      const result = await list(filter, query, query.vendorId);
      const display = await findVendorDisplay(db, result.data.map(({ vendorId }) => vendorId));
      return { ...result, data: result.data.map((service) => ({
        service, vendor: display.get(service.vendorId) ?? null,
      })) };
    },

    listManaged(manager: ServiceManager, query: ListQuery) {
      return list({}, query, manager.role === "vendor" ? manager.id : undefined);
    },

    async findPublic(id: ObjectId) {
      const candidate = await services.findOne({ _id: id }, { projection: { vendorId: 1 } });
      return candidate ? find({ _id: id, isActive: true }, candidate.vendorId) : null;
    },

    async findManaged(manager: ServiceManager, id: ObjectId) {
      const candidate = await services.findOne({ _id: id, ...ownership(manager) }, { projection: { vendorId: 1 } });
      return candidate ? find({ _id: id }, candidate.vendorId) : null;
    },

    async create(manager: ServiceManager, input: ServiceInput): Promise<Service> {
      if (manager.role !== "vendor") throw new ServiceError(403, "Only vendors can create services");
      const now = new Date();
      const service = {
        ...input, _id: new ObjectId(), vendorId: manager.id,
        moderationStatus: "pending" as const, createdAt: now, updatedAt: now,
      };
      await services.insertOne(service);
      return { ...service, vendorAvailable: input.isActive, isActive: false };
    },

    async update(manager: ServiceManager, id: ObjectId, changes: Partial<ServiceInput>) {
      const scope = { _id: id, ...ownership(manager) };
      const filter: Filter<StoredService> = changes.isActive === undefined ? scope : {
        ...scope, $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
      };
      const updated = await services.findOneAndUpdate(filter, { $set: { ...changes, updatedAt: new Date() } }, { returnDocument: "after" });
      if (updated) return find({ _id: id }, updated.vendorId);
      if (changes.isActive !== undefined && await services.findOne(scope, { projection: { _id: 1 } })) {
        throw new ServiceError(409, "Availability can only change after approval");
      }
      return null;
    },

    async moderate(manager: ServiceManager, id: ObjectId, status: "approved" | "rejected") {
      if (manager.role !== "admin") throw new ServiceError(403, "Only administrators can moderate services");
      const updated = await services.findOneAndUpdate(
        { _id: id, moderationStatus: "pending" },
        { $set: { moderationStatus: status, updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (updated) return find({ _id: id }, updated.vendorId);
      if (await services.findOne({ _id: id }, { projection: { _id: 1 } })) {
        throw new ServiceError(409, "Only pending services can be moderated");
      }
      return null;
    },

    async remove(manager: ServiceManager, id: ObjectId) {
      const result = await services.deleteOne({ _id: id, ...ownership(manager) });
      return result.deletedCount === 1;
    },
  };
}

export type ServiceStore = ReturnType<typeof createServiceStore>;
