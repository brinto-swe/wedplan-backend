import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";

import type { Auth } from "./auth/auth.js";
import { requireBearerUser } from "./auth/protection.js";

import { createServiceRouter, serviceErrors } from "./services/routes.js";
import type { ServiceStore } from "./services/store.js";

export function createApp(auth: Auth, clientOrigin: string, services: ServiceStore) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: clientOrigin, credentials: true }));

  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/api/me", requireBearerUser(auth), (_request, response) => {
    response.json(response.locals.profile);
  });

  app.use("/api/services", createServiceRouter(services, requireBearerUser(auth, ["vendor", "admin"])));
  app.use("/api/services", serviceErrors);

  const handleError: ErrorRequestHandler = (_error, _request, response, next) => {
    console.error("API request failed.");
    if (response.headersSent) {
      next(new Error("API request failed"));
      return;
    }
    response.status(500).json({ error: "Request failed" });
  };
  app.use(handleError);

  return app;
}
