import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/**
 * The model saved as the user's default, ignoring a sentinel left behind by a session that
 * did not exit cleanly, which is not a preference worth restoring.
 */
export function readSavedModel(file = USER_SETTINGS) {
  try {
    const model = JSON.parse(readFileSync(file, "utf8")).model;
    return model === AUTO_MODEL ? undefined : model;
  } catch {
    return undefined;
  }
}

/**
 * Profile env such as ANTHROPIC_MODEL=model-fable is applied on top of the process
 * environment and beats `--model`. The copy this session launches with must name the router.
 *
 * Two profile keys are dropped because either one takes a request past the router.
 * ANTHROPIC_BASE_URL would send it straight to that origin instead of the loopback proxy, and
 * CLAUDE_CODE_SUBAGENT_MODEL pins subagents to a fixed id that is indistinguishable from a
 * user's own choice, so the proxy passes them through and they never get routed. The auth
 * token stays: the proxy forwards headers upstream, and removing it would leave the request
 * unauthenticated.
 */
export function withRouterModel(settings) {
  const { ANTHROPIC_BASE_URL: _baseUrl, CLAUDE_CODE_SUBAGENT_MODEL: _subagent, ...env } =
    settings.env ?? {};
  return { ...settings, env: { ...env, ANTHROPIC_MODEL: AUTO_MODEL } };
}

/**
 * Puts `previous` back if the settings file now holds the sentinel. Selecting a row with
 * Enter makes Claude Code save it as the default for new sessions, and a saved "jev-router"
 * would break plain `claude`, which has no proxy to resolve it. Anything other than an exact
 * sentinel match is left alone, so a real model chosen during the session survives.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.model !== AUTO_MODEL) return false;
    if (previous === undefined) delete settings.model;
    else settings.model = previous;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
