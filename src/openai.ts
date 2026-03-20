import { FastifyBaseLogger } from "fastify";
import { ProxyError } from "./errors";
import { ChatCompletionRequest } from "./types";

export interface UpstreamClientOptions {
  baseUrl: string;
  fallbackApiKey?: string;
  fetchImpl?: typeof fetch;
  logger?: FastifyBaseLogger;
}

export class OpenAiUpstreamClient {
  private readonly baseUrl: string;
  private readonly fallbackApiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: FastifyBaseLogger;

  constructor(options: UpstreamClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fallbackApiKey = options.fallbackApiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async createChatCompletion(
    request: ChatCompletionRequest,
    inboundAuthorization?: string,
  ): Promise<Response> {
    const authorization = resolveAuthorization(inboundAuthorization, this.fallbackApiKey);
    this.logger?.debug(
      {
        upstreamUrl: `${this.baseUrl}/v1/chat/completions`,
        usingInboundAuthorization: Boolean(
          typeof inboundAuthorization === "string" && inboundAuthorization.trim() !== "",
        ),
        request: request,
      },
      "forwarding translated chat completion request upstream",
    );
    try {
      return await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "upstream request failed";
      throw new ProxyError(502, `upstream request failed: ${message}`, {
        type: "server_error",
        code: "upstream_connection_error",
      });
    }
  }
}

export function resolveAuthorization(
  inboundAuthorization?: string,
  fallbackApiKey?: string,
): string {
  if (typeof inboundAuthorization === "string" && inboundAuthorization.trim() !== "") {
    return inboundAuthorization;
  }
  if (fallbackApiKey) {
    return `Bearer ${fallbackApiKey}`;
  }
  throw new ProxyError(401, "missing Authorization header and OPENAI_API_KEY fallback", {
    type: "authentication_error",
    code: "missing_api_key",
    param: "Authorization",
  });
}
