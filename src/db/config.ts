import { z } from "zod";

export const mongoEnvSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/\S+$/),
  MONGODB_DATABASE: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
});
