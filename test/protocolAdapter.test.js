const assert = require("node:assert/strict");
const test = require("node:test");
const {
  anthropicMessagesToResponses,
  responsesToAnthropicMessages,
  anthropicMessageToResponses,
  responsesToAnthropicMessage,
  openAiError,
  anthropicError,
  formatSse
} = require("../out/protocolAdapter.js");

test("converts text-only Anthropic Messages requests into Responses", () => {
  const result = anthropicMessagesToResponses({
    model: "gpt-5.6", max_tokens: 200, stream: true, system: "Be brief.",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    model: "gpt-5.6", max_output_tokens: 200, stream: true, instructions: "Be brief.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Hi" }] }
    ]
  });
});

test("converts text-only Responses requests into Anthropic Messages", () => {
  const result = responsesToAnthropicMessages({
    model: "claude-opus-5", max_output_tokens: 300, stream: true, instructions: "Be brief.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    model: "claude-opus-5", max_tokens: 300, stream: true, system: "Be brief.",
    messages: [{ role: "user", content: "Hello" }]
  });
});

test("rejects tools and non-text input instead of silently dropping it", () => {
  for (const request of [
    { model: "x", max_tokens: 1, tools: [], messages: [] },
    { model: "x", max_tokens: 1, messages: [{ role: "user", content: [{ type: "image" }] }] },
    { model: "x", input: [], previous_response_id: "resp_1" },
    { model: "x", input: [{ role: "user", content: [{ type: "input_image" }] }] }
  ]) {
    const result = "max_tokens" in request ? anthropicMessagesToResponses(request) : responsesToAnthropicMessages(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 400);
  }
});

test("converts final responses and protocol-shaped errors", () => {
  const responses = anthropicMessageToResponses({
    id: "msg_1", model: "claude-opus-5", content: [{ type: "text", text: "Done" }],
    stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }
  });
  assert.equal(responses.ok, true);
  assert.equal(responses.value.status, "completed");
  assert.equal(responses.value.output[0].content[0].text, "Done");
  assert.equal(responses.value.usage.total_tokens, 5);
  const message = responsesToAnthropicMessage(responses.value, "gpt-5.6");
  assert.equal(message.ok, true);
  assert.equal(message.value.content[0].text, "Done");
  assert.equal(message.value.model, "gpt-5.6");
  assert.equal(openAiError({ status: 400, code: "unsupported_feature", message: "No tools" }).error.type, "unsupported_feature");
  assert.equal(anthropicError({ status: 400, code: "unsupported_feature", message: "No tools" }).error.type, "unsupported_feature");
  assert.match(formatSse("response.completed", { response: { id: "resp_1" } }), /^event: response\.completed\ndata: /);
});
