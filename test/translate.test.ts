import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesRequest } from "../src/normalize";
import { translateChatCompletionResponse } from "../src/translate";

test("translates chat completion text and tool calls into responses output", () => {
  const normalized = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: "hello",
    tools: [
      {
        type: "function",
        name: "lookup_weather",
      },
    ],
  });

  const result = translateChatCompletionResponse(
    normalized,
    {
      id: "chatcmpl_123",
      object: "chat.completion",
      created: 1_710_000_000,
      model: "gpt-4.1",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Checking weather",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "lookup_weather",
                  arguments: "{\"city\":\"Paris\"}",
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
      },
    },
    [],
    "resp_test",
  );

  assert.equal(result.response.id, "resp_test");
  assert.equal(result.response.output.length, 2);
  assert.equal(result.response.output[0]?.type, "message");
  assert.equal(result.response.output[1]?.type, "function_call");
  assert.equal(result.response.usage.total_tokens, 17);
  assert.equal(result.historyMessages.length, 2);
});
