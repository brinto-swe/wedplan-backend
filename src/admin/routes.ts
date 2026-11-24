import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import type { Auth } from "../auth/auth.js";
import { requireBearerUser } from "../auth/protection.js";
import { userId, userQuery, userStatus } from "./schemas.js";
import type { AdminUserStore } from "./store.js";

export function createAdminRouter(store: AdminUserStore, auth: Auth) {
  const router = express.Router();
  router.use(requireBearerUser(auth, ["admin"]));

  router.get("/users", async (request, response) => {
    response.json(await store.list(userQuery.parse(request.query)));
  });

  router.get("/users/:id", async (request, response) => {
    const user = await store.find(userId.parse(request.params.id));
    if (!user) {
      response.status(404).json({ error: "User not found" });
      return;
    }
    response.json({ data: user });
  });

  router.patch("/users/:id/status", express.json(), async (request, response) => {
    const id = userId.parse(request.params.id);
    const { status } = userStatus.parse(request.body);
    if (status === "blocked" && id.equals(response.locals.profile.id)) {
      response.status(403).json({ error: "You cannot block your own account" });
      return;
    }
    const user = await store.setStatus(id, status);
    if (!user) {
      response.status(404).json({ error: "User not found" });
      return;
    }
    response.json({ data: user });
  });

  router.use(adminErrors);
  return router;
}

const adminErrors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Invalid admin request",
      issues: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    });
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
