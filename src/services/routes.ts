import { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { z } from "zod";

import { createService, managementQuery, publicQuery, serviceId, updateService } from "./schemas.js";
import { ServiceError, type Service, type ServiceManager, type ServiceStore } from "./store.js";

export function serializeService({ _id, title, description, category, price, location, isActive, vendorId, createdAt, updatedAt }: Service) {
  return { id: _id.toHexString(), title, description, category, price, location, isActive, vendorId, createdAt, updatedAt };
}

export function createServiceManagementHandlers(store: ServiceStore) {
  const detail: RequestHandler = async (request, response) => {
    const manager: ServiceManager = response.locals.profile;
    const service = await store.findManaged(manager, serviceId.parse(request.params.id));
    if (!service) throw new ServiceError(404, "Service not found");
    response.json({ data: serializeService(service) });
  };
  const update: RequestHandler = async (request, response) => {
    const manager: ServiceManager = response.locals.profile;
    const service = await store.update(manager, serviceId.parse(request.params.id), updateService.parse(request.body));
    if (!service) throw new ServiceError(404, "Service not found");
    response.json({ data: serializeService(service) });
  };
  const remove: RequestHandler = async (request, response) => {
    const manager: ServiceManager = response.locals.profile;
    const removed = await store.remove(manager, serviceId.parse(request.params.id));
    if (!removed) throw new ServiceError(404, "Service not found");
    response.status(204).end();
  };
  return { detail, update, remove };
}

export function createServiceRouter(store: ServiceStore, authorize: RequestHandler) {
  const router = Router();
  const management = createServiceManagementHandlers(store);

  router.get("/", async (request, response) => {
    const result = await store.listPublic(publicQuery.parse(request.query));
    response.json({ data: result.data.map(serializeService), pagination: result.pagination });
  });

  router.get("/manage", authorize, async (request, response) => {
    const manager: ServiceManager = response.locals.profile;
    const result = await store.listManaged(manager, managementQuery.parse(request.query));
    response.json({ data: result.data.map(serializeService), pagination: result.pagination });
  });

  router.get("/manage/:id", authorize, management.detail);

  router.get("/:id", async (request, response) => {
    const service = await store.findPublic(serviceId.parse(request.params.id));
    if (!service) throw new ServiceError(404, "Service not found");
    response.json({ data: serializeService(service) });
  });

  router.post("/", authorize, async (request, response) => {
    const manager: ServiceManager = response.locals.profile;
    if (manager.role !== "vendor") throw new ServiceError(403, "Only vendors can create services");
    const service = await store.create(manager, createService.parse(request.body));
    const path = service.isActive ? "/api/services" : "/api/services/manage";
    response.location(`${path}/${service._id.toHexString()}`);
    response.status(201).json({ data: serializeService(service) });
  });

  router.patch("/:id", authorize, management.update);
  router.delete("/:id", authorize, management.remove);

  return router;
}

export const serviceErrors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({
      error: "Invalid service request",
      issues: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    });
    return;
  }
  if (error instanceof ServiceError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error) {
    if (error.type === "entity.parse.failed") {
      response.status(400).json({ error: "Invalid request body" });
      return;
    }
    if (error.type === "entity.too.large") {
      response.status(413).json({ error: "Request body too large" });
      return;
    }
  }
  next(error);
};
