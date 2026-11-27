import { fromNodeHeaders } from "better-auth/node";
import type { Request, RequestHandler } from "express";

import type { Auth, Role } from "./auth.js";
import { safeProfile } from "./profile.js";

export function getRequestSession(auth: Auth, request: Request) {
  return auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
    query: { disableCookieCache: true, disableRefresh: true },
  });
}

export function requireBearerUser(auth: Auth, roles?: readonly Role[]): RequestHandler {
  return async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const token = /^Bearer ([\w.-]+)$/i.exec(request.get("authorization") ?? "")?.[1];
    if (!token) {
      response.status(401).json({ error: "Bearer token required" });
      return;
    }

    const { payload } = await auth.api.verifyJWT({ body: { token } });
    if (!payload?.sub || typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) {
      response.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const { internalAdapter } = await auth.$context;
    const user = await internalAdapter.findUserById(payload.sub);
    if (!user) {
      response.status(401).json({ error: "Account unavailable" });
      return;
    }

    const { role: storedRole, isBlocked } = user as typeof user & {
      role?: unknown;
      isBlocked?: boolean;
    };
    const role = storedRole === "admin" || storedRole === "vendor" ? storedRole : "customer";
    if (isBlocked === true || (roles && !roles.includes(role))) {
      response.status(403).json({ error: "Access denied" });
      return;
    }

    response.locals.profile = safeProfile(user, role);
    next();
  };
}
