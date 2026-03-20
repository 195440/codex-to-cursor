import { createId } from "./id";
import {
  ChatAssistantContentPart,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  NormalizedResponsesRequest,
  ResponseObject,
  ResponseOutputContentPart,
  ResponseOutputItem,
  StoredResponseRecord,
} from "./types";
import { buildChatResponseFormat, buildChatToolChoice, buildChatTools } from "./normalize";

export interface TranslationResult {
  response: ResponseObject;
  historyMessages: ChatMessage[];
}

export function buildChatCompletionRequest(
  normalized: NormalizedResponsesRequest,
  historyMessages: ChatMessage[],
): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (normalized.instructions) {
    messages.push({
      role: "developer",
      content: normalized.instructions,
    });
  }
  messages.push(...historyMessages, ...normalized.inputMessages);

  return {
    model: normalized.model,
    messages,
    tools: buildChatTools(normalized.tools),
    tool_choice: buildChatToolChoice(normalized.toolChoice),
    parallel_tool_calls: normalized.parallelToolCalls,
    temperature: normalized.temperature,
    top_p: normalized.topP,
    presence_penalty: normalized.presencePenalty,
    frequency_penalty: normalized.frequencyPenalty,
    max_completion_tokens: normalized.maxOutputTokens,
    response_format: buildChatResponseFormat(normalized.textFormat),
    verbosity: normalized.verbosity,
    reasoning_effort: normalized.reasoningEffort,
    metadata: Object.keys(normalized.metadata).length ? normalized.metadata : undefined,
    store: normalized.raw.store === true,
    stream: normalized.stream,
    stream_options: normalized.stream ? { include_usage: true } : undefined,
    safety_identifier: normalized.safetyIdentifier,
  };
}

export function translateChatCompletionResponse(
  normalized: NormalizedResponsesRequest,
  chatResponse: ChatCompletionResponse,
  historyMessages: ChatMessage[],
  responseId: string = createId("resp"),
): TranslationResult {
  const message = chatResponse.choices[0]?.message ?? { role: "assistant" as const };
  const output = buildResponseOutput(message);
  const assistantHistoryMessage = buildAssistantHistoryMessage(message);

  return {
    response: {
      id: responseId,
      object: "response",
      created_at: chatResponse.created,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: normalized.instructions,
      max_output_tokens: normalized.maxOutputTokens ?? null,
      model: chatResponse.model,
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
        input_tokens: chatResponse.usage?.prompt_tokens ?? 0,
        input_tokens_details: {
          cached_tokens: chatResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        output_tokens: chatResponse.usage?.completion_tokens ?? 0,
        output_tokens_details: {
          reasoning_tokens: chatResponse.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        },
        total_tokens: chatResponse.usage?.total_tokens ?? 0,
      },
      metadata: normalized.metadata,
      safety_identifier: normalized.safetyIdentifier,
    },
    historyMessages: [...historyMessages, ...normalized.inputMessages, assistantHistoryMessage].filter(
      Boolean,
    ) as ChatMessage[],
  };
}

export function buildStoredRecord(
  responseId: string,
  ttlSeconds: number,
  historyMessages: ChatMessage[],
  store: boolean,
): StoredResponseRecord {
  const now = Date.now();
  return {
    id: responseId,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    messages: historyMessages,
    store,
  };
}

function buildResponseOutput(message: ChatCompletionResponse["choices"][number]["message"]): ResponseOutputItem[] {
  const output: ResponseOutputItem[] = [];
  const content = normalizeAssistantMessageParts(message);
  if (content.length) {
    output.push({
      type: "message",
      id: createId("msg"),
      status: "completed",
      role: "assistant",
      content,
    });
  }
  for (const toolCall of message.tool_calls ?? []) {
    output.push(buildToolCallOutput(toolCall));
  }
  return output;
}

function buildToolCallOutput(toolCall: ChatToolCall): ResponseOutputItem {
  if (toolCall.type === "function" && toolCall.function) {
    return {
      type: "function_call",
      id: createId("fc"),
      status: "completed",
      call_id: toolCall.id || createId("call"),
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    };
  }
  return {
    type: "custom_tool_call",
    id: createId("ctc"),
    status: "completed",
    call_id: toolCall.id || createId("call"),
    name: toolCall.custom?.name ?? "custom_tool",
    input: toolCall.custom?.input ?? "",
  };
}

function buildAssistantHistoryMessage(
  message: ChatCompletionResponse["choices"][number]["message"],
): ChatMessage {
  const assistant: ChatMessage = {
    role: "assistant",
  };
  if (message.refusal) {
    assistant.refusal = message.refusal;
  }
  if (message.content !== undefined && message.content !== null) {
    assistant.content = message.content as string | ChatAssistantContentPart[];
  }
  if (message.tool_calls?.length) {
    assistant.tool_calls = message.tool_calls;
  }
  return assistant;
}

function normalizeAssistantMessageParts(
  message: ChatCompletionResponse["choices"][number]["message"],
): ResponseOutputContentPart[] {
  const parts: ResponseOutputContentPart[] = [];
  if (typeof message.content === "string" && message.content.length) {
    parts.push({
      type: "output_text",
      text: message.content,
      annotations: [],
    });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text" && part.text.length) {
        parts.push({
          type: "output_text",
          text: part.text,
          annotations: [],
        });
      }
      if (part.type === "refusal" && part.refusal.length) {
        parts.push({
          type: "refusal",
          refusal: part.refusal,
        });
      }
    }
  }
  if (message.refusal) {
    parts.push({
      type: "refusal",
      refusal: message.refusal,
    });
  }
  return mergeAdjacentTextParts(parts);
}

function mergeAdjacentTextParts(parts: ResponseOutputContentPart[]): ResponseOutputContentPart[] {
  const merged: ResponseOutputContentPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous?.type === "output_text" && part.type === "output_text") {
      previous.text += part.text;
      continue;
    }
    if (previous?.type === "refusal" && part.type === "refusal") {
      previous.refusal += part.refusal;
      continue;
    }
    merged.push({ ...part });
  }
  return merged;
}
