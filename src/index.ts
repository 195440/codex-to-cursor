import { loadConfig, loadEnvFile } from "./config";
import { buildApp } from "./server";
import { MemoryResponseStateStore } from "./store";

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const store = new MemoryResponseStateStore();
  const app = buildApp({
    config,
    store,
  });

  const gcInterval = setInterval(() => {
    store.gc();
  }, 60_000);
  gcInterval.unref();

  await app.listen({
    port: config.port,
    host: "0.0.0.0",
  });

  app.log.info(
    {
      port: config.port,
      upstreamBaseUrl: config.openAiBaseUrl,
      hasFallbackApiKey: Boolean(config.openAiApiKey),
      bodyLimitBytes: config.bodyLimitBytes,
      upstreamUserAgent: config.upstreamUserAgent,
    },
    "responses proxy listening",
  );
}

void main();
