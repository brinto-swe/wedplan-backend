import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import { client, getDatabase } from "../db/mongodb.js";

export type Role = "customer" | "vendor" | "admin";

export function createAuth(config: {
  origin: string;
  baseURL: string;
  secret: string;
  google: { clientId: string; clientSecret: string };
  github: { clientId: string; clientSecret: string };
}) {
  return betterAuth({
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.origin],
    database: mongodbAdapter(getDatabase(), { client }),
    emailAndPassword: { enabled: true },
    socialProviders: { google: config.google, github: config.github },
    account: { accountLinking: { enabled: false } },
    user: {
      additionalFields: {
        role: { type: "string", required: false, input: false, defaultValue: "customer" },
        isBlocked: { type: "boolean", required: false, input: false, defaultValue: false },
        businessName: { type: "string", required: false, defaultValue: "" },
        subscriptionPlan: { type: "string", required: false, input: false, defaultValue: "free" },
        subscriptionExpiresAt: { type: "date", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => ({
            data: {
              ...user,
              role: context?.path === "/sign-up/email" && context.body?.role === "vendor"
                ? "vendor"
                : "customer",
              isBlocked: false,
              subscriptionPlan: "free",
              subscriptionExpiresAt: null,
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
