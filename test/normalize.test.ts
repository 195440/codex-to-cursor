import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesRequest } from "../src/normalize";
import { buildChatCompletionRequest } from "../src/translate";

test("normalizes string input and maps structured output to chat completions", () => {
  const normalized = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: "hello",
    instructions: "be terse",
    stream: true,
    max_output_tokens: 256,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
        },
      },
      verbosity: "low",
    },
    reasoning: {
      effort: "medium",
    },
    tools: [
      {
        type: "function",
        name: "lookup_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
        },
      },
    ],
  });

  const chatRequest = buildChatCompletionRequest(normalized, []);

  assert.equal(normalized.instructions, "be terse");
  assert.equal(chatRequest.messages[0]?.role, "developer");
  assert.equal(chatRequest.messages[1]?.role, "user");
  assert.equal(chatRequest.stream_options?.include_usage, true);
  assert.equal(chatRequest.max_completion_tokens, 256);
  assert.equal(chatRequest.response_format?.type, "json_schema");
  assert.equal(chatRequest.verbosity, "low");
  assert.equal(chatRequest.reasoning_effort, "medium");
  assert.equal(chatRequest.tools?.[0]?.type, "function");
});

test("rejects unsupported top-level responses features", () => {
  assert.throws(
    () =>
      normalizeResponsesRequest({
        model: "gpt-4.1",
        input: "hello",
        conversation: "conv_123",
      }),
    /conversation objects are not supported/,
  );
});

test("converts function call outputs into tool messages", () => {
  const normalized = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup_weather",
        arguments: "{\"city\":\"Paris\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "sunny",
      },
    ],
  });

  assert.equal(normalized.inputMessages.length, 2);
  assert.equal(normalized.inputMessages[0]?.role, "assistant");
  assert.equal(normalized.inputMessages[1]?.role, "tool");
});
