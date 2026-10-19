import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addJevModel,
  applyCodexTier,
  codexConversationKey,
  codexModelOf,
  codexModels,
  codexNewTurnPrompt,
  codexTierOf,
  isCodexAuxiliaryPrompt,
  jevDecisionEvents,
  pickerModel,
  startCodexProxy,
  upstreamFor,
} from "../src/codex-proxy.mjs";
import { codexArgs, installCodexSkill } from "../src/codex-cli.mjs";
import { readStatus } from "../src/status.mjs";

test("Codex uses a temporary authenticated Jev provider", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-router"]);
  assert(args.includes('model_provider="jev"'));
  assert(args.includes("model_providers.jev.requires_openai_auth=true"));
  assert.deepEqual(args.slice(-2), ["--sandbox", "read-only"]);
  assert.equal(codexArgs("http://127.0.0.1:1234", ["--model", "gpt-5.6-sol"]).filter((a) => a === "--model").length, 1);
});

test("installs the bundled explanation skill for Codex", (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-skill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = installCodexSkill(home);
  assert.match(target, /jev-router-explain[\\/]SKILL\.md$/);
  assert.match(readFileSync(target, "utf8"), /name: jev-explain/);
});

test("reads only fresh Codex user turns", () => {
  const body = {
    input: [
      { type: "additional_tools", role: "developer", tools: [{}] },
      { role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { role: "user", content: [{ type: "input_text", text: "<system_reminder>tools</system_reminder>" }] },
      {
        role: "user",
        content: "<environment_context><current_date>2026-09-17</current_date></environment_context>",
      },
    ],
  };
  assert.equal(codexNewTurnPrompt(body), "Fix the bug");
  body.input.push({ type: "function_call_output", call_id: "1", output: "done" });
  assert.equal(codexNewTurnPrompt(body), null);
  assert.equal(
    codexNewTurnPrompt({
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
    null,
  );
  assert.equal(isCodexAuxiliaryPrompt("Generate a concise, single-line task title of at most 36 characters"), true);


  const current = {
    tools: [{ type: "function", name: "shell" }],
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
    ],
  };
  assert.equal(codexNewTurnPrompt(current), "Fix the bug");
  current.input.push({ type: "function_call_output", call_id: "1", output: "done" });
  assert.equal(codexNewTurnPrompt(current), null);
  assert.equal(codexNewTurnPrompt({ input: [{ role: "user", content: "no tools" }] }), null);
});

test("keeps sub-agent routing state separate", () => {
  const base = { input: [{ role: "user", content: "same prompt" }] };
  assert.notEqual(
    codexConversationKey({ ...base, prompt_cache_key: "main" }),
    codexConversationKey({ ...base, prompt_cache_key: "sub-agent" }),
  );
});

test("adds Jev Router to the native model catalog", () => {
  const catalog = addJevModel({
    models: [{
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    }],
  });
  assert.deepEqual(catalog.models.map((model) => model.slug), [
    "jev-router",
    "gpt-5.6-terra",
    "model-haiku",
    "model-sonnet",
    "model-opus",
    "model-fable",
  ]);
  assert.equal(catalog.models[0].display_name, "Jev Router");
  const opus = catalog.models.find((model) => model.slug === "model-opus");
  assert.equal(opus.display_name, "Jev Strong");
  assert.equal(opus.description, "Jev routes this to gpt-6.1-sol.");
  assert.deepEqual(addJevModel(catalog).models.map((model) => model.slug), catalog.models.map((model) => model.slug));
});

test("accepts an OpenAI-style /models response from a custom upstream", () => {
  const catalog = addJevModel({
    object: "list",
    data: [{ id: "gpt-6-sol", object: "model", owned_by: "cc-router" }],
  });
  const sol = catalog.models.find((model) => model.slug === "gpt-6-sol");
  assert.equal(sol.display_name, "gpt-6-sol");
  assert.equal(catalog.models[0].slug, "jev-router");
});

test("routes subscription auth to ChatGPT and API keys to the public API", () => {
  assert.equal(
    upstreamFor({ "chatgpt-account-id": "acct" }, "/responses"),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/responses"), "https://api.openai.com/v1");
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/models"), "https://chatgpt.com/backend-api/codex");
  assert.equal(
    upstreamFor({ authorization: "Bearer sk-test" }, "/responses", "https://chatgpt.example", "https://api.example", "http://127.0.0.1:23456/v1"),
    "http://127.0.0.1:23456/v1",
  );
});

test("maps tiers and clamps unsupported reasoning effort", () => {
  const body = { model: "jev-router", reasoning: { effort: "max" } };
  const models = new Map([[
    "gpt-6.1-luna",
    { default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
  ]]);
  applyCodexTier(body, "haiku", models, codexModelOf("haiku"));
  assert.equal(body.model, "gpt-6.1-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("resolves a picker row index to the slug it lists", () => {
  const picker = new Map([[0, "jev-router"], [2, "model-sonnet"]]);
  assert.equal(pickerModel({ model: "2" }, picker).model, "model-sonnet");
  assert.equal(pickerModel({ model: "9" }, picker).model, "9");
  assert.equal(pickerModel({ model: "gpt-5.6-sol" }, picker).model, "gpt-5.6-sol");
});

test("recognises the per-tier picker rows", () => {
  assert.equal(codexTierOf("model-haiku"), "haiku");
  assert.equal(codexTierOf("model-sonnet"), "sonnet");
  assert.equal(codexTierOf("model-opus"), "opus");
  assert.equal(codexTierOf("model-fable"), "fable");
  assert.equal(codexTierOf("jev-router"), null);
});

test("sends exact available GPT models to Jev", () => {
  const models = new Map([
    ["gpt-5.6-terra", { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra" }],
    ["gpt-5.6-sol", { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" }],
  ]);
  assert.deepEqual(codexModels(models).map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-5.6-terra", tier: "sonnet" },
    { id: "gpt-5.6-sol", tier: "opus" },
  ]);
});

test("surfaces routing as a native commentary event", () => {
  const events = jevDecisionEvents({ tier: "opus", confidence: 0.91, reason: "jev" });
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /"phase":"commentary"/);
  assert.match(events, /\[Jev\] routed this turn to gpt-6\.1-sol/);
  assert.match(events, /confidence 0\.91/);

  const unavailable = jevDecisionEvents({
    tier: "sonnet",
    confidence: null,
    reason: "jev-unavailable/no-change",
  });
  assert.match(unavailable, /JEV_API_KEY=\.\.\. to ~\/\.jev-router\.env/);
  assert.match(unavailable, /using gpt-6\.1-terra/);
});

test("proxy preserves Codex auth, picker, routing, and native decision output", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
      });
      if (req.url.startsWith("/backend-api/codex/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          models: [{
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
          }, {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 3,
          }],
        }));
      }
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const statusId = `codex-test-${process.pid}`;
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async ({ models }) => {
      routeCalls++;
      assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-terra", "gpt-5.6-sol"]);
      return {
        choice: "gpt-5.6-sol",
        confidence: 0.91,
        request: { state: { request: "debug this race" } },
        response: { answers: { model: { choice: "gpt-5.6-sol", confidence: 0.91 } } },
        metrics: {
          taskComplexity: 0.82,
          reasoningRequired: 0.91,
          toolComplexity: 0.64,
          contextSize: 0.31,
        },
      };
    },
    statusId,
  });
  t.after(close);
  const headers = { authorization: "Bearer subscription-token", "chatgpt-account-id": "acct" };

  const catalog = await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers }).then((r) => r.json());
  assert.equal(catalog.models[0].slug, "jev-router");

  const pick = (index) => String(index);

  const response = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: pick(0),
      prompt_cache_key: "main",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "debug this race" }] },
      ],
    }),
  }).then((r) => r.text());

  assert.equal(seen[0].authorization, "Bearer subscription-token");
  assert.equal(seen[0].account, "acct");
  assert.equal(seen[1].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).prompt, "debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "debug this race");
  assert.equal(readStatus(statusId).history.length, 1);
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
  assert(response.indexOf("response.created") < response.indexOf("[Jev] routed this turn"));
  assert(response.indexOf("[Jev] routed this turn") < response.indexOf("response.completed"));

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: pick(1),
      prompt_cache_key: "title",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(readStatus(statusId).confidence, 0.91);
  assert.equal(readStatus(statusId).history.length, 1);

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: pick(2),
      prompt_cache_key: "main",
      input: [{ role: "user", content: [{ type: "input_text", text: "$jev-explain" }] }],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(seen[3].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);

  const pinnedIndex = catalog.models.findIndex((model) => model.slug === "model-opus");
  const before = seen.length;
  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: pick(pinnedIndex),
      prompt_cache_key: "pinned",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "fix this typo" },
      ],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(seen[before].body.model, "gpt-5.6-sol");
  assert.ok(readStatus(statusId).manual);
});

test("closing the proxy lets the wrapper process exit", async (t) => {
  const moduleURL = new URL("../src/codex-proxy.mjs", import.meta.url).href;
  const script = `
import http from "node:http";
import { startCodexProxy } from ${JSON.stringify(moduleURL)};

const upstream = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => res.end("ok"));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + upstream.address().port;
const { port, close } = await startCodexProxy({
  chatgptBaseURL: base + "/backend-api/codex",
  apiBaseURL: base + "/v1",
});
const response = await fetch("http://127.0.0.1:" + port + "/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "gpt-5.6-terra",
    input: [{ role: "user", content: "hello" }],
  }),
});
if (!response.ok) throw new Error("proxy request failed: " + response.status);
await response.text();
close();
await new Promise((resolve) => upstream.close(resolve));
`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let timer;
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), 5000);
    }),
  ]);
  clearTimeout(timer);
  if (result.timeout) child.kill("SIGKILL");
  assert.equal(result.timeout, undefined, `wrapper stayed alive after close; stderr: ${stderr}`);
  assert.equal(result.code, 0, stderr);
});
