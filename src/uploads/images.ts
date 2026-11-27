import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";

import type { Auth } from "../auth/auth.js";
import { requireBearerUser } from "../auth/protection.js";

const maxImageBytes = 5 * 1024 * 1024;
const maxRequestBytes = 20 * 1024 * 1024;
const maxImages = 10;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const pngEnd = Buffer.from("0000000049454e44ae426082", "hex");

class UploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function imageFormat(bytes: Buffer) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(pngSignature) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.subarray(-12).equals(pngEnd)) return { mime: "image/png", extension: "png" };

  if (bytes.length >= 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[3] !== 0 && bytes[3] !== 0xd9 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    return { mime: "image/jpeg", extension: "jpg" };
  }

  if (bytes.length >= 26 && bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8 &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) {
    const chunkSize = bytes.readUInt32LE(16);
    if (chunkSize > 0 && 20 + chunkSize + (chunkSize % 2) <= bytes.length) {
      return { mime: "image/webp", extension: "webp" };
    }
  }
}

function httpsImageUrl(value: string) {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.host === "i.ibb.co" &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname !== "/";
}

const imageUrl = z.string().max(2048).refine(httpsImageUrl);
const hostedImage = z.object({
  success: z.literal(true),
  data: z.object({ url: imageUrl, display_url: imageUrl.nullish() }),
});

async function readImages(body: Buffer, contentType: string) {
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw new UploadError(400, "Malformed multipart upload");
  }
  const files = [...form];
  if (!files.length) throw new UploadError(400, "Provide at least one image");
  if (files.length > maxImages) throw new UploadError(413, "Upload at most 10 images per request");

  return Promise.all(files.map(async ([field, file]) => {
    if (field !== "images" || typeof file === "string") {
      throw new UploadError(400, "Use the images field for each image file");
    }
    if (file.size === 0) throw new UploadError(400, "Empty image files are not allowed");
    if (file.size > maxImageBytes) throw new UploadError(413, "Images must be at most 5 MiB each");
    const bytes = Buffer.from(await file.arrayBuffer());
    const format = imageFormat(bytes);
    if (!format || (file.type && file.type !== "application/octet-stream" &&
      file.type !== format.mime && !(format.mime === "image/jpeg" && file.type === "image/jpg"))) {
      throw new UploadError(415, "Use an actual JPEG, PNG or WebP image with a matching content type");
    }
    return { file: new Blob([bytes], { type: format.mime }), extension: format.extension };
  }));
}

export function imageUploadRouter(auth: Auth, apiKey?: string, fetchImage: typeof fetch = fetch) {
  const router = express.Router();
  const key = apiKey?.trim();
  router.post(
    "/images",
    requireBearerUser(auth, ["vendor", "customer"]),
    (request, _response, next) => {
      if (!key) throw new UploadError(503, "Image uploads are unavailable");
      if (!/^multipart\/form-data(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
        throw new UploadError(415, "Use multipart/form-data to upload images");
      }
      next();
    },
    express.raw({ type: "multipart/form-data", limit: maxRequestBytes, inflate: false }),
    async (request, response) => {
      if (!Buffer.isBuffer(request.body) || !request.body.length) {
        throw new UploadError(400, "Provide at least one image");
      }
      const images = await readImages(request.body, request.get("content-type") ?? "");
      const endpoint = new URL("https://api.imgbb.com/1/upload");
      endpoint.searchParams.set("key", key!);
      const batchDeadline = AbortSignal.timeout(25_000);
      const uploaded = [];
      for (const image of images) {
        const form = new FormData();
        form.set("image", image.file, "image." + image.extension);
        const signal = AbortSignal.any([batchDeadline, AbortSignal.timeout(8_000)]);
        try {
          const upstream = await fetchImage(endpoint, { method: "POST", body: form, redirect: "error", signal });
          if (!upstream.ok) {
            await upstream.body?.cancel();
            throw new Error("Upload failed");
          }
          const parsed = hostedImage.parse(await upstream.json()).data;
          uploaded.push({ url: parsed.url, ...(parsed.display_url && { displayUrl: parsed.display_url }) });
        } catch {
          if (signal.aborted) throw new UploadError(504, "Image hosting timed out");
          throw new UploadError(502, "Image hosting could not complete the upload");
        }
      }
      response.status(201).json({ data: uploaded });
    },
  );
  const uploadErrors: ErrorRequestHandler = (error, _request, response, next) => {
    if (error instanceof UploadError) response.status(error.status).json({ error: error.message });
    else if (error?.type === "entity.too.large") response.status(413).json({ error: "Multipart uploads must be at most 20 MiB" });
    else if (error?.type === "encoding.unsupported") response.status(415).json({ error: "Compressed uploads are not supported" });
    else if (error?.type === "request.size.invalid" || error?.type === "request.aborted") {
      response.status(400).json({ error: "Malformed multipart upload" });
    } else next(error);
  };
  router.use(uploadErrors);
  return router;
}
