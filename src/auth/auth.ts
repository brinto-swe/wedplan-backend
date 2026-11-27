import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { jwt } from "better-auth/plugins";

import { client, getDatabase } from "../db/mongodb.js";
import { accountOptions, authCollections, authDatabase, initialUserFields, userFields } from "./schema.js";
import { profileUpdate } from "./profile.js";

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
    emailAndPassword: { enabled: true, minPasswordLength: 6 },
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
        if (context.path === "/sign-up/email") {
          const password: unknown = context.body?.password;
          if (typeof password === "string" && (password.length < 6 || !/[A-Z]/.test(password) || !/[a-z]/.test(password))) {
            throw new APIError("BAD_REQUEST", {
              code: "SIGNUP_PASSWORD_REQUIREMENTS",
              message: "Use at least 6 characters, including an uppercase (A–Z) and a lowercase (a–z) letter.",
            });
          }
        }
        if (!context.headers?.has("cookie") || context.path === "/sign-out") return;
        const session = await getSessionFromCtx(context, {
          disableCookieCache: true,
          disableRefresh: true,
        });
        if (session?.user.isBlocked === true) {
          throw new APIError("FORBIDDEN", { message: "Account unavailable" });
        }
        if (context.path === "/update-user" && session) {
          const changes = profileUpdate.safeParse(context.body);
          if (!changes.success || (changes.data.businessName !== undefined && session.user.role !== "vendor")) {
            throw new APIError("BAD_REQUEST", { message: "Invalid profile update" });
          }
          return { context: { body: changes.data } };
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
