import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/server";
import { MemoryResponseStateStore } from "../src/store";

test("replays previous_response_id history without inheriting old instructions", async () => {
  const upstreamBodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body ?? "{}")));
    const requestIndex = upstreamBodies.length;
    return new Response(
      JSON.stringify({
        id: `chatcmpl_${requestIndex}`,
        object: "chat.completion",
        created: requestIndex,
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: requestIndex === 1 ? "first answer" : "second answer",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  const app = buildApp({
    config: {
      port: 3060,
      openAiBaseUrl: "http://openclaw.195440.com:3030",
      openAiApiKey: "test-key",
      stateTtlSeconds: 86400,
      logLevel: "silent",
    },
    store: new MemoryResponseStateStore(),
    fetchImpl,
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/responses",
    payload: {
      model: "gpt-4.1",
      instructions: "old instructions",
      input: "hello",
    },
  });

  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.ok(firstBody.id);

  const second = await app.inject({
    method: "POST",
    url: "/v1/responses",
    payload: {
      model: "gpt-4.1",
      previous_response_id: firstBody.id,
      instructions: "new instructions",
      input: "follow up",
    },
  });

  assert.equal(second.statusCode, 200);
  assert.equal(upstreamBodies.length, 2);

  const secondUpstream = upstreamBodies[1] as {
    messages: Array<{ role: string; content?: string }>;
  };
  assert.equal(secondUpstream.messages[0]?.role, "developer");
  assert.equal(secondUpstream.messages[0]?.content, "new instructions");
  assert.equal(
    secondUpstream.messages.some(
      (message) => message.role === "developer" && message.content === "old instructions",
    ),
    false,
  );
  assert.equal(
    secondUpstream.messages.some((message) => message.role === "assistant" && message.content === "first answer"),
    true,
  );

  await app.close();
});

test("translates responses-style input on /v1/chat/completions into upstream messages", async () => {
  const upstreamBodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    upstreamBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(
      JSON.stringify({
        id: "chatcmpl_compat",
        object: "chat.completion",
        created: 1,
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "ok",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  const app = buildApp({
    config: {
      port: 3060,
      openAiBaseUrl: "http://openclaw.195440.com:3030",
      openAiApiKey: "test-key",
      stateTtlSeconds: 86400,
      logLevel: "silent",
    },
    store: new MemoryResponseStateStore(),
    fetchImpl,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gpt-5.4",
      user: "abc",
      input: [
        {
          role: "system",
          content: "You are helpful.",
        },
        {
          role: "user",
          content: "Say ok.",
        },
      ],
      stream: false,
      reasoning: {
        effort: "medium",
      },
      include: ["reasoning.encrypted_content"],
    },
  });

  assert.equal(response.statusCode, 200);
  const upstream = upstreamBodies[0] as {
    messages: Array<{ role: string; content: string }>;
    user?: string;
  };
  assert.equal(Array.isArray(upstream.messages), true);
  assert.equal(upstream.messages[0]?.role, "system");
  assert.equal(upstream.messages[1]?.role, "user");
  assert.equal(upstream.user, "abc");
  assert.equal("input" in upstream, false);

  await app.close();
});
