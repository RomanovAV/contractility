#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareCase } from "./target/case-store.mjs";
import { loadTargetConfig, requestedModels } from "./target/config.mjs";
import { readJson } from "./target/fs-utils.mjs";
import {
  assertRequestedModel,
  runGigacode,
  terminateActiveGigacode,
} from "./target/gigacode.mjs";
import {
  approveRun,
  createAndRun,
  finalizeRun,
  verifyRun,
} from "./target/runner.mjs";

const execFileAsync = promisify(execFile);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    terminateActiveGigacode(signal.toLowerCase());
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}

function usage() {
  return `Contractility target CLI

Commands:
  doctor --config PATH [--smoke]
  prepare --request PATH --draft PATH --source ID=PATH... --out DIR
  run --case DIR --config PATH
  status --run DIR [--json]
  approve --run DIR --candidate-sha256 HASH --findings-sha256 HASH --approver NAME
  finalize --run DIR
  verify --run DIR
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { source: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new TypeError(`Неизвестный аргумент: ${token}`);
    const name = token.slice(2);
    if (["smoke", "json"].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new TypeError(`Для --${name} требуется значение.`);
    }
    index += 1;
    if (name === "source") options.source.push(value);
    else options[name] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new TypeError(`Обязателен параметр --${name}.`);
  return value;
}

function sourceMap(values) {
  const result = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new TypeError(`--source должен иметь вид ID=PATH: ${value}`);
    }
    const id = value.slice(0, separator);
    if (result[id]) throw new TypeError(`Источник ${id} указан дважды.`);
    result[id] = value.slice(separator + 1);
  }
  return result;
}

async function commandVersion(command, args = ["--version"]) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return (result.stdout || result.stderr).trim();
}

async function doctor(options) {
  const config = await loadTargetConfig(required(options, "config"));
  const checks = [];
  checks.push({ name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.version });
  for (const [name, command, args] of [
    ["GigaCode CLI", config.gigacode.command, [...(config.gigacode.commandArgs ?? []), "--version"]],
    ["ZIP", "zip", ["-v"]],
    ["UnZIP", "unzip", ["-v"]],
  ]) {
    try {
      checks.push({ name, ok: true, value: (await commandVersion(command, args)).split("\n")[0] });
    } catch (error) {
      checks.push({ name, ok: false, value: error.message });
    }
  }
  if (config.tools?.requireSoffice) {
    try {
      checks.push({
        name: "LibreOffice",
        ok: true,
        value: await commandVersion(config.tools.sofficeCommand ?? "soffice"),
      });
    } catch (error) {
      checks.push({ name: "LibreOffice", ok: false, value: error.message });
    }
  }
  if (options.smoke && checks.every((check) => check.ok)) {
    const smokeDirectory = await mkdtemp(path.join(os.tmpdir(), "contractility-smoke-"));
    for (const model of requestedModels(config)) {
      const result = await runGigacode({
        config: config.gigacode,
        model,
        prompt: 'Return exactly {"status":"ok"} and no other text. Do not use tools.',
        cwd: smokeDirectory,
        session: `doctor:${model}`,
      });
      if (!result.ok || result.output !== '{"status":"ok"}') {
        checks.push({ name: `Model ${model}`, ok: false, value: result.stderr || result.output });
      } else {
        try {
          assertRequestedModel(result, model);
          checks.push({ name: `Model ${model}`, ok: true, value: result.reportedModels.join(", ") || "response ok" });
        } catch (error) {
          checks.push({ name: `Model ${model}`, ok: false, value: error.message });
        }
      }
    }
  }
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.value}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    console.log(usage());
    return;
  }
  if (command === "doctor") {
    await doctor(options);
    return;
  }
  if (command === "prepare") {
    const result = await prepareCase({
      requestPath: path.resolve(required(options, "request")),
      draftPath: path.resolve(required(options, "draft")),
      sources: sourceMap(options.source),
      outputRoot: path.resolve(required(options, "out")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "run") {
    const config = await loadTargetConfig(required(options, "config"));
    const result = await createAndRun({
      caseDirectory: path.resolve(required(options, "case")),
      config,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "status") {
    const state = await readJson(path.join(path.resolve(required(options, "run")), "state.json"));
    console.log(options.json ? JSON.stringify(state) : JSON.stringify(state, null, 2));
    return;
  }
  if (command === "approve") {
    const result = await approveRun({
      runDirectory: path.resolve(required(options, "run")),
      approver: required(options, "approver"),
      candidateSha256: required(options, "candidate-sha256"),
      findingsSha256: required(options, "findings-sha256"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "finalize") {
    console.log(JSON.stringify(
      await finalizeRun(path.resolve(required(options, "run"))),
      null,
      2,
    ));
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(
      await verifyRun(path.resolve(required(options, "run"))),
      null,
      2,
    ));
    return;
  }
  throw new TypeError(`Неизвестная команда: ${command}\n${usage()}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  if (error.runDirectory) console.error(`Run directory: ${error.runDirectory}`);
  process.exitCode = 1;
});
