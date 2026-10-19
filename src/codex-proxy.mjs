import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
const DEFAULT_MODELS = {
  haiku: "gpt-6.1-luna",
  sonnet: "gpt-6.1-terra",
  opus: "gpt-6.1-sol",
  fable: "gpt-6.1-astra",
};
/** Per-tier picker rows that forward to one exact model, so only one OpenAI model id is configured. */
const TIER_ALIASES = { haiku: "model-haiku", sonnet: "model-sonnet", opus: "model-opus", fable: "model-fable" };
const TIER_LABELS = { haiku: "Fast", sonnet: "Balanced", opus: "Strong", fable: "Long" };
const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  const alias = Object.keys(TIER_ALIASES).find((tier) => TIER_ALIASES[tier] === model);
  if (alias) return alias;
  const configured = Object.keys(DEFAULT_MODELS).find((tier) => codexModelOf(tier) === model);
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/** Exact GPT models in Codex's account catalog; configured ids are the cold-start fallback. */
export function codexModels(models = new Map()) {
  const available = [...models.values()]
    .filter(
      (model) =>
        model.slug !== CODEX_AUTO_MODEL &&
        !isPickerAlias(model.slug) &&
        model.supported_in_api !== false,
    )
    .map((model) => ({
      id: model.slug,
      tier: codexTierOf(model.slug),
      description: [
        model.display_name,
        model.description,
        model.context_window && `${model.context_window} context tokens`,
      ].filter(Boolean).join("; "),
    }))
    .filter((model) => model.tier);
  return available.length
    ? available
    : Object.keys(DEFAULT_MODELS).map((tier) => ({
        id: codexModelOf(tier),
        tier,
        description: codexModelOf(tier),
      }));
}

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? codexModelOf(tier);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  // Codex moved the tool list to a top-level `tools` array; older versions sent an
  // `additional_tools` item inside `input`. Either one marks a real request rather than
  // some other client, so both are accepted.
  const hasTools = body?.tools?.length > 0 || body.input.some((item) => item?.type === "additional_tools");
  if (!hasTools) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

/** Whether a picker row forwards to one exact model, or the router still chooses per turn. */
export const isPickerAlias = (slug) => Object.values(TIER_ALIASES).includes(slug);

const aliasRow = (template, tier) => ({
  ...template,
  slug: TIER_ALIASES[tier],
  display_name: `Jev ${TIER_LABELS[tier]}`,
  description: `Jev routes this to ${codexModelOf(tier)}.`,
  visibility: "list",
  supported_in_api: true,
  upgrade: null,
});

const withModel = (body, model) => (body.model === model ? body : { ...body, model });

/** Codex /model can send the picker row index instead of the slug; only map indexes the catalog lists. */
export function pickerModel(body, picker = new Map()) {
  if (typeof body?.model !== "string" || !/^\d+$/.test(body.model)) return body;
  return picker.has(Number(body.model)) ? withModel(body, picker.get(Number(body.model))) : body;
}

/** Codex expects `models`; OpenAI-compatible gateways answer `/models` with `data`. */
export const asCatalog = (catalog) =>
  Array.isArray(catalog?.models) || !Array.isArray(catalog?.data)
    ? catalog
    : {
        ...catalog,
        models: catalog.data.map((model) => ({
          ...model,
          slug: model.id ?? model.slug,
          display_name: model.display_name ?? model.id,
        })),
      };

export function addJevModel(input) {
  const catalog = asCatalog(input);
  if (!Array.isArray(catalog?.models)) return catalog;
  const fresh = (slug) => !catalog.models.some((model) => model.slug === slug);
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  if (fresh(CODEX_AUTO_MODEL)) {
    catalog.models.unshift({
      ...template,
      slug: CODEX_AUTO_MODEL,
      display_name: "Jev Router",
      description: "Jev picks the cheapest model that can complete each turn.",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      upgrade: null,
    });
  }
  Object.keys(TIER_ALIASES).forEach((tier, i) => {
    if (fresh(TIER_ALIASES[tier])) {
      catalog.models.push({ ...aliasRow(template, tier), priority: catalog.models.length + i + 1 });
    }
  });
  return catalog;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  Object.assign(body, withModel(body, model));
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  upstreamURL = "",
) =>
  upstreamURL ||
  (/\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL);

export function jevDecisionEvents({ tier, model = codexModelOf(tier), confidence, reason }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}).`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const debug = (line) => process.env.JEV_DEBUG && log(line);
const upstreamPath = (base, path) => `${new URL(base).pathname.replace(/\/$/, "")}${path}`;

export async function startCodexProxy({
  chatgptBaseURL,
  apiBaseURL,
  upstreamURL,
  route = askJev,
  statusId = "",
} = {}) {
  // Explicit arguments beat the environment, and the environment beats the built-in defaults.
  // A launcher (`jev-codex`) passes nothing and gets JEV_CODEX_UPSTREAM_URL; a test that
  // passes its own fake upstream must not be redirected to whatever this machine has set.
  const configuredUpstream =
    upstreamURL ??
    (chatgptBaseURL || apiBaseURL ? "" : process.env.JEV_CODEX_UPSTREAM_URL?.trim() || "");
  chatgptBaseURL ??= CHATGPT_BASE_URL;
  apiBaseURL ??= API_BASE_URL;
  const states = new Map();
  const models = new Map();
  const picker = new Map();
  // Node 19+ keeps globalAgent connections alive, so an idle socket to the upstream can hold
  // the event loop open after Codex exits. Own the agents so close() can tear them down.
  const agents = {
    "http:": new http.Agent({ keepAlive: true }),
    "https:": new https.Agent({ keepAlive: true }),
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing;
      if (req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")) {
        try {
          const rawBody = JSON.parse(out.toString());
          const body = pickerModel(rawBody, picker);
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          const routed = body.model === CODEX_AUTO_MODEL || isPickerAlias(body.model);
          const requestedTier = codexTierOf(body.model);
          if (routed) {
            const key = codexConversationKey(body);
            const candidates = codexModels(models).filter((model) =>
              availableTiers().includes(model.tier),
            );
            const available = [...new Set(candidates.map((model) => model.tier))];
            const currentModel = states.get(key)?.model ?? modelForTier(candidates, "opus");
            const current = codexTierOf(currentModel) ?? "opus";
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            const pinned = isPickerAlias(body.model);
            let tier = pinned ? requestedTier : current;
            let model = pinned ? modelForTier(candidates, requestedTier) : currentModel;
            if (pinned) {
              // A Jev Fast/Balanced/Strong/Long row is the user's own pick: no Jev call, no downgrade.
              if (prompt && !explaining) writeStatus(statusId, { manual: true, at: Date.now() });
            } else if (prompt && !explaining) {
              const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
              const jev = await route({ prompt, current: currentModel, contextTokens, models: candidates });
              const chosen = candidates.find((candidate) => candidate.id === jev?.choice);
              const decision = decide({
                prompt,
                jev: jev && { ...jev, choice: chosen?.tier },
                current,
                available,
                contextTokens,
              });
              tier = decision.tier;
              model =
                shouldUseExactModel(decision.reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(candidates, tier);
              states.set(key, { tier, model });
              routing = {
                prompt,
                tier,
                model,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
              writeDecision(statusId, routing);
              debug(`${key} ${current} -> ${tier} (${decision.reason}) | ${prompt.slice(0, 60)}`);
            }
            applyCodexTier(body, tier, models, model);
          } else {
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            if (prompt && !explaining) writeStatus(statusId, { manual: true, at: Date.now() });
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`codex passthrough, could not process body: ${err.message}`);
        }
      }

      const base = upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL, configuredUpstream);
      const target = new URL(base);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: upstreamPath(base, req.url ?? "/"),
          method: req.method,
          headers,
          agent: agents[target.protocol],
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const body = [];
            response.on("data", (chunk) => body.push(chunk));
            response.on("end", () => {
              let data = Buffer.concat(body);
              try {
                const catalog = addJevModel(JSON.parse(data.toString()));
                catalog.models.forEach((model, index) => {
                  models.set(model.slug, model);
                  picker.set(index, model.slug);
                });
                data = Buffer.from(JSON.stringify(catalog));
                delete responseHeaders["content-length"];
              } catch (err) {
                debug(`could not extend Codex model catalog: ${err.message}`);
              }
              res.writeHead(response.statusCode, responseHeaders);
              res.end(data);
            });
            return;
          }

          const inspectForDecision = routing && response.statusCode >= 200 && response.statusCode < 300;
          if (inspectForDecision) delete responseHeaders["content-length"];
          res.writeHead(response.statusCode, responseHeaders);
          if (!inspectForDecision) {
            response.pipe(res);
            return;
          }
          let pending = "";
          let inspected = false;
          response.on("data", (chunk) => {
            if (inspected) return void res.write(chunk);
            pending += chunk.toString();
            const end = pending.indexOf("\n\n");
            if (end < 0) return;
            const first = pending.slice(0, end + 2);
            res.write(first);
            const isSSE = /^(?:event|data):/m.test(first);
            if (isSSE) res.write(jevDecisionEvents(routing));
            debug(`codex decision display ${isSSE ? "inject" : "skip"}`);
            res.write(pending.slice(end + 2));
            pending = "";
            inspected = true;
          });
          response.on("end", () => {
            if (pending) {
              debug("codex decision display skip");
              res.write(pending);
            }
            res.end();
          });
        },
      );
      upstream.on("error", (err) => {
        debug(`codex upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    // Destroy pooled upstream sockets too; otherwise an idle keep-alive connection keeps the
    // event loop alive and `jev-codex` never exits after Codex does.
    agents["http:"].destroy();
    agents["https:"].destroy();
    server.close();
    server.closeAllConnections?.();
  };
  return { port: server.address().port, close };
}
