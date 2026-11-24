import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import { client, getDatabase } from "../db/mongodb.js";
import { accountOptions, authCollections, authDatabase, initialUserFields, userFields } from "./schema.js";

export type Role = "customer" | "vendor" | "admin";

export function createAuth(config: {
  origin: string;
  baseURL: string;
  secret: string;
  google: { clientId: string; clientSecret: string };
  github: { clientId: string; clientSecret: string };
}, database: NonNullable<BetterAuthOptions["database"]> = authDatabase(getDatabase(), client)) {
  return betterAuth({
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.origin],
    database,
    emailAndPassword: { enabled: true },
    socialProviders: { google: config.google, github: config.github },
    account: accountOptions,
    user: {
      modelName: authCollections.user,
      additionalFields: userFields,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => ({
            data: {
              ...user,
              ...initialUserFields(
                context?.path === "/sign-up/email" && context.body?.role === "vendor"
                  ? "vendor"
                  : "customer",
              ),
            },
          }),
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            const user = await context?.context.internalAdapter.findUserById(session.userId);
            if (!user || (user as { isBlocked?: boolean }).isBlocked === true) {
              throw new APIError("FORBIDDEN", { message: "Account unavailable" });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (!context.headers?.has("cookie") || context.path === "/sign-out") return;
        const session = await getSessionFromCtx(context, {
          disableCookieCache: true,
          disableRefresh: true,
        });
        if (session?.user.isBlocked === true) {
          throw new APIError("FORBIDDEN", { message: "Account unavailable" });
        }
      }),
    },
    plugins: [jwt({
      disableSettingJwtHeader: true,
      jwt: {
        issuer: config.baseURL,
        audience: config.baseURL,
        expirationTime: "5m",
        definePayload: () => ({}),
      },
    })],
    logger: { disabled: true },
    onAPIError: {
      onError: (error) => {
        if (!(error instanceof APIError) || error.status === "INTERNAL_SERVER_ERROR") {
          console.error("Authentication request failed.");
        }
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
