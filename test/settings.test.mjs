import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedModel, restoreSavedModel, withRouterModel } from "../src/settings.mjs";

const fileWith = (settings) => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-settings-")), "settings.json");
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
};
const modelIn = (file) => JSON.parse(readFileSync(file, "utf8")).model;

test("a launched profile names the router without dropping the rest of its env", () => {
  assert.deepEqual(
    withRouterModel({ env: { ANTHROPIC_MODEL: "model-fable", ANTHROPIC_AUTH_TOKEN: "secret" } }),
    { env: { ANTHROPIC_MODEL: "jev-router", ANTHROPIC_AUTH_TOKEN: "secret" } },
  );
});

test("a launched profile cannot point the session away from the proxy", () => {
  assert.deepEqual(
    withRouterModel({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:23456",
        ANTHROPIC_AUTH_TOKEN: "secret",
        ANTHROPIC_MODEL: "model-fable",
      },
    }),
    { env: { ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_MODEL: "jev-router" } },
  );
});

test("a launched profile routes subagents instead of pinning them", () => {
  assert.deepEqual(
    withRouterModel({
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "model-opus", ANTHROPIC_AUTH_TOKEN: "secret" },
    }),
    { env: { ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_MODEL: "jev-router" } },
  );
});

test("reads the saved model, ignoring a leftover sentinel", () => {
  assert.equal(readSavedModel(fileWith({ model: "opus" })), "opus");
  assert.equal(readSavedModel(fileWith({ model: "jev-router" })), undefined);
  assert.equal(readSavedModel(fileWith({})), undefined);
  assert.equal(readSavedModel(join(tmpdir(), "does-not-exist.json")), undefined);
});

test("restores the previous model when the sentinel was saved", () => {
  const file = fileWith({ model: "jev-router", permissions: { deny: ["Bash(rm*)"] } });
  assert.equal(restoreSavedModel("opus", file), true);
  assert.equal(modelIn(file), "opus");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions, { deny: ["Bash(rm*)"] });
});

test("removes the sentinel when there was no previous model", () => {
  const file = fileWith({ model: "jev-router" });
  assert.equal(restoreSavedModel(undefined, file), true);
  assert.equal(modelIn(file), undefined);
});

test("leaves a real model the user chose during the session alone", () => {
  const file = fileWith({ model: "claude-opus-4-6" });
  assert.equal(restoreSavedModel("sonnet", file), false);
  assert.equal(modelIn(file), "claude-opus-4-6");
});

test("a missing or unreadable settings file is not an error", () => {
  assert.equal(restoreSavedModel("opus", join(tmpdir(), "nope", "settings.json")), false);
});
