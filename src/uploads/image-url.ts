import { z } from "zod";

export const hostedImageUrl = z.string().max(2048).refine((value) => {
  if (!/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return false;
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.host === "i.ibb.co" &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname !== "/";
}, "Use an HTTPS image URL hosted on i.ibb.co");
