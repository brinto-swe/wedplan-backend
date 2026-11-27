import express, { type ErrorRequestHandler } from "express";
import type { Auth } from "./auth.js";
import { profileUpdate, safeProfile } from "./profile.js";
import { requireBearerUser } from "./protection.js";

export function profileRouter(auth: Auth) {
  const router = express.Router();
  router.get("/", requireBearerUser(auth), (_request, response) => {
    response.json(response.locals.profile);
  });
  router.patch("/", requireBearerUser(auth, ["customer", "vendor"]), express.json({ limit: "8kb" }), async (request, response) => {
    const current: ReturnType<typeof safeProfile> = response.locals.profile;
    const changes = profileUpdate.safeParse(request.body);
    if (!changes.success) {
      response.status(400).json({
        error: "Invalid profile update",
        issues: changes.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      });
      return;
    }
    if (changes.data.businessName !== undefined && current.role !== "vendor") {
      response.status(400).json({ error: "Only Vendors can update a business name" });
      return;
    }

    const { internalAdapter } = await auth.$context;
    const updated = await internalAdapter.updateUser(current.id, changes.data);
    if (!updated) {
      response.status(401).json({ error: "Account unavailable" });
      return;
    }
    response.json(safeProfile(updated, current.role));
  });
  const parserErrors: ErrorRequestHandler = (error, _request, response, next) => {
    if (error?.type === "entity.too.large") response.status(413).json({ error: "Request body too large" });
    else if (error?.type === "entity.parse.failed") response.status(400).json({ error: "Invalid request body" });
    else next(error);
  };
  router.use(parserErrors);
  return router;
}
