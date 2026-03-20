import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  openAiBaseUrl: string;
  openAiApiKey?: string;
  stateTtlSeconds: number;
  bodyLimitBytes: number;
  upstreamUserAgent: string;
  logLevel: string;
}

export const DEFAULT_UPSTREAM_USER_AGENT =
  "codex-tui/0.115.0 (Ubuntu 24.4.0; x86_64) vscode/2.7.0-pre.96.patch.0 (codex-tui; 0.115.0)";

export function loadEnvFile(envPath: string = ".env", env: NodeJS.ProcessEnv = process.env): void {
  const path = resolve(envPath);
  if (!existsSync(path)) {
    return;
  }

  const contents = readFileSync(path, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? "3060"),
    openAiBaseUrl:
      env.OPENAI_BASE_URL ?? env.UPSTREAM_BASE_URL ?? "http://openclaw.195440.com:3030",
    openAiApiKey: env.OPENAI_API_KEY,
    stateTtlSeconds: Number(env.STATE_TTL_SECONDS ?? "86400"),
    bodyLimitBytes: Number(env.BODY_LIMIT_MB ?? "20") * 1024 * 1024,
    upstreamUserAgent: env.UPSTREAM_USER_AGENT ?? DEFAULT_UPSTREAM_USER_AGENT,
    logLevel: env.LOG_LEVEL ?? "debug",
  };
}
