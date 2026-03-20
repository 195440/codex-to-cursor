import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppConfig } from "./config";
import { errorPayload, ProxyError } from "./errors";
import { isProxyError, normalizeResponsesRequest } from "./normalize";
import { OpenAiUpstreamClient } from "./openai";
import { bridgeChatCompletionStream } from "./stream";
import { ChatCompletionRequest, ResponseStateStore } from "./types";
import { buildChatCompletionRequest, buildStoredRecord, translateChatCompletionResponse } from "./translate";

export interface BuildAppOptions {
  config: AppConfig;
  store: ResponseStateStore;
  fetchImpl?: typeof fetch;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  const upstream = new OpenAiUpstreamClient({
    baseUrl: options.config.openAiBaseUrl,
    fallbackApiKey: options.config.openAiApiKey,
    fetchImpl: options.fetchImpl,
    logger: app.log,
  });

  app.get("/healthz", async () => ({
    ok: true,
    wire_api: "responses",
    upstream_base_url: options.config.openAiBaseUrl,
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    try {
      if (!isRecord(request.body)) {
        throw new ProxyError(400, "request body must be a JSON object", {
          code: "invalid_request",
          param: "$",
        });
      }

      request.log.info(
        {
          requestBody: request.body,
          hasAuthorizationHeader: Boolean(request.headers.authorization),
        },
        "received /v1/chat/completions passthrough request",
      );

      const translatedRequest = buildChatCompletionsCompatibleRequest(
        request.body,
        options.store,
        request.log,
      );
      const upstreamResponse = await upstream.createChatCompletion(
        translatedRequest.chatRequest,
        request.headers.authorization,
      );

      if (!upstreamResponse.ok) {
        request.log.warn(
          {
            upstreamStatus: upstreamResponse.status,
          },
          "upstream returned non-success status for chat completions passthrough",
        );
        return relayUpstreamError(request, reply, upstreamResponse);
      }

      if ((request.body as { stream?: boolean }).stream === true) {
        request.log.info("starting chat completions passthrough stream");
        return relayStreamingSuccess(reply, upstreamResponse);
      }

      if (translatedRequest.storeRecord) {
        const chatResponse = await upstreamResponse.clone().json();
        const translated = translateChatCompletionResponse(
          translatedRequest.normalizedRequest!,
          chatResponse,
          translatedRequest.historyMessages ?? [],
        );
        options.store.set(
          buildStoredRecord(
            translated.response.id,
            options.config.stateTtlSeconds,
            translated.historyMessages,
            true,
          ),
        );
      }

      return relayJsonOrTextSuccess(reply, upstreamResponse);
    } catch (error) {
      if (isProxyError(error)) {
        request.log.warn(
          {
            err: error,
            statusCode: error.statusCode,
            code: error.code,
            param: error.param,
          },
          "chat completions passthrough failed with handled proxy error",
        );
        return reply.code(error.statusCode).send(errorPayload(error));
      }
      request.log.error({ err: error }, "unhandled chat completions passthrough error");
      return reply.code(500).send(
        errorPayload(
          new ProxyError(500, "unexpected proxy error", {
            type: "server_error",
            code: "proxy_internal_error",
          }),
        ),
      );
    }
  });

  app.setNotFoundHandler((request, reply) => {
    request.log.warn(
      {
        method: request.method,
        url: request.url,
      },
      "request hit unsupported route",
    );
    return reply.code(404).send({
      error: {
        message:
          "unsupported route. this proxy exposes POST /v1/responses, POST /v1/chat/completions, and GET /healthz.",
        type: "invalid_request_error",
        param: null,
        code: "route_not_supported",
      },
    });
  });

  app.post("/v1/responses", async (request, reply) => {
    try {
      options.store.gc();
      request.log.info(
        {
          requestBody: request.body,
          hasAuthorizationHeader: Boolean(request.headers.authorization),
        },
        "received /v1/responses request",
      );

      const normalized = normalizeResponsesRequest(request.body);
      request.log.debug(
        {
          normalized: {
            model: normalized.model,
            stream: normalized.stream,
            previousResponseId: normalized.previousResponseId,
            instructions: normalized.instructions,
            toolCount: normalized.tools.length,
            toolChoice: normalized.toolChoice,
            inputMessageCount: normalized.inputMessages.length,
            store: normalized.store,
            maxOutputTokens: normalized.maxOutputTokens,
            textFormat: normalized.textFormat,
            verbosity: normalized.verbosity,
            reasoningEffort: normalized.reasoningEffort,
          },
        },
        "normalized responses request",
      );
      const historyMessages = resolveHistoryMessages(normalized.previousResponseId, options.store);
      request.log.debug(
        {
          previousResponseId: normalized.previousResponseId,
          historyMessageCount: historyMessages.length,
        },
        "resolved replay history",
      );
      const chatRequest = buildChatCompletionRequest(normalized, historyMessages);
      request.log.debug(
        {
          translatedChatRequest: chatRequest,
        },
        "translated request to chat completions payload",
      );
      const upstreamResponse = await upstream.createChatCompletion(
        chatRequest,
        request.headers.authorization,
      );

      if (!upstreamResponse.ok) {
        request.log.warn(
          {
            upstreamStatus: upstreamResponse.status,
          },
          "upstream returned non-success status",
        );
        return relayUpstreamError(request, reply, upstreamResponse);
      }

      if (normalized.stream) {
        request.log.info("starting streaming bridge");
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-wire-api": "responses",
        });

        const result = await bridgeChatCompletionStream({
          upstream: upstreamResponse,
          writer: {
            write(chunk: string): void {
              reply.raw.write(chunk);
            },
            end(): void {
              reply.raw.end();
            },
          },
          normalized,
          historyMessages,
        });

        if (normalized.store) {
          options.store.set(
            buildStoredRecord(result.response.id, options.config.stateTtlSeconds, result.historyMessages, true),
          );
        }

        request.log.info(
          {
            responseId: result.response.id,
            outputCount: result.response.output.length,
            totalTokens: result.response.usage.total_tokens,
          },
          "completed streaming bridge",
        );

        return reply;
      }

      const chatResponse = await upstreamResponse.json();
      request.log.debug(
        {
          chatResponse,
        },
        "received upstream non-streaming response body",
      );
      const result = translateChatCompletionResponse(normalized, chatResponse, historyMessages);

      if (normalized.store) {
        options.store.set(
          buildStoredRecord(result.response.id, options.config.stateTtlSeconds, result.historyMessages, true),
        );
      }

      request.log.info(
        {
          responseId: result.response.id,
          outputCount: result.response.output.length,
          totalTokens: result.response.usage.total_tokens,
        },
        "sending translated responses payload",
      );

      return reply.code(200).send(result.response);
    } catch (error) {
      if (isProxyError(error)) {
        request.log.warn(
          {
            err: error,
            statusCode: error.statusCode,
            code: error.code,
            param: error.param,
          },
          "request failed with handled proxy error",
        );
        return reply.code(error.statusCode).send(errorPayload(error));
      }
      request.log.error({ err: error }, "unhandled proxy error");
      return reply.code(500).send(
        errorPayload(
          new ProxyError(500, "unexpected proxy error", {
            type: "server_error",
            code: "proxy_internal_error",
          }),
        ),
      );
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isProxyError(error)) {
      reply.code(error.statusCode).send(errorPayload(error));
      return;
    }
    const message = error instanceof Error ? error.message : "unexpected proxy error";
    reply.code(500).send(
      errorPayload(
        new ProxyError(500, message, {
          type: "server_error",
          code: "proxy_internal_error",
        }),
      ),
    );
  });

  return app;
}

function resolveHistoryMessages(previousResponseId: string | null, store: ResponseStateStore) {
  if (!previousResponseId) {
    return [];
  }
  const record = store.get(previousResponseId);
  if (!record) {
    throw new ProxyError(404, `previous_response_id '${previousResponseId}' was not found`, {
      code: "response_not_found",
      param: "previous_response_id",
    });
  }
  return record.messages;
}

async function relayUpstreamError(
  request: FastifyRequest,
  reply: FastifyReply,
  upstreamResponse: Response,
) {
  const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
  const text = await upstreamResponse.text();
  reply.code(upstreamResponse.status);
  reply.header("content-type", contentType);
  request.log.warn(
    {
      upstreamStatus: upstreamResponse.status,
      upstreamContentType: contentType,
      upstreamBody: text,
    },
    "relaying upstream error response",
  );

  try {
    return reply.send(JSON.parse(text));
  } catch {
    return reply.send({
      error: {
        message: text || "upstream request failed",
        type: "invalid_request_error",
        param: null,
        code: "upstream_error",
      },
    });
  }
}

async function relayJsonOrTextSuccess(reply: FastifyReply, upstreamResponse: Response) {
  const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
  const text = await upstreamResponse.text();
  reply.code(upstreamResponse.status);
  reply.header("content-type", contentType);

  try {
    return reply.send(JSON.parse(text));
  } catch {
    return reply.send(text);
  }
}

async function relayStreamingSuccess(reply: FastifyReply, upstreamResponse: Response) {
  reply.hijack();
  reply.raw.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-cache, no-transform",
    connection: upstreamResponse.headers.get("connection") ?? "keep-alive",
  });

  const body = upstreamResponse.body;
  if (!body) {
    reply.raw.end();
    return reply;
  }

  const reader = body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      reply.raw.write(Buffer.from(value));
    }
  }

  reply.raw.end();
  return reply;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CompatibleChatRequestResult {
  chatRequest: ChatCompletionRequest;
  storeRecord: boolean;
  normalizedRequest?: ReturnType<typeof normalizeResponsesRequest>;
  historyMessages?: ReturnType<typeof resolveHistoryMessages>;
}

function buildChatCompletionsCompatibleRequest(
  body: Record<string, unknown>,
  store: ResponseStateStore,
  logger: FastifyBaseLogger,
): CompatibleChatRequestResult {
  if (Array.isArray(body.messages)) {
    logger.debug("detected native chat completions payload");
    return {
      chatRequest: body as unknown as ChatCompletionRequest,
      storeRecord: false,
    };
  }

  if ("input" in body) {
    const compatibleResponsesRequest = pickCompatibleResponsesFields(body);
    const normalized = normalizeResponsesRequest(compatibleResponsesRequest);
    const historyMessages = resolveHistoryMessages(normalized.previousResponseId, store);
    const chatRequest = buildChatCompletionRequest(normalized, historyMessages);
    if (typeof body.user === "string") {
      chatRequest.user = body.user;
    }
    if (isRecord(body.stream_options) && typeof body.stream_options.include_usage === "boolean") {
      chatRequest.stream_options = {
        include_usage: body.stream_options.include_usage,
      };
    }
    logger.debug(
      {
        compatibleResponsesRequest,
        translatedChatRequest: chatRequest,
      },
      "translated responses-style chat/completions request",
    );
    return {
      chatRequest,
      storeRecord: normalized.store && !normalized.stream,
      normalizedRequest: normalized,
      historyMessages,
    };
  }

  throw new ProxyError(
    400,
    "chat completions request must include messages, or use a responses-style input payload",
    {
      code: "invalid_request",
      param: "messages",
    },
  );
}

function pickCompatibleResponsesFields(body: Record<string, unknown>): Record<string, unknown> {
  const compatible: Record<string, unknown> = {};
  const allowedFields = [
    "model",
    "input",
    "instructions",
    "previous_response_id",
    "stream",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_output_tokens",
    "text",
    "reasoning",
    "metadata",
    "store",
    "safety_identifier",
  ];
  for (const field of allowedFields) {
    if (field in body) {
      compatible[field] = body[field];
    }
  }
  return compatible;
}
