import path from "node:path";
import { readJson } from "./fs-utils.mjs";

const PLACEHOLDER_MODEL = /^(MODEL_|CHANGE_ME|<)/i;

export async function loadTargetConfig(configPath, { allowPlaceholders = false } = {}) {
  const config = await readJson(configPath);
  validateTargetConfig(config, { allowPlaceholders });
  const base = path.dirname(path.resolve(configPath));
  return {
    ...config,
    gigacode: {
      sessionTimeoutSeconds: 1800,
      idleTimeoutSeconds: 600,
      retryCount: 1,
      retryDelaySeconds: 5,
      commandArgs: [],
      ...config.gigacode,
    },
    review: {
      maxRounds: 5,
      maxParallel: 5,
      formatRetries: 1,
      requiredDistinctModels: 3,
      stallRounds: 2,
      ...config.review,
    },
    storage: {
      retainAgentTranscripts: false,
      ...config.storage,
      runRoot: path.resolve(base, config.storage.runRoot),
    },
  };
}

export function validateTargetConfig(config, { allowPlaceholders = false } = {}) {
  if (config?.schemaVersion !== "contractility.target-config.v1") {
    throw new TypeError("Ожидалась схема contractility.target-config.v1.");
  }
  if (!config.gigacode?.command || typeof config.gigacode.command !== "string") {
    throw new TypeError("gigacode.command обязателен.");
  }
  if (
    config.gigacode.commandArgs != null
    && (!Array.isArray(config.gigacode.commandArgs)
      || config.gigacode.commandArgs.some((value) => typeof value !== "string"))
  ) {
    throw new TypeError("gigacode.commandArgs должен быть массивом строк.");
  }
  const producer = config.models?.producer;
  const synthesizer = config.models?.synthesizer;
  const reviewers = config.models?.reviewers;
  if (!producer || !synthesizer || !Array.isArray(reviewers) || reviewers.length < 3) {
    throw new TypeError("Нужны producer, synthesizer и минимум три reviewer-агента.");
  }
  const ids = new Set();
  for (const reviewer of reviewers) {
    if (!reviewer?.id || !reviewer?.model || !reviewer?.focus) {
      throw new TypeError("Каждому reviewer нужны id, model и focus.");
    }
    if (!/^[a-z][a-z0-9-]{1,48}$/.test(reviewer.id) || ids.has(reviewer.id)) {
      throw new TypeError(`Недопустимый или повторяющийся reviewer.id: ${reviewer.id}`);
    }
    ids.add(reviewer.id);
  }
  const models = [producer, synthesizer, ...reviewers.map((reviewer) => reviewer.model)];
  if (!allowPlaceholders && models.some((model) => PLACEHOLDER_MODEL.test(model))) {
    throw new TypeError("Замените MODEL_* на реальные идентификаторы моделей GigaCode.");
  }
  const distinctModels = new Set(models).size;
  const requiredDistinct = config.review?.requiredDistinctModels ?? 3;
  if (distinctModels < requiredDistinct) {
    throw new TypeError(
      `Нужно минимум ${requiredDistinct} разных моделей, настроено ${distinctModels}.`,
    );
  }
  for (const [field, minimum, maximum] of [
    ["maxRounds", 1, 20],
    ["maxParallel", 1, 12],
    ["formatRetries", 0, 3],
    ["stallRounds", 1, 5],
  ]) {
    const value = config.review?.[field];
    if (value != null && (!Number.isInteger(value) || value < minimum || value > maximum)) {
      throw new TypeError(`review.${field} должен быть целым числом ${minimum}..${maximum}.`);
    }
  }
  if (!config.storage?.runRoot || typeof config.storage.runRoot !== "string") {
    throw new TypeError("storage.runRoot обязателен.");
  }
}

export function requestedModels(config) {
  return [...new Set([
    config.models.producer,
    config.models.synthesizer,
    ...config.models.reviewers.map((reviewer) => reviewer.model),
  ])];
}
