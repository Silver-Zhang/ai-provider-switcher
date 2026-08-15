const test = require("node:test");
const assert = require("node:assert/strict");
const {
  describeGatewayModelFailure,
  getGatewayModelEndpoints,
  isGatewayModelPathMiss,
  parseGatewayModelList
} = require("../out/gatewayModels.js");

test("a bare host is tried at /v1/models and /models only", () => {
  assert.deepEqual(getGatewayModelEndpoints("https://lan-sub2api.reallab.eu.cc"), [
    "https://lan-sub2api.reallab.eu.cc/v1/models",
    "https://lan-sub2api.reallab.eu.cc/models"
  ]);
});

test("a Base URL carrying a path also falls back to the origin", () => {
  // DeepSeek serves /v1/models at the origin but 404s under /anthropic, which is
  // the failure the user hit: the refresh gave up before reaching the real list.
  assert.deepEqual(getGatewayModelEndpoints("https://api.deepseek.com/anthropic"), [
    "https://api.deepseek.com/anthropic/v1/models",
    "https://api.deepseek.com/anthropic/models",
    "https://api.deepseek.com/v1/models",
    "https://api.deepseek.com/models"
  ]);
});

test("a trailing /v1 is normalized away before building candidates", () => {
  assert.deepEqual(getGatewayModelEndpoints("https://api.pateway.ai/v1"), [
    "https://api.pateway.ai/v1/models",
    "https://api.pateway.ai/models"
  ]);
});

test("candidates are deduplicated", () => {
  const endpoints = getGatewayModelEndpoints("https://api.example.com/");
  assert.deepEqual(endpoints, ["https://api.example.com/v1/models", "https://api.example.com/models"]);
});

test("an unparsable Base URL still yields candidates instead of throwing", () => {
  assert.deepEqual(getGatewayModelEndpoints("not a url"), ["not a url/v1/models", "not a url/models"]);
});

test("a status with no body reports just the code", () => {
  assert.equal(describeGatewayModelFailure(404, "   "), "HTTP 404");
});

test("an OpenAI-shaped error body surfaces the server's message", () => {
  const body = JSON.stringify({ error: { message: "该令牌额度已用尽", type: "quota" } });
  assert.equal(describeGatewayModelFailure(401, body), "HTTP 401：该令牌额度已用尽");
});

test("a bare message field is surfaced too", () => {
  assert.equal(describeGatewayModelFailure(403, JSON.stringify({ message: "forbidden" })), "HTTP 403：forbidden");
});

test("a non-JSON body is truncated rather than dropped", () => {
  const body = "<html>".repeat(100);
  const described = describeGatewayModelFailure(502, body);
  assert.match(described, /^HTTP 502：<html>/);
  assert.equal(described.length, "HTTP 502：".length + 200);
});

test("only a 404 lets the endpoint search continue", () => {
  assert.equal(isGatewayModelPathMiss("HTTP 404"), true);
  assert.equal(isGatewayModelPathMiss("HTTP 404：page not found"), true);
  assert.equal(isGatewayModelPathMiss("HTTP 401：该令牌额度已用尽"), false);
  assert.equal(isGatewayModelPathMiss("无法连接到网关"), false);
});

test("model ids are extracted, deduplicated and sorted", () => {
  const body = JSON.stringify({
    data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }]
  });
  assert.deepEqual(parseGatewayModelList(body), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("blank and missing ids are dropped", () => {
  const body = JSON.stringify({ data: [{ id: "  " }, {}, { id: " claude-opus-4 " }] });
  assert.deepEqual(parseGatewayModelList(body), ["claude-opus-4"]);
});

test("a response without a data array yields no models", () => {
  assert.deepEqual(parseGatewayModelList("{}"), []);
});

test("a non-JSON payload throws so the caller can report it", () => {
  assert.throws(() => parseGatewayModelList("<html>"));
});
