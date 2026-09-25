"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classify, selectChecks, verifyResults, parseNameStatus, JOBS } = require("./select-checks");

const ALL_OS = ["ubuntu-latest", "windows-latest", "macos-latest"];

function plan(paths, { fullDepth = false, allScope = false } = {}) {
  return selectChecks({ areas: paths === null ? null : classify(paths), fullDepth, allScope });
}

function selected(p) {
  return JOBS.filter((job) => (Array.isArray(p.jobs[job]) ? p.jobs[job].length > 0 : p.jobs[job]));
}

test("console changes select console tests and native package checks only", () => {
  const p = plan(["remoteifes-console/src/servidor.js"]);
  assert.deepEqual(selected(p), ["console", "packages"]);
  assert.deepEqual(p.jobs.console, ALL_OS);
  assert.deepEqual(p.jobs.packages, ALL_OS);
});

test("firmware changes select the firmware build and the server device contracts", () => {
  const p = plan(["remoteifes-esp32/src/main.ino"]);
  assert.deepEqual(selected(p), ["server", "firmware"]);
  assert.deepEqual(p.jobs.server, ["ubuntu-latest"]);
});

test("web changes select contracts, fast Chromium E2E and dependent mobile packaging", () => {
  const p = plan(["remoteifes-web/css/style.css"]);
  assert.deepEqual(selected(p), ["server", "e2e", "cordova", "android", "ios"]);
  assert.deepEqual(p.jobs.server, ["ubuntu-latest"]);
  assert.ok(p.jobs.e2e.every((e) => e.os === "ubuntu-latest" && e.browser === "chromium"));
  assert.equal(p.jobs.e2e.length, 4);
  assert.equal(p.jobs.safari, false);
});

test("server changes select server on every OS, the console and frontend integration", () => {
  const p = plan(["remoteifes-server/src/app.js"]);
  assert.deepEqual(selected(p), ["server", "console", "e2e"]);
  assert.deepEqual(p.jobs.server, ALL_OS);
});

test("server lockfile changes are server changes", () => {
  assert.deepEqual(selected(plan(["remoteifes-server/package-lock.json"])), ["server", "console", "e2e"]);
});

test("Cordova changes select mobile validation and the server app contracts", () => {
  assert.deepEqual(selected(plan(["remoteifes-cordova/config.xml"])), ["server", "cordova", "android", "ios"]);
});

test("documentation changes select only the documentation contract tests", () => {
  const p = plan(["README.md", "docs/Projeto_AC.pdf"]);
  assert.deepEqual(selected(p), ["server"]);
  assert.deepEqual(p.jobs.server, ["ubuntu-latest"]);
});

test("E2E spec changes run Chromium; harness or lockfile changes run every browser", () => {
  assert.equal(plan(["e2e/specs/smoke.spec.js"]).jobs.e2e.length, 4);
  for (const file of ["e2e/harness/api-server.js", "e2e/package-lock.json", "e2e/playwright.config.js"]) {
    const p = plan([file]);
    assert.ok(new Set(p.jobs.e2e.map((e) => `${e.os}/${e.browser}`)).size === 6, file);
    assert.equal(p.jobs.safari, true, file);
  }
  assert.deepEqual(selected(plan(["e2e/harness/safari-smoke.js"])), ["safari"]);
});

test("CI definition changes, unknown paths and unknown diffs widen to full validation", () => {
  for (const p of [plan([".github/workflows/ci.yml"]), plan([".gitignore"]), plan(["tools/new.sh"]), plan(null)]) {
    assert.equal(p.mode, "full");
    assert.deepEqual(selected(p), JOBS);
    assert.equal(p.jobs.e2e.length, 23);
    assert.equal(p.jobs.safari, true);
  }
});

test("dependabot configuration alone selects nothing", () => {
  assert.deepEqual(selected(plan([".github/dependabot.yml"])), []);
});

test("full depth on affected scope widens browsers but not subsystems", () => {
  const p = plan(["remoteifes-web/js/app.js"], { fullDepth: true });
  assert.equal(p.mode, "affected-full");
  assert.deepEqual(selected(p), ["server", "e2e", "safari", "cordova", "android", "ios"]);
  assert.equal(new Set(p.jobs.e2e.map((e) => `${e.os}/${e.browser}`)).size, 6);
});

test("renames and deletions contribute every path involved", () => {
  const out = "R087\tremoteifes-web/js/old.js\tremoteifes-console/src/new.js\nD\tremoteifes-esp32/src/x.h\nM\tREADME.md\n";
  assert.deepEqual(parseNameStatus(out), ["remoteifes-web/js/old.js", "remoteifes-console/src/new.js", "remoteifes-esp32/src/x.h", "README.md"]);
  assert.deepEqual([...classify(parseNameStatus(out))].sort(), ["console", "docs", "firmware", "web"]);
});

test("E2E shards cover 1..n exactly once per target", () => {
  const p = plan(null);
  const byTarget = new Map();
  for (const e of p.jobs.e2e) {
    const key = `${e.os}/${e.browser}/${e.channel}`;
    byTarget.set(key, [...(byTarget.get(key) || []), e.shard]);
    assert.ok(e.shard >= 1 && e.shard <= e.shards);
  }
  for (const [key, shards] of byTarget) {
    const n = p.jobs.e2e.find((e) => `${e.os}/${e.browser}/${e.channel}` === key).shards;
    assert.deepEqual(shards, Array.from({ length: n }, (_, i) => i + 1), key);
  }
});

test("verification accepts selected-success and unselected-skipped only", () => {
  const p = plan(["remoteifes-console/src/servidor.js"]);
  const needs = { changes: { result: "success" } };
  for (const job of JOBS) needs[job] = { result: ["console", "packages"].includes(job) ? "success" : "skipped" };
  assert.deepEqual(verifyResults(p, needs), []);

  assert.match(verifyResults(p, { ...needs, console: { result: "skipped" } }).join(), /console: expected success, got skipped/);
  assert.match(verifyResults(p, { ...needs, packages: { result: "cancelled" } }).join(), /packages: expected success/);
  assert.match(verifyResults(p, { ...needs, e2e: { result: "failure" } }).join(), /e2e: expected skipped, got failure/);
  assert.match(verifyResults(p, { ...needs, changes: { result: "failure" } }).join(), /changes: expected success/);
  const missing = { ...needs };
  delete missing.firmware;
  assert.match(verifyResults(p, missing).join(), /firmware: expected skipped, got missing/);
});

test("the workflow wires every selectable job into the result gate", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "workflows", "ci.yml"), "utf8");
  const gate = workflow.slice(workflow.indexOf("\n  result:"));
  const needsLine = gate.match(/needs:\s*\[([^\]]+)\]/);
  assert.ok(needsLine, "result job declares needs");
  const needs = needsLine[1].split(",").map((s) => s.trim());
  assert.deepEqual([...needs].sort(), ["changes", ...JOBS].sort());
  assert.match(gate, /if:\s*always\(\)/);
  for (const job of JOBS) assert.match(workflow, new RegExp(`\\n  ${job}:\\n`), `job ${job} exists`);
});

test("pull_request diffs use the test merge commit's first parent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "select-checks-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  try {
    run("init", "-q", "-b", "main");
    run("config", "user.email", "ci@example.invalid");
    run("config", "user.name", "ci");
    write("README.md", "a\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    run("checkout", "-q", "-b", "feature");
    write("remoteifes-console/src/x.js", "x\n");
    run("add", "-A");
    run("commit", "-q", "-m", "feature");
    run("checkout", "-q", "main");
    write("remoteifes-web/y.js", "y\n");
    run("add", "-A");
    run("commit", "-q", "-m", "main advanced");
    run("merge", "-q", "--no-ff", "-m", "merge", "feature");

    const script = path.join(__dirname, "select-checks.js");
    const output = path.join(dir, "out.txt");
    execFileSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, EVENT_NAME: "pull_request", GITHUB_OUTPUT: output },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const result = JSON.parse(fs.readFileSync(output, "utf8").match(/^plan=(.*)$/m)[1]);
    assert.deepEqual(result.areas, ["console"], "main's own advance is not part of the pull request");

    const pushOut = path.join(dir, "push.txt");
    execFileSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, EVENT_NAME: "push", REF: "refs/heads/main", BEFORE_SHA: "0".repeat(40), GITHUB_OUTPUT: pushOut },
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal(JSON.parse(fs.readFileSync(pushOut, "utf8").match(/^plan=(.*)$/m)[1]).mode, "full", "a new ref has no diff base");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch refuses a moved ref when an exact SHA is requested", () => {
  const script = path.join(__dirname, "select-checks.js");
  assert.throws(
    () =>
      execFileSync(process.execPath, [script], {
        env: { ...process.env, EVENT_NAME: "workflow_dispatch", EXPECTED_SHA: "a".repeat(40), HEAD_SHA: "b".repeat(40), GITHUB_OUTPUT: "" },
        stdio: ["ignore", "ignore", "pipe"],
      }),
    /does not match/,
  );
});
