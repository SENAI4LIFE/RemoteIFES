"use strict";

// Selects the CI jobs to run from the files changed by the triggering event, and verifies at the
// end of the run that every selected job succeeded and every unselected job was skipped.
//
//   node select-checks.js           writes the plan to $GITHUB_OUTPUT (and stdout)
//   node select-checks.js --verify  checks $PLAN against $NEEDS (toJSON(needs)) in the result job
//
// Unknown impact widens the selection: a path outside the rules, a diff that cannot be computed,
// or a change to the CI definition itself selects every job at full depth.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const ALL_OS = ["ubuntu-latest", "windows-latest", "macos-latest"];
const CORDOVA_OS = ["ubuntu-latest", "windows-latest"];
const ZERO_SHA = /^0+$/;

// First match wins.
const PATH_RULES = [
  [/^\.github\/(workflows|scripts)\//, "ci"],
  [/^\.github\/dependabot\.yml$/, "none"],
  [/^remoteifes-server\//, "server"],
  [/^remoteifes-console\//, "console"],
  [/^remoteifes-web\//, "web"],
  [/^e2e\/specs\//, "e2eSpecs"],
  [/^e2e\/harness\/safari-smoke\.js$/, "safari"],
  [/^e2e\//, "e2eHarness"],
  [/^remoteifes-cordova\//, "mobile"],
  [/^remoteifes-esp32\//, "firmware"],
  [/^(README\.md|export\.py|import\.py|clear\.py)$|^docs\//, "docs"],
];

// Browser E2E coverage. Fast validation runs only the first entry; full validation runs all.
// Shard counts follow the measured single-job durations (11-19 min) so each shard stays near
// 3-5 minutes; macOS gets fewer shards because hosted macOS concurrency is lower.
const E2E_TARGETS = [
  { os: "ubuntu-latest", browser: "chromium", channel: "", shards: 4 },
  { os: "ubuntu-latest", browser: "firefox", channel: "", shards: 4 },
  { os: "ubuntu-latest", browser: "webkit", channel: "", shards: 4 },
  { os: "windows-latest", browser: "chromium", channel: "msedge", shards: 4 },
  { os: "windows-latest", browser: "firefox", channel: "", shards: 4 },
  { os: "macos-latest", browser: "chromium", channel: "chrome", shards: 3 },
];

const JOBS = ["server", "console", "packages", "e2e", "safari", "cordova", "firmware", "android", "ios"];

function classify(paths) {
  const areas = new Set();
  for (const file of paths) {
    const rule = PATH_RULES.find(([pattern]) => pattern.test(file));
    areas.add(rule ? rule[1] : "unknown");
  }
  areas.delete("none");
  return areas;
}

function e2eMatrix(full) {
  const targets = full ? E2E_TARGETS : E2E_TARGETS.slice(0, 1);
  const entries = [];
  for (const t of targets) {
    for (let shard = 1; shard <= t.shards; shard++) {
      entries.push({ os: t.os, browser: t.browser, channel: t.channel, shard, shards: t.shards });
    }
  }
  return entries;
}

/**
 * @param {object} input
 * @param {Set<string>|null} input.areas  changed areas, or null when the diff is unknown
 * @param {boolean} input.fullDepth       full browser/platform depth requested by the event
 * @param {boolean} input.allScope        every subsystem requested by the event
 */
function selectChecks({ areas, fullDepth, allScope }) {
  const widened = areas === null || areas.has("ci") || areas.has("unknown");
  const all = allScope || widened;
  const full = fullDepth || widened;
  const has = (name) => all || (areas !== null && areas.has(name));

  const serverChanged = has("server");
  const serverContracts = has("web") || has("mobile") || has("firmware") || has("docs");
  const consoleChanged = has("console");
  const frontend = has("web") || serverChanged || has("e2eSpecs") || has("e2eHarness");
  const mobile = has("mobile") || has("web");

  const e2eFull = full || has("e2eHarness");

  const jobs = {
    server: serverChanged ? ALL_OS : serverContracts ? ["ubuntu-latest"] : [],
    console: consoleChanged || serverChanged ? ALL_OS : [],
    packages: consoleChanged ? ALL_OS : [],
    e2e: frontend ? e2eMatrix(e2eFull) : [],
    safari: (frontend && e2eFull) || has("safari"),
    cordova: mobile ? CORDOVA_OS : [],
    firmware: has("firmware"),
    android: mobile,
    ios: mobile,
  };

  return {
    mode: all ? "full" : full ? "affected-full" : "affected-fast",
    widened,
    areas: areas === null ? null : [...areas].sort(),
    jobs,
  };
}

function isSelected(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** Returns the list of problems; empty means the run is a valid pass. */
function verifyResults(plan, needs) {
  const problems = [];
  if (!needs.changes || needs.changes.result !== "success") {
    problems.push(`changes: expected success, got ${needs.changes ? needs.changes.result : "missing"}`);
    return problems;
  }
  for (const job of JOBS) {
    const expected = isSelected(plan.jobs[job]) ? "success" : "skipped";
    const actual = needs[job] ? needs[job].result : "missing";
    if (actual !== expected) problems.push(`${job}: expected ${expected}, got ${actual}`);
  }
  return problems;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitExists(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Parses `git diff --name-status` output; renames and copies contribute both paths. */
function parseNameStatus(output) {
  const paths = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [, ...files] = line.split("\t");
    paths.push(...files);
  }
  return paths;
}

/** Returns the diff base for the event, or null when the change set cannot be determined. */
function diffBase(env) {
  if (env.EVENT_NAME === "pull_request") {
    // On pull_request the checkout is the test merge commit; its first parent is the base tip
    // the change was merged onto, so the diff is exactly what merging would introduce.
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ");
    if (parents.length === 3) return parents[1];
    if (env.PR_BASE_SHA && commitExists(env.PR_BASE_SHA)) return git(["merge-base", env.PR_BASE_SHA, "HEAD"]);
    return null;
  }
  if (env.EVENT_NAME === "push") {
    const before = env.BEFORE_SHA || "";
    if (!before || ZERO_SHA.test(before) || !commitExists(before)) return null;
    return before;
  }
  return null;
}

function changedPaths(env) {
  try {
    const base = diffBase(env);
    if (!base) return null;
    return parseNameStatus(git(["diff", "--name-status", "-M", "--no-color", base, "HEAD"]));
  } catch (err) {
    process.stderr.write(`diff unavailable, widening selection: ${err.message}\n`);
    return null;
  }
}

function planFromEnvironment(env) {
  const dispatch = env.EVENT_NAME === "workflow_dispatch";
  if (dispatch && env.EXPECTED_SHA && env.EXPECTED_SHA !== env.HEAD_SHA) {
    throw new Error(`expected_sha ${env.EXPECTED_SHA} does not match the checked-out ${env.HEAD_SHA}; the ref moved`);
  }
  const paths = dispatch ? null : changedPaths(env);
  const pushToMain = env.EVENT_NAME === "push" && env.REF === "refs/heads/main";
  const plan = selectChecks({
    areas: paths === null ? null : classify(paths),
    fullDepth: dispatch || pushToMain,
    allScope: dispatch,
  });
  plan.changedFiles = paths === null ? null : paths.length;
  return plan;
}

function writeOutputs(plan, outputFile) {
  const lines = [
    `plan=${JSON.stringify(plan)}`,
    `mode=${plan.mode}`,
    `server_os=${JSON.stringify(plan.jobs.server)}`,
    `console_os=${JSON.stringify(plan.jobs.console)}`,
    `packages_os=${JSON.stringify(plan.jobs.packages)}`,
    `e2e_matrix=${JSON.stringify(plan.jobs.e2e)}`,
    `cordova_os=${JSON.stringify(plan.jobs.cordova)}`,
    `safari=${plan.jobs.safari}`,
    `firmware=${plan.jobs.firmware}`,
    `android=${plan.jobs.android}`,
    `ios=${plan.jobs.ios}`,
  ];
  if (outputFile) fs.appendFileSync(outputFile, lines.join("\n") + "\n");
}

function main() {
  if (process.argv.includes("--verify")) {
    const plan = JSON.parse(process.env.PLAN || "null");
    const needs = JSON.parse(process.env.NEEDS || "{}");
    if (!plan) {
      console.error("no selection plan: the changes job did not produce one");
      process.exit(1);
    }
    const problems = verifyResults(plan, needs);
    for (const job of ["changes", ...JOBS]) console.log(`${job.padEnd(9)} ${needs[job] ? needs[job].result : "missing"}`);
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(`all selected jobs passed (${plan.mode})`);
    return;
  }
  const plan = planFromEnvironment(process.env);
  console.log(JSON.stringify(plan, null, 2));
  writeOutputs(plan, process.env.GITHUB_OUTPUT);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { classify, selectChecks, verifyResults, parseNameStatus, e2eMatrix, JOBS, E2E_TARGETS };
