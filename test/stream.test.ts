import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesRequest } from "../src/normalize";
import { collectSseEvents, bridgeChatCompletionStream } from "../src/stream";

function createStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

test("bridges text streaming events into responses sse", async () => {
  const normalized = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: "hello",
    stream: true,
  });
  let serialized = "";

  const result = await bridgeChatCompletionStream({
    upstream: createStreamResponse([
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-4.1","choices":[{"index":0,"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ]),
    writer: {
      write(chunk: string) {
        serialized += chunk;
      },
      end() {},
    },
    normalized,
    historyMessages: [],
    responseId: "resp_stream",
  });

  const events = collectSseEvents(serialized);
  assert.equal(events[0]?.event, "response.created");
  assert.ok(events.some((event) => event.event === "response.output_text.delta"));
  assert.equal(events.at(-1)?.data, "[DONE]");
  assert.equal(result.response.id, "resp_stream");
  assert.equal(result.response.output[0]?.type, "message");
});

test("bridges function tool call deltas", async () => {
  const normalized = normalizeResponsesRequest({
    model: "gpt-4.1",
    input: "hello",
    stream: true,
  });
  let serialized = "";

  const result = await bridgeChatCompletionStream({
    upstream: createStreamResponse([
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
    writer: {
      write(chunk: string) {
        serialized += chunk;
      },
      end() {},
    },
    normalized,
    historyMessages: [],
  });

  const events = collectSseEvents(serialized);
  assert.ok(events.some((event) => event.event === "response.function_call_arguments.delta"));
  assert.equal(result.response.output[0]?.type, "function_call");
});
