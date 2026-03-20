import {
  ChatAssistantContentPart,
  ChatContentPart,
  ChatMessage,
  ChatResponseFormat,
  ChatTextPart,
  ChatTool,
  ChatToolCall,
  ChatToolChoice,
  NormalizedResponsesRequest,
  ResponseCustomTool,
  ResponseFunctionTool,
  ResponseMessageContentPart,
  ResponseTextFormat,
  ResponseTool,
  ResponseToolChoice,
  ResponsesInputItem,
  ResponsesRequest,
} from "./types";
import { ProxyError, invalidField, unsupportedFeature } from "./errors";

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
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
]);

const UNSUPPORTED_TOP_LEVEL_FIELDS = new Map<string, string>([
  ["prompt", "prompt-based responses are not supported by this proxy"],
  ["conversation", "conversation objects are not supported by this proxy"],
  ["include", "include is not supported by this proxy"],
  ["background", "background mode is not supported by this proxy"],
  ["max_tool_calls", "max_tool_calls is not supported by this proxy"],
  ["truncation", "truncation control is not supported by this proxy"],
  ["input_file", "file inputs are not supported by this proxy"],
  ["audio", "audio input/output is not supported by this proxy"],
  ["modalities", "audio/image output modalities are not supported by this proxy"],
]);

export function normalizeResponsesRequest(raw: unknown): NormalizedResponsesRequest {
  if (!isRecord(raw)) {
    throw invalidField("$", "request body must be a JSON object");
  }

  for (const [field, message] of UNSUPPORTED_TOP_LEVEL_FIELDS) {
    if (field in raw) {
      throw unsupportedFeature(field, message);
    }
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key) && !UNSUPPORTED_TOP_LEVEL_FIELDS.has(key)) {
      throw invalidField(key, `unknown field '${key}'`);
    }
  }

  if (typeof raw.model !== "string" || raw.model.trim() === "") {
    throw invalidField("model", "model is required and must be a non-empty string");
  }

  const tools = normalizeTools(raw.tools);
  const toolChoice = normalizeToolChoice(raw.tool_choice);
  const inputMessages = normalizeInput(raw.input);
  const metadata = normalizeMetadata(raw.metadata);
  const textFormat = normalizeTextFormat(raw.text);
  const verbosity = normalizeVerbosity(raw.text);
  const reasoningEffort = normalizeReasoningEffort(raw.reasoning);

  if (!inputMessages.length && !raw.previous_response_id && typeof raw.instructions !== "string") {
    throw invalidField(
      "input",
      "input is required unless previous_response_id or instructions is provided",
    );
  }

  return {
    raw: raw as ResponsesRequest,
    model: raw.model,
    instructions: normalizeOptionalString(raw.instructions, "instructions") ?? null,
    inputMessages,
    previousResponseId: normalizeNullableString(raw.previous_response_id, "previous_response_id"),
    stream: normalizeBoolean(raw.stream, "stream") ?? false,
    tools,
    toolChoice,
    parallelToolCalls: normalizeBoolean(raw.parallel_tool_calls, "parallel_tool_calls") ?? true,
    temperature: normalizeOptionalNumber(raw.temperature, "temperature"),
    topP: normalizeOptionalNumber(raw.top_p, "top_p"),
    presencePenalty: normalizeOptionalNumber(raw.presence_penalty, "presence_penalty"),
    frequencyPenalty: normalizeOptionalNumber(raw.frequency_penalty, "frequency_penalty"),
    maxOutputTokens: normalizeOptionalInteger(raw.max_output_tokens, "max_output_tokens"),
    textFormat,
    verbosity,
    reasoningEffort,
    metadata,
    store: normalizeBoolean(raw.store, "store") ?? true,
    safetyIdentifier: normalizeOptionalString(raw.safety_identifier, "safety_identifier"),
  };
}

export function buildChatTools(tools: ResponseTool[]): ChatTool[] | undefined {
  if (!tools.length) {
    return undefined;
  }
  return tools.map((tool) => {
    if (tool.type === "function") {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      };
    }
    const customTool = tool as ResponseCustomTool;
    return {
      type: "custom",
      custom: {
        name: customTool.name,
        description: customTool.description,
        format: customTool.format,
      },
    };
  });
}

export function buildChatToolChoice(toolChoice?: ResponseToolChoice): ChatToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }
  if (toolChoice === "none" || toolChoice === "auto" || toolChoice === "required") {
    return toolChoice;
  }
  if (toolChoice.type === "function") {
    return {
      type: "function",
      function: {
        name: toolChoice.name,
      },
    };
  }
  if (toolChoice.type === "custom") {
    return {
      type: "custom",
      custom: {
        name: toolChoice.name,
      },
    };
  }
  return undefined;
}

export function buildChatResponseFormat(format: ResponseTextFormat): ChatResponseFormat | undefined {
  if (format.type === "text") {
    return undefined;
  }
  if (format.type === "json_object") {
    return {
      type: "json_object",
    };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      description: format.description,
      schema: format.schema,
      strict: format.strict,
    },
  };
}

function normalizeTools(value: unknown): ResponseTool[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidField("tools", "tools must be an array");
  }
  return value.map((tool, index) => normalizeTool(tool, index));
}

function normalizeTool(value: unknown, index: number): ResponseTool {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidField(`tools[${index}]`, "tool must be an object with a type field");
  }
  if (value.type === "function") {
    return normalizeFunctionTool(value, index);
  }
  if (value.type === "custom") {
    return normalizeCustomTool(value, index);
  }
  throw unsupportedFeature(`tools[${index}].type`, `tool type '${value.type}' is not supported`);
}

function normalizeFunctionTool(value: Record<string, unknown>, index: number): ResponseFunctionTool {
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw invalidField(`tools[${index}].name`, "function tool name must be a non-empty string");
  }
  if (value.parameters !== undefined && !isRecord(value.parameters)) {
    throw invalidField(`tools[${index}].parameters`, "function tool parameters must be an object");
  }
  return {
    type: "function",
    name: value.name,
    description: normalizeOptionalString(value.description, `tools[${index}].description`),
    parameters: value.parameters as Record<string, unknown> | undefined,
    strict: normalizeBoolean(value.strict, `tools[${index}].strict`) ?? undefined,
  };
}

function normalizeCustomTool(value: Record<string, unknown>, index: number): ResponseCustomTool {
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw invalidField(`tools[${index}].name`, "custom tool name must be a non-empty string");
  }
  const format = normalizeCustomToolFormat(value.format, index);
  return {
    type: "custom",
    name: value.name,
    description: normalizeOptionalString(value.description, `tools[${index}].description`),
    format,
  };
}

function normalizeCustomToolFormat(
  value: unknown,
  index: number,
): ResponseCustomTool["format"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidField(`tools[${index}].format`, "custom tool format must be an object");
  }
  if (value.type === "text") {
    return {
      type: "text",
    };
  }
  if (value.type === "grammar") {
    const grammarSource = isRecord(value.grammar) ? value.grammar : value;
    if (
      typeof grammarSource.syntax !== "string" ||
      typeof grammarSource.definition !== "string"
    ) {
      throw invalidField(
        `tools[${index}].format`,
        "custom grammar format requires string syntax and definition",
      );
    }
    return {
      type: "grammar",
      grammar: {
        syntax: grammarSource.syntax,
        definition: grammarSource.definition,
      },
    };
  }
  throw unsupportedFeature(
    `tools[${index}].format.type`,
    `custom tool format '${value.type}' is not supported`,
  );
}

function normalizeToolChoice(value: unknown): ResponseToolChoice | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "none" || value === "auto" || value === "required") {
    return value;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidField("tool_choice", "tool_choice must be a string or object");
  }
  if (value.type === "function" || value.type === "custom") {
    if (typeof value.name !== "string" || value.name.trim() === "") {
      throw invalidField("tool_choice.name", "tool_choice.name must be a non-empty string");
    }
    return {
      type: value.type,
      name: value.name,
    };
  }
  if (value.type === "allowed_tools") {
    if (!Array.isArray(value.tools) || value.tools.length !== 1) {
      throw unsupportedFeature(
        "tool_choice",
        "allowed_tools is only supported when exactly one function/custom tool is provided",
      );
    }
    const [tool] = value.tools;
    if (!isRecord(tool) || typeof tool.type !== "string" || typeof tool.name !== "string") {
      throw invalidField("tool_choice.tools[0]", "allowed_tools entries must include type and name");
    }
    if (tool.type !== "function" && tool.type !== "custom") {
      throw unsupportedFeature(
        "tool_choice.tools[0].type",
        `allowed tool type '${tool.type}' is not supported`,
      );
    }
    return {
      type: tool.type,
      name: tool.name,
    };
  }
  throw unsupportedFeature("tool_choice.type", `tool_choice type '${value.type}' is not supported`);
}

function normalizeTextFormat(value: unknown): ResponseTextFormat {
  if (value === undefined) {
    return { type: "text" };
  }
  if (!isRecord(value)) {
    throw invalidField("text", "text must be an object");
  }
  const format = value.format;
  if (format === undefined) {
    return { type: "text" };
  }
  if (!isRecord(format) || typeof format.type !== "string") {
    throw invalidField("text.format", "text.format must be an object with a type field");
  }
  if (format.type === "text") {
    return { type: "text" };
  }
  if (format.type === "json_object") {
    return { type: "json_object" };
  }
  if (format.type === "json_schema") {
    if (typeof format.name !== "string" || format.name.trim() === "") {
      throw invalidField("text.format.name", "json_schema format requires a name");
    }
    if (format.schema !== undefined && !isRecord(format.schema)) {
      throw invalidField("text.format.schema", "json_schema format schema must be an object");
    }
    return {
      type: "json_schema",
      name: format.name,
      description: normalizeOptionalString(format.description, "text.format.description"),
      schema: format.schema as Record<string, unknown> | undefined,
      strict: normalizeBoolean(format.strict, "text.format.strict") ?? undefined,
    };
  }
  throw unsupportedFeature("text.format.type", `text format '${format.type}' is not supported`);
}

function normalizeVerbosity(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidField("text", "text must be an object");
  }
  if (value.verbosity === undefined) {
    return undefined;
  }
  if (value.verbosity === "low" || value.verbosity === "medium" || value.verbosity === "high") {
    return value.verbosity;
  }
  throw invalidField("text.verbosity", "text.verbosity must be low, medium, or high");
}

function normalizeReasoningEffort(
  value: unknown,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidField("reasoning", "reasoning must be an object");
  }
  if (value.effort === undefined || value.effort === null) {
    return undefined;
  }
  if (
    value.effort === "none" ||
    value.effort === "minimal" ||
    value.effort === "low" ||
    value.effort === "medium" ||
    value.effort === "high" ||
    value.effort === "xhigh"
  ) {
    return value.effort;
  }
  throw invalidField(
    "reasoning.effort",
    "reasoning.effort must be none, minimal, low, medium, high, or xhigh",
  );
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw invalidField("metadata", "metadata must be an object");
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw invalidField(`metadata.${key}`, "metadata values must be strings");
    }
    metadata[key] = entry;
  }
  return metadata;
}

function normalizeInput(value: unknown): ChatMessage[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [
      {
        role: "user",
        content: value,
      },
    ];
  }
  if (!Array.isArray(value)) {
    throw invalidField("input", "input must be a string or an array");
  }

  const messages: ChatMessage[] = [];
  let pendingToolCalls: ChatToolCall[] = [];

  const flushToolCalls = (): void => {
    if (!pendingToolCalls.length) {
      return;
    }
    messages.push({
      role: "assistant",
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  value.forEach((item, index) => {
    const normalized = normalizeInputItem(item, index);
    if ("toolCall" in normalized) {
      pendingToolCalls.push(normalized.toolCall);
      return;
    }
    flushToolCalls();
    messages.push(normalized.message);
  });

  flushToolCalls();
  return messages;
}

function normalizeInputItem(
  value: unknown,
  index: number,
): { message: ChatMessage } | { toolCall: ChatToolCall } {
  if (!isRecord(value)) {
    throw invalidField(`input[${index}]`, "input item must be an object");
  }
  if (typeof value.type !== "string") {
    if (
      (value.role === "developer" ||
        value.role === "system" ||
        value.role === "user" ||
        value.role === "assistant") &&
      "content" in value
    ) {
      return {
        message: normalizeMessageItem(
          {
            ...value,
            type: "message",
          },
          index,
        ),
      };
    }
    throw invalidField(
      `input[${index}]`,
      "input item must include type, or provide role/content message shorthand",
    );
  }
  switch (value.type) {
    case "message":
      return {
        message: normalizeMessageItem(value, index),
      };
    case "function_call":
      return {
        toolCall: normalizeFunctionCallItem(value, index),
      };
    case "custom_tool_call":
      return {
        toolCall: normalizeCustomToolCallItem(value, index),
      };
    case "function_call_output":
    case "custom_tool_call_output":
      return {
        message: normalizeToolOutputItem(value, index),
      };
    default:
      throw unsupportedFeature(`input[${index}].type`, `input item type '${value.type}' is not supported`);
  }
}

function normalizeMessageItem(value: Record<string, unknown>, index: number): ChatMessage {
  if (
    value.role !== "developer" &&
    value.role !== "system" &&
    value.role !== "user" &&
    value.role !== "assistant"
  ) {
    throw invalidField(`input[${index}].role`, "message role must be developer, system, user, or assistant");
  }
  if (value.role === "assistant") {
    const content = normalizeAssistantMessageContent(value.content, index);
    const assistantMessage: ChatMessage = {
      role: "assistant",
    };
    if (typeof content === "string") {
      assistantMessage.content = content;
      return assistantMessage;
    }
    const refusalText = content
      .filter((part): part is Extract<ChatAssistantContentPart, { type: "refusal" }> => part.type === "refusal")
      .map((part) => part.refusal)
      .join("");
    if (refusalText) {
      assistantMessage.refusal = refusalText;
    }
    const nonRefusal = content.filter((part) => part.type !== "refusal");
    if (nonRefusal.length) {
      assistantMessage.content = nonRefusal;
    }
    return assistantMessage;
  }
  const content = normalizeNonAssistantMessageContent(value.content, index);
  return {
    role: value.role,
    content,
  };
}

function normalizeAssistantMessageContent(
  value: unknown,
  index: number,
): string | ChatAssistantContentPart[] {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw invalidField(`input[${index}].content`, "message content must be a string or array");
  }
  const content = value.map((part, partIndex) => normalizeAssistantContentPart(part, index, partIndex));
  if (content.length === 1 && content[0].type === "text") {
    return content[0].text;
  }
  return content;
}

function normalizeNonAssistantMessageContent(value: unknown, index: number): string | ChatContentPart[] {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw invalidField(`input[${index}].content`, "message content must be a string or array");
  }
  const content = value.map((part, partIndex) => normalizeUserContentPart(part, index, partIndex));
  if (content.length && content.every((part) => part.type === "text")) {
    return content.map((part) => part.text).join("");
  }
  return content;
}

function normalizeUserContentPart(
  value: unknown,
  itemIndex: number,
  partIndex: number,
): ChatContentPart {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidField(
      `input[${itemIndex}].content[${partIndex}]`,
      "content part must be an object with a type field",
    );
  }
  if (value.type === "input_text" || value.type === "output_text") {
    if (typeof value.text !== "string") {
      throw invalidField(
        `input[${itemIndex}].content[${partIndex}].text`,
        "text content part requires a string text field",
      );
    }
    return {
      type: "text",
      text: value.text,
    };
  }
  if (value.type === "input_image") {
    const url = typeof value.image_url === "string" ? value.image_url : value.file_url;
    if (typeof url !== "string" || url.trim() === "") {
      throw invalidField(
        `input[${itemIndex}].content[${partIndex}]`,
        "input_image requires image_url or file_url",
      );
    }
    return {
      type: "image_url",
      image_url: {
        url,
      },
    };
  }
  throw unsupportedFeature(
    `input[${itemIndex}].content[${partIndex}].type`,
    `message content type '${value.type}' is not supported`,
  );
}

function normalizeAssistantContentPart(
  value: unknown,
  itemIndex: number,
  partIndex: number,
): ChatAssistantContentPart {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidField(
      `input[${itemIndex}].content[${partIndex}]`,
      "assistant content part must be an object with a type field",
    );
  }
  if (value.type === "input_text" || value.type === "output_text") {
    if (typeof value.text !== "string") {
      throw invalidField(
        `input[${itemIndex}].content[${partIndex}].text`,
        "assistant text content part requires string text",
      );
    }
    return {
      type: "text",
      text: value.text,
    };
  }
  if (value.type === "refusal") {
    if (typeof value.refusal !== "string") {
      throw invalidField(
        `input[${itemIndex}].content[${partIndex}].refusal`,
        "refusal content part requires string refusal",
      );
    }
    return {
      type: "refusal",
      refusal: value.refusal,
    };
  }
  throw unsupportedFeature(
    `input[${itemIndex}].content[${partIndex}].type`,
    `assistant content type '${value.type}' is not supported`,
  );
}

function normalizeFunctionCallItem(value: Record<string, unknown>, index: number): ChatToolCall {
  if (typeof value.call_id !== "string" || value.call_id.trim() === "") {
    throw invalidField(`input[${index}].call_id`, "function_call requires call_id");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw invalidField(`input[${index}].name`, "function_call requires name");
  }
  if (typeof value.arguments !== "string") {
    throw invalidField(`input[${index}].arguments`, "function_call requires string arguments");
  }
  return {
    id: value.call_id,
    type: "function",
    function: {
      name: value.name,
      arguments: value.arguments,
    },
  };
}

function normalizeCustomToolCallItem(value: Record<string, unknown>, index: number): ChatToolCall {
  if (typeof value.call_id !== "string" || value.call_id.trim() === "") {
    throw invalidField(`input[${index}].call_id`, "custom_tool_call requires call_id");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw invalidField(`input[${index}].name`, "custom_tool_call requires name");
  }
  if (typeof value.input !== "string") {
    throw invalidField(`input[${index}].input`, "custom_tool_call requires string input");
  }
  return {
    id: value.call_id,
    type: "custom",
    custom: {
      name: value.name,
      input: value.input,
    },
  };
}

function normalizeToolOutputItem(value: Record<string, unknown>, index: number): ChatMessage {
  if (typeof value.call_id !== "string" || value.call_id.trim() === "") {
    throw invalidField(`input[${index}].call_id`, "tool output item requires call_id");
  }
  return {
    role: "tool",
    tool_call_id: value.call_id,
    content: normalizeToolOutputContent(value.output, index),
  };
}

function normalizeToolOutputContent(value: unknown, index: number): string | ChatTextPart[] {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw invalidField(`input[${index}].output`, "tool output must be a string or array");
  }
  const parts = value.map((part, partIndex) => normalizeToolOutputPart(part, index, partIndex));
  if (parts.length === 1) {
    return parts[0].text;
  }
  return parts;
}

function normalizeToolOutputPart(value: unknown, itemIndex: number, partIndex: number): ChatTextPart {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidField(
      `input[${itemIndex}].output[${partIndex}]`,
      "tool output part must be an object with a type field",
    );
  }
  if (value.type !== "input_text" && value.type !== "output_text") {
    throw unsupportedFeature(
      `input[${itemIndex}].output[${partIndex}].type`,
      `tool output part type '${value.type}' is not supported`,
    );
  }
  if (typeof value.text !== "string") {
    throw invalidField(
      `input[${itemIndex}].output[${partIndex}].text`,
      "tool output part requires string text",
    );
  }
  return {
    type: "text",
    text: value.text,
  };
}

function normalizeOptionalString(value: unknown, param: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidField(param, `${param} must be a string`);
  }
  return value;
}

function normalizeNullableString(value: unknown, param: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidField(param, `${param} must be a non-empty string when provided`);
  }
  return value;
}

function normalizeOptionalNumber(value: unknown, param: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidField(param, `${param} must be a finite number`);
  }
  return value;
}

function normalizeOptionalInteger(value: unknown, param: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidField(param, `${param} must be a non-negative integer`);
  }
  return value;
}

function normalizeBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invalidField(param, `${param} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProxyError(error: unknown): error is ProxyError {
  return error instanceof ProxyError;
}
