export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ResponsesRequest {
  model: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  previous_response_id?: string | null;
  stream?: boolean;
  tools?: ResponseTool[];
  tool_choice?: ResponseToolChoice;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_output_tokens?: number;
  text?: {
    format?: ResponseTextFormat;
    verbosity?: "low" | "medium" | "high";
  };
  reasoning?: {
    effort?: ReasoningEffort | null;
  };
  metadata?: Record<string, string>;
  store?: boolean;
  safety_identifier?: string;
  [key: string]: unknown;
}

export interface ResponseFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponseCustomTool {
  type: "custom";
  name: string;
  description?: string;
  format?: {
    type: "text";
  } | {
    type: "grammar";
    grammar: {
      syntax: string;
      definition: string;
    };
  };
}

export type UnsupportedResponseTool = {
  type:
    | "web_search"
    | "web_search_preview"
    | "file_search"
    | "computer_use_preview"
    | "code_interpreter"
    | "image_generation"
    | "mcp"
    | "apply_patch"
    | "shell";
  [key: string]: unknown;
};

export type ResponseTool = ResponseFunctionTool | ResponseCustomTool | UnsupportedResponseTool;

export type ResponseToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      name: string;
    }
  | {
      type: "custom";
      name: string;
    }
  | {
      type: "allowed_tools";
      tools: Array<
        | { type: "function"; name: string }
        | { type: "custom"; name: string }
        | { type: string; [key: string]: unknown }
      >;
    };

export type ResponseTextFormat =
  | {
      type: "text";
    }
  | {
      type: "json_object";
    }
  | {
      type: "json_schema";
      name: string;
      schema?: Record<string, unknown>;
      description?: string;
      strict?: boolean;
    };

export type ResponsesInputItem =
  | ResponseMessageInputItem
  | ResponseFunctionCallItem
  | ResponseCustomToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseCustomToolCallOutputItem;

export interface ResponseMessageInputItem {
  type: "message";
  role: "developer" | "system" | "user" | "assistant";
  content: string | ResponseMessageContentPart[];
}

export type ResponseMessageContentPart =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "output_text";
      text: string;
      annotations?: unknown[];
    }
  | {
      type: "refusal";
      refusal: string;
    }
  | {
      type: "input_image";
      image_url?: string;
      file_url?: string;
    };

export interface ResponseFunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseCustomToolCallItem {
  type: "custom_tool_call";
  id?: string;
  call_id: string;
  name: string;
  input: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id: string;
  output: string | ResponseToolOutputPart[];
}

export interface ResponseCustomToolCallOutputItem {
  type: "custom_tool_call_output";
  id?: string;
  call_id: string;
  output: string | ResponseToolOutputPart[];
}

export type ResponseToolOutputPart = {
  type: "output_text" | "input_text";
  text: string;
};

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_completion_tokens?: number;
  response_format?: ChatResponseFormat;
  verbosity?: "low" | "medium" | "high";
  reasoning_effort?: ReasoningEffort;
  metadata?: Record<string, string>;
  store?: boolean;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  safety_identifier?: string;
  user?: string;
}

export type ChatMessage =
  | {
      role: "developer" | "system" | "user";
      content: string | ChatContentPart[];
      name?: string;
    }
  | {
      role: "assistant";
      content?: string | ChatAssistantContentPart[];
      refusal?: string;
      tool_calls?: ChatToolCall[];
      name?: string;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string | ChatTextPart[];
    };

export type ChatContentPart =
  | ChatTextPart
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

export type ChatAssistantContentPart =
  | ChatTextPart
  | {
      type: "refusal";
      refusal: string;
    };

export interface ChatTextPart {
  type: "text";
  text: string;
}

export type ChatTool =
  | {
      type: "function";
      function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
      };
    }
  | {
      type: "custom";
      custom: {
        name: string;
        description?: string;
        format?: ResponseCustomTool["format"];
      };
    };

export type ChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    }
  | {
      type: "custom";
      custom: {
        name: string;
      };
    };

export type ChatResponseFormat =
  | {
      type: "text";
    }
  | {
      type: "json_object";
    }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        schema?: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface ChatToolCall {
  id: string;
  type: "function" | "custom";
  function?: {
    name: string;
    arguments: string;
  };
  custom?: {
    name: string;
    input: string;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: {
      role: "assistant";
      content?: string | ChatAssistantContentPart[] | null;
      refusal?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason?: string | null;
    delta?: {
      role?: "assistant";
      content?: string;
      refusal?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function" | "custom";
        function?: {
          name?: string;
          arguments?: string;
        };
        custom?: {
          name?: string;
          input?: string;
        };
      }>;
    };
  }>;
  usage?: ChatCompletionResponse["usage"] | null;
}

export interface ResponseOutputMessageItem {
  type: "message";
  id: string;
  status: "completed";
  role: "assistant";
  content: ResponseOutputContentPart[];
}

export interface ResponseOutputFunctionCallItem {
  type: "function_call";
  id: string;
  status: "completed";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseOutputCustomToolCallItem {
  type: "custom_tool_call";
  id: string;
  status: "completed";
  call_id: string;
  name: string;
  input: string;
}

export type ResponseOutputItem =
  | ResponseOutputMessageItem
  | ResponseOutputFunctionCallItem
  | ResponseOutputCustomToolCallItem;

export type ResponseOutputContentPart =
  | {
      type: "output_text";
      text: string;
      annotations: unknown[];
    }
  | {
      type: "refusal";
      refusal: string;
    };

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  error: null;
  incomplete_details: null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: {
    effort: ReasoningEffort | null;
    summary: null;
  };
  store: boolean;
  temperature: number;
  text: {
    format: ResponseTextFormat;
    verbosity?: "low" | "medium" | "high";
  };
  tool_choice?: ResponseToolChoice;
  tools: ResponseTool[];
  top_p: number;
  truncation: "disabled";
  usage: {
    input_tokens: number;
    input_tokens_details: {
      cached_tokens: number;
    };
    output_tokens: number;
    output_tokens_details: {
      reasoning_tokens: number;
    };
    total_tokens: number;
  };
  metadata: Record<string, string>;
  safety_identifier?: string;
}

export interface StoredResponseRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  messages: ChatMessage[];
  store: boolean;
}

export interface ResponseStateStore {
  get(id: string): StoredResponseRecord | undefined;
  set(record: StoredResponseRecord): void;
  delete(id: string): void;
  gc(now?: number): void;
}

export interface NormalizedResponsesRequest {
  raw: ResponsesRequest;
  model: string;
  instructions: string | null;
  inputMessages: ChatMessage[];
  previousResponseId: string | null;
  stream: boolean;
  tools: ResponseTool[];
  toolChoice?: ResponseToolChoice;
  parallelToolCalls: boolean;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxOutputTokens?: number;
  textFormat: ResponseTextFormat;
  verbosity?: "low" | "medium" | "high";
  reasoningEffort?: ReasoningEffort;
  metadata: Record<string, string>;
  store: boolean;
  safetyIdentifier?: string;
}
