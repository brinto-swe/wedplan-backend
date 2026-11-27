import { z } from "zod";
import { hostedImageUrl } from "../uploads/image-url.js";
import type { Role } from "./auth.js";

export const profileUpdate = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  image: hostedImageUrl.nullable().optional(),
  businessName: z.string().trim().max(120).optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one profile field");

type ProfileUser = {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  image?: string | null;
  businessName?: string;
  createdAt?: Date;
};

export function safeProfile(user: ProfileUser, role: Role) {
  // OAuth profiles can carry provider-supplied HTTPS avatars.
  const avatar = typeof user.image === "string" ? URL.parse(user.image) : null;
  const image = avatar?.protocol === "https:" && !avatar.username && !avatar.password ? avatar.href : null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role,
    image,
    emailVerified: user.emailVerified === true,
    createdAt: user.createdAt,
    ...(role === "vendor" && { businessName: typeof user.businessName === "string" ? user.businessName : "" }),
  };
}
