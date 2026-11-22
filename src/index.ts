import "dotenv/config";

import { getApplication } from "./bootstrap.js";

async function startServer(): Promise<void> {
  try {
    const { app, port } = await getApplication();
    const server = app.listen(port, () => {
      console.log(`WedPlan API listening on port ${port}.`);
    });
    server.on("error", () => {
      console.error("WedPlan could not bind the API listener.");
      process.exit(1);
    });
  } catch {
    process.exit(1);
  }
}

void startServer();
