#!/usr/bin/env node
import { startServer } from "./server.js";

startServer().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[skills-mcp] Fatal error: ${message}\n`);
  process.exit(1);
});
