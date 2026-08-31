const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { startLocalAdapterServer } = require("../out/localAdapterServer.js");

function upstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stop: () => server.close() }));
  });
}

function request(port, path, body, token = "local") {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

test("Codex local Responses endpoint forwards text to an Anthropic upstream", async () => {
  let received;
  const target = await upstream((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_upstream", model: "claude-test", content: [{ type: "text", text: "Hello from Claude" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } }));
    });
  });
  const adapter = await startLocalAdapterServer({ port: 0, resolve: (id, client) => id === "binding" && client === "codex" ? { direction: "responsesToAnthropic", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream-key", localToken: "local", models: ["claude-test"] } : undefined });
  try {
    const response = await request(adapter.port, "/codex/binding/v1/responses", { model: "claude-test", max_output_tokens: 100, input: "Hi" });
    assert.equal(response.status, 200);
    assert.equal(received.path, "/v1/messages");
    assert.equal(received.body.model, "claude-test");
    assert.equal(received.body.messages[0].content, "Hi");
    assert.equal(received.headers["x-api-key"], "upstream-key");
    assert.equal(received.headers.authorization, undefined);
    assert.equal(JSON.parse(response.body).output[0].content[0].text, "Hello from Claude");
    const models = await request(adapter.port, "/codex/binding/v1/models", undefined);
    assert.deepEqual(JSON.parse(models.body).data.map((entry) => entry.id), ["claude-test"]);
  } finally { adapter.stop(); target.stop(); }
});

test("Claude local Messages endpoint forwards text to a Responses upstream", async () => {
  let received;
  const target = await upstream((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_upstream", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello from Responses" }] }], usage: { input_tokens: 1, output_tokens: 4 } }));
    });
  });
  const adapter = await startLocalAdapterServer({ port: 0, resolve: (id, client) => id === "binding" && client === "claude" ? { direction: "anthropicToResponses", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream-key", localToken: "local", models: ["gpt-test"] } : undefined });
  try {
    const response = await request(adapter.port, "/claude/binding/v1/messages", { model: "gpt-test", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] });
    assert.equal(response.status, 200);
    assert.equal(received.path, "/v1/responses");
    assert.equal(received.body.model, "gpt-test");
    assert.equal(received.body.input[0].content[0].text, "Hi");
    assert.equal(received.headers.authorization, "Bearer upstream-key");
    assert.equal(received.headers["x-api-key"], undefined);
    assert.equal(JSON.parse(response.body).content[0].text, "Hello from Responses");
  } finally { adapter.stop(); target.stop(); }
});

test("adapter rejects bad local token and unsupported tools before upstream", async () => {
  let calls = 0;
  const target = await upstream((_req, res) => { calls += 1; res.end("{}"); });
  const adapter = await startLocalAdapterServer({ port: 0, resolve: () => ({ direction: "responsesToAnthropic", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream", localToken: "local", models: [] }) });
  try {
    const unauthorized = await request(adapter.port, "/codex/binding/v1/responses", { model: "x", input: "hello" }, "wrong");
    assert.equal(unauthorized.status, 401);
    const tools = await request(adapter.port, "/codex/binding/v1/responses", { model: "x", input: "hello", tools: [] });
    assert.equal(tools.status, 400);
    assert.equal(calls, 0);
  } finally { adapter.stop(); target.stop(); }
});

function streamingUpstream(events) {
  return upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) res.write(event);
    res.end();
  });
}

test("maps an Anthropic text SSE lifecycle into Responses events", async () => {
  const target = await streamingUpstream([
    'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test"}}\r\n\r\n',
    'event: content_block_start\r\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\r\n\r\n',
    'event: content_block_stop\r\ndata: {"type":"content_block_stop"}\r\n\r\n',
    'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'
  ]);
  const adapter = await startLocalAdapterServer({ port: 0, resolve: () => ({ direction: "responsesToAnthropic", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream", localToken: "local", models: [] }) });
  try {
    const response = await request(adapter.port, "/codex/binding/v1/responses", { model: "claude-test", max_output_tokens: 10, stream: true, input: "Hi" });
    assert.equal(response.status, 200);
    for (const event of ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]) {
      assert.match(response.body, new RegExp(`event: ${event.replace(/\./g, "\\.")}`));
    }
    assert.match(response.body, /"delta":"Hello"/);
  } finally { adapter.stop(); target.stop(); }
});

test("maps a Responses text SSE lifecycle into Anthropic events", async () => {
  const target = await streamingUpstream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.content_part.added\ndata: {"type":"response.content_part.added"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  ]);
  const adapter = await startLocalAdapterServer({ port: 0, resolve: () => ({ direction: "anthropicToResponses", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream", localToken: "local", models: [] }) });
  try {
    const response = await request(adapter.port, "/claude/binding/v1/messages", { model: "gpt-test", max_tokens: 10, stream: true, messages: [{ role: "user", content: "Hi" }] });
    assert.equal(response.status, 200);
    for (const event of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) assert.match(response.body, new RegExp(`event: ${event}`));
    assert.match(response.body, /"text":"Hello"/);
    assert.match(response.body, /"stop_reason":"end_turn"/);
  } finally { adapter.stop(); target.stop(); }
});

test("adapter never reports completion after an upstream tool-use stream", async () => {
  const target = await streamingUpstream([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-test"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool_1","name":"bash","input":{}}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]);
  const adapter = await startLocalAdapterServer({ port: 0, resolve: () => ({ direction: "responsesToAnthropic", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream", localToken: "local", models: [] }) });
  try {
    const response = await request(adapter.port, "/codex/binding/v1/responses", { model: "claude-test", max_output_tokens: 10, stream: true, input: "Hi" });
    assert.equal(response.status, 200);
    assert.match(response.body, /event: response\.failed/);
    assert.doesNotMatch(response.body, /event: response\.completed/);
  } finally { adapter.stop(); target.stop(); }
});

test("adapter emits an Anthropic error instead of message_stop after Responses failure", async () => {
  const target = await streamingUpstream([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.failed\ndata: {"type":"response.failed"}\n\n'
  ]);
  const adapter = await startLocalAdapterServer({ port: 0, resolve: () => ({ direction: "anthropicToResponses", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream", localToken: "local", models: [] }) });
  try {
    const response = await request(adapter.port, "/claude/binding/v1/messages", { model: "gpt-test", max_tokens: 10, stream: true, messages: [{ role: "user", content: "Hi" }] });
    assert.equal(response.status, 200);
    assert.match(response.body, /event: error/);
    assert.doesNotMatch(response.body, /event: message_stop/);
  } finally { adapter.stop(); target.stop(); }
});

test("direct adapter paths are isolated by binding id and client target", async () => {
  const target = await upstream((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "msg", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} })); });
  const adapter = await startLocalAdapterServer({ port: 0, resolve: (id, client) => id === "good" && client === "codex" ? { direction: "responsesToAnthropic", upstreamBaseUrl: `http://127.0.0.1:${target.port}`, upstreamToken: "upstream", localToken: "local", models: [] } : undefined });
  try {
    const wrongBinding = await request(adapter.port, "/codex/missing/v1/responses", { model: "x", input: "hi" });
    assert.equal(wrongBinding.status, 503);
    const wrongTarget = await request(adapter.port, "/claude/good/v1/messages", { model: "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    assert.equal(wrongTarget.status, 503);
    const invalidPath = await request(adapter.port, "/codex/good/v1/chat/completions", { model: "x" });
    assert.equal(invalidPath.status, 404);
  } finally { adapter.stop(); target.stop(); }
});
