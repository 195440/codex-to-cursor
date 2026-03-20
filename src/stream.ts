import { createId } from "./id";
import {
  ChatAssistantContentPart,
  ChatCompletionChunk,
  ChatMessage,
  NormalizedResponsesRequest,
  ResponseObject,
  ResponseOutputContentPart,
  ResponseOutputItem,
} from "./types";

type ChatChunkToolCallDelta = NonNullable<
  NonNullable<ChatCompletionChunk["choices"][number]["delta"]>["tool_calls"]
>[number];

interface StreamToolAggregate {
  index: number;
  itemId: string;
  callId: string;
  type: "function" | "custom";
  name: string;
  arguments: string;
  input: string;
}

interface StreamMessageAggregate {
  itemId: string;
  parts: ResponseOutputContentPart[];
}

interface StreamAggregate {
  responseId: string;
  createdAt: number;
  model: string;
  sequence: number;
  message?: StreamMessageAggregate;
  tools: Map<number, StreamToolAggregate>;
  outputOrder: Array<{ kind: "message" } | { kind: "tool"; index: number }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  };
}

export interface StreamWriter {
  write(chunk: string): void;
  end(): void;
}

export interface StreamBridgeResult {
  response: ResponseObject;
  historyMessages: ChatMessage[];
}

export async function bridgeChatCompletionStream(options: {
  upstream: Response;
  writer: StreamWriter;
  normalized: NormalizedResponsesRequest;
  historyMessages: ChatMessage[];
  responseId?: string;
}): Promise<StreamBridgeResult> {
  const responseId = options.responseId ?? createId("resp");
  const aggregate: StreamAggregate = {
    responseId,
    createdAt: Math.floor(Date.now() / 1000),
    model: options.normalized.model,
    sequence: 0,
    tools: new Map(),
    outputOrder: [],
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
  };

  writeEvent(options.writer, aggregate, "response.created", {
    response: {
      id: responseId,
      object: "response",
      created_at: aggregate.createdAt,
      model: options.normalized.model,
      status: "in_progress",
    },
  });

  const body = options.upstream.body;
  if (!body) {
    throw new Error("upstream stream response body is missing");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parsed = extractSseEvents(buffer);
    buffer = parsed.remainder;
    for (const event of parsed.events) {
      if (event.data === "[DONE]") {
        return finalizeStream(
          options.writer,
          aggregate,
          options.normalized,
          options.historyMessages,
        );
      }
      if (!event.data) {
        continue;
      }
      processChunk(options.writer, aggregate, JSON.parse(event.data) as ChatCompletionChunk);
    }
  }

  if (buffer.trim()) {
    const trailing = parseSseEvent(buffer);
    if (trailing?.data && trailing.data !== "[DONE]") {
      processChunk(options.writer, aggregate, JSON.parse(trailing.data) as ChatCompletionChunk);
    }
  }

  return finalizeStream(options.writer, aggregate, options.normalized, options.historyMessages);
}

function processChunk(
  writer: StreamWriter,
  aggregate: StreamAggregate,
  chunk: ChatCompletionChunk,
): void {
  aggregate.model = chunk.model || aggregate.model;
  if (chunk.usage) {
    aggregate.usage = {
      promptTokens: chunk.usage.prompt_tokens ?? 0,
      completionTokens: chunk.usage.completion_tokens ?? 0,
      totalTokens: chunk.usage.total_tokens ?? 0,
      cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (!delta) {
      continue;
    }
    if (delta.content) {
      const { message, contentIndex } = ensureMessagePart(writer, aggregate, "output_text");
      const part = message.parts[contentIndex] as Extract<ResponseOutputContentPart, { type: "output_text" }>;
      part.text += delta.content;
      writeEvent(writer, aggregate, "response.output_text.delta", {
        item_id: message.itemId,
        output_index: findOutputIndex(aggregate, { kind: "message" }),
        content_index: contentIndex,
        delta: delta.content,
      });
    }
    if (delta.refusal) {
      const { message, contentIndex } = ensureMessagePart(writer, aggregate, "refusal");
      const part = message.parts[contentIndex] as Extract<ResponseOutputContentPart, { type: "refusal" }>;
      part.refusal += delta.refusal;
      writeEvent(writer, aggregate, "response.refusal.delta", {
        item_id: message.itemId,
        output_index: findOutputIndex(aggregate, { kind: "message" }),
        content_index: contentIndex,
        delta: delta.refusal,
      });
    }
    for (const toolCallDelta of delta.tool_calls ?? []) {
      const detectedType = toolCallDelta.type ?? inferToolType(toolCallDelta);
      const tool = ensureToolAggregate(writer, aggregate, toolCallDelta.index, detectedType);
      if (toolCallDelta.id) {
        tool.callId = toolCallDelta.id;
      }
      if (tool.type === "function") {
        if (toolCallDelta.function?.name) {
          tool.name = toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          tool.arguments += toolCallDelta.function.arguments;
          writeEvent(writer, aggregate, "response.function_call_arguments.delta", {
            item_id: tool.itemId,
            output_index: findOutputIndex(aggregate, { kind: "tool", index: tool.index }),
            call_id: tool.callId,
            delta: toolCallDelta.function.arguments,
          });
        }
      } else {
        if (toolCallDelta.custom?.name) {
          tool.name = toolCallDelta.custom.name;
        }
        if (toolCallDelta.custom?.input) {
          tool.input += toolCallDelta.custom.input;
          writeEvent(writer, aggregate, "response.custom_tool_call_input.delta", {
            item_id: tool.itemId,
            output_index: findOutputIndex(aggregate, { kind: "tool", index: tool.index }),
            call_id: tool.callId,
            delta: toolCallDelta.custom.input,
          });
        }
      }
    }
  }
}

function inferToolType(
  toolCallDelta: ChatChunkToolCallDelta,
): "function" | "custom" {
  if (toolCallDelta.custom) {
    return "custom";
  }
  return "function";
}

function ensureMessagePart(
  writer: StreamWriter,
  aggregate: StreamAggregate,
  partType: "output_text" | "refusal",
): { message: StreamMessageAggregate; contentIndex: number } {
  const message = ensureMessageAggregate(writer, aggregate);
  const lastIndex = message.parts.length - 1;
  const current = message.parts[lastIndex];
  if (current?.type === partType) {
    return {
      message,
      contentIndex: lastIndex,
    };
  }

  const part =
    partType === "output_text"
      ? {
          type: "output_text" as const,
          text: "",
          annotations: [],
        }
      : {
          type: "refusal" as const,
          refusal: "",
        };
  message.parts.push(part);
  const contentIndex = message.parts.length - 1;
  writeEvent(writer, aggregate, "response.content_part.added", {
    item_id: message.itemId,
    output_index: findOutputIndex(aggregate, { kind: "message" }),
    content_index: contentIndex,
    part,
  });
  return {
    message,
    contentIndex,
  };
}

function ensureMessageAggregate(writer: StreamWriter, aggregate: StreamAggregate): StreamMessageAggregate {
  if (!aggregate.message) {
    aggregate.message = {
      itemId: createId("msg"),
      parts: [],
    };
    aggregate.outputOrder.push({ kind: "message" });
    writeEvent(writer, aggregate, "response.output_item.added", {
      output_index: findOutputIndex(aggregate, { kind: "message" }),
      item: {
        type: "message",
        id: aggregate.message.itemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
  }
  return aggregate.message;
}

function ensureToolAggregate(
  writer: StreamWriter,
  aggregate: StreamAggregate,
  index: number,
  type: "function" | "custom",
): StreamToolAggregate {
  const existing = aggregate.tools.get(index);
  if (existing) {
    if (type && existing.type !== type) {
      existing.type = type;
    }
    return existing;
  }

  const tool: StreamToolAggregate = {
    index,
    itemId: createId(type === "function" ? "fc" : "ctc"),
    callId: createId("call"),
    type,
    name: type === "function" ? "function" : "custom_tool",
    arguments: "",
    input: "",
  };
  aggregate.tools.set(index, tool);
  aggregate.outputOrder.push({ kind: "tool", index });

  writeEvent(writer, aggregate, "response.output_item.added", {
    output_index: findOutputIndex(aggregate, { kind: "tool", index }),
    item:
      type === "function"
        ? {
            type: "function_call",
            id: tool.itemId,
            status: "in_progress",
            call_id: tool.callId,
            name: tool.name,
            arguments: "",
          }
        : {
            type: "custom_tool_call",
            id: tool.itemId,
            status: "in_progress",
            call_id: tool.callId,
            name: tool.name,
            input: "",
          },
  });

  return tool;
}

function findOutputIndex(
  aggregate: StreamAggregate,
  target: { kind: "message" } | { kind: "tool"; index: number },
): number {
  return aggregate.outputOrder.findIndex((entry) => {
    if (target.kind === "message") {
      return entry.kind === "message";
    }
    return entry.kind === "tool" && entry.index === target.index;
  });
}

function finalizeStream(
  writer: StreamWriter,
  aggregate: StreamAggregate,
  normalized: NormalizedResponsesRequest,
  historyMessages: ChatMessage[],
): StreamBridgeResult {
  const output: ResponseOutputItem[] = [];

  for (const entry of aggregate.outputOrder) {
    if (entry.kind === "message" && aggregate.message) {
      const outputIndex = findOutputIndex(aggregate, { kind: "message" });
      for (let contentIndex = 0; contentIndex < aggregate.message.parts.length; contentIndex += 1) {
        const part = aggregate.message.parts[contentIndex];
        if (part.type === "output_text") {
          writeEvent(writer, aggregate, "response.output_text.done", {
            item_id: aggregate.message.itemId,
            output_index: outputIndex,
            content_index: contentIndex,
            text: part.text,
          });
        } else {
          writeEvent(writer, aggregate, "response.refusal.done", {
            item_id: aggregate.message.itemId,
            output_index: outputIndex,
            content_index: contentIndex,
            refusal: part.refusal,
          });
        }
        writeEvent(writer, aggregate, "response.content_part.done", {
          item_id: aggregate.message.itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      }
      const item: ResponseOutputItem = {
        type: "message",
        id: aggregate.message.itemId,
        status: "completed",
        role: "assistant",
        content: aggregate.message.parts,
      };
      writeEvent(writer, aggregate, "response.output_item.done", {
        output_index: outputIndex,
        item,
      });
      output.push(item);
      continue;
    }

    if (entry.kind !== "tool") {
      continue;
    }
    const tool = aggregate.tools.get(entry.index);
    if (!tool) {
      continue;
    }
    const outputIndex = findOutputIndex(aggregate, { kind: "tool", index: entry.index });
    if (tool.type === "function") {
      writeEvent(writer, aggregate, "response.function_call_arguments.done", {
        item_id: tool.itemId,
        output_index: outputIndex,
        call_id: tool.callId,
        arguments: tool.arguments,
      });
      const item: ResponseOutputItem = {
        type: "function_call",
        id: tool.itemId,
        status: "completed",
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
      };
      writeEvent(writer, aggregate, "response.output_item.done", {
        output_index: outputIndex,
        item,
      });
      output.push(item);
      continue;
    }

    writeEvent(writer, aggregate, "response.custom_tool_call_input.done", {
      item_id: tool.itemId,
      output_index: outputIndex,
      call_id: tool.callId,
      input: tool.input,
    });
    const item: ResponseOutputItem = {
      type: "custom_tool_call",
      id: tool.itemId,
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
      input: tool.input,
    };
    writeEvent(writer, aggregate, "response.output_item.done", {
      output_index: outputIndex,
      item,
    });
    output.push(item);
  }

  const response: ResponseObject = {
    id: aggregate.responseId,
    object: "response",
    created_at: aggregate.createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: normalized.instructions,
    max_output_tokens: normalized.maxOutputTokens ?? null,
    model: aggregate.model,
    output,
    parallel_tool_calls: normalized.parallelToolCalls,
    previous_response_id: normalized.previousResponseId,
    reasoning: {
      effort: normalized.reasoningEffort ?? null,
      summary: null,
    },
    store: normalized.store,
    temperature: normalized.temperature ?? 1,
    text: {
      format: normalized.textFormat,
      verbosity: normalized.verbosity,
    },
    tool_choice: normalized.toolChoice,
    tools: normalized.tools,
    top_p: normalized.topP ?? 1,
    truncation: "disabled",
    usage: {
      input_tokens: aggregate.usage.promptTokens,
      input_tokens_details: {
        cached_tokens: aggregate.usage.cachedTokens,
      },
      output_tokens: aggregate.usage.completionTokens,
      output_tokens_details: {
        reasoning_tokens: aggregate.usage.reasoningTokens,
      },
      total_tokens: aggregate.usage.totalTokens,
    },
    metadata: normalized.metadata,
    safety_identifier: normalized.safetyIdentifier,
  };

  writeEvent(writer, aggregate, "response.completed", {
    response,
  });
  writer.write("data: [DONE]\n\n");
  writer.end();

  return {
    response,
    historyMessages: [...historyMessages, ...normalized.inputMessages, buildAssistantHistoryMessage(aggregate)],
  };
}

function buildAssistantHistoryMessage(aggregate: StreamAggregate): ChatMessage {
  const contentParts: ChatAssistantContentPart[] = [];
  if (aggregate.message) {
    for (const part of aggregate.message.parts) {
      if (part.type === "output_text") {
        contentParts.push({
          type: "text",
          text: part.text,
        });
      } else {
        contentParts.push({
          type: "refusal",
          refusal: part.refusal,
        });
      }
    }
  }

  const toolCalls = [...aggregate.tools.values()]
    .sort((left, right) => left.index - right.index)
    .map((tool) =>
      tool.type === "function"
        ? {
            id: tool.callId,
            type: "function" as const,
            function: {
              name: tool.name,
              arguments: tool.arguments,
            },
          }
        : {
            id: tool.callId,
            type: "custom" as const,
            custom: {
              name: tool.name,
              input: tool.input,
            },
          },
    );

  const message: ChatMessage = {
    role: "assistant",
  };
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    message.content = contentParts[0].text;
  } else if (contentParts.length > 0) {
    message.content = contentParts;
  }
  const refusal = contentParts
    .filter((part): part is Extract<ChatAssistantContentPart, { type: "refusal" }> => part.type === "refusal")
    .map((part) => part.refusal)
    .join("");
  if (refusal) {
    message.refusal = refusal;
  }
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }
  return message;
}

function writeEvent(
  writer: StreamWriter,
  aggregate: StreamAggregate,
  type: string,
  payload: Record<string, unknown>,
): void {
  aggregate.sequence += 1;
  writer.write(`event: ${type}\n`);
  writer.write(`data: ${JSON.stringify({ type, sequence_number: aggregate.sequence, ...payload })}\n\n`);
}

function extractSseEvents(buffer: string): { events: Array<{ event?: string; data: string }>; remainder: string } {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const segments = normalized.split("\n\n");
  const remainder = segments.pop() ?? "";
  return {
    events: segments.map((segment) => parseSseEvent(segment)).filter(Boolean) as Array<{
      event?: string;
      data: string;
    }>,
    remainder,
  };
}

function parseSseEvent(raw: string): { event?: string; data: string } | null {
  const lines = raw.split("\n");
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!event && !dataLines.length) {
    return null;
  }
  return {
    event,
    data: dataLines.join("\n"),
  };
}

export function collectSseEvents(serialized: string): Array<{ event?: string; data: string }> {
  return extractSseEvents(serialized).events;
}
