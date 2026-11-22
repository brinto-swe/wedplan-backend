import express from "express";

import { getApplication } from "./src/bootstrap.js";

const app = express();
app.disable("x-powered-by");

app.use(async (request, response, next) => {
  const application = await getApplication().catch(() => undefined);
  if (!application) {
    response.set("Cache-Control", "no-store");
    response.status(503).json({ error: "API initialization failed. Try again shortly." });
    return;
  }
  application.app(request, response, next);
});

export default app;
