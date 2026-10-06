"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { classify, selectChecks, verifyResults, parseNameStatus, lastGreenSha, JOBS } = require("./select-checks");

const ALL_OS = ["ubuntu-latest", "windows-latest", "macos-latest"];
const SERVER_OS = ["ubuntu-24.04-arm", "windows-latest", "macos-latest"];
const PACKAGES_OS = [...ALL_OS, "ubuntu-24.04-arm"];
const STARTUP_OS = [...ALL_OS, "ubuntu-24.04-arm"];

function plan(paths, { fullDepth = false, allScope = false } = {}) {
  return selectChecks({ areas: paths === null ? null : classify(paths), fullDepth, allScope });
}

function selected(p) {
  return JOBS.filter((job) => (Array.isArray(p.jobs[job]) ? p.jobs[job].length > 0 : p.jobs[job]));
}

test("console changes select console tests and native package checks only", () => {
  const p = plan(["remoteifes-console/src/servidor.js"]);
  assert.deepEqual(selected(p), ["console", "packages", "deployment", "startup"]);
  assert.deepEqual(p.jobs.console, ALL_OS);
  assert.deepEqual(p.jobs.packages, PACKAGES_OS);
});

test("firmware changes select the firmware build and the server device contracts", () => {
  const p = plan(["remoteifes-esp32/src/main.ino"]);
  assert.deepEqual(selected(p), ["server", "firmware"]);
  assert.deepEqual(p.jobs.server, ["ubuntu-24.04-arm"]);
});

test("web changes select contracts, fast Chromium E2E and dependent mobile packaging", () => {
  const p = plan(["remoteifes-web/css/style.css"]);
  assert.deepEqual(selected(p), ["server", "e2e", "cordova", "android", "ios"]);
  assert.deepEqual(p.jobs.server, ["ubuntu-24.04-arm"]);
  assert.ok(p.jobs.e2e.every((e) => e.os === "ubuntu-latest" && e.browser === "chromium"));
  assert.equal(p.jobs.e2e.length, 4);
  assert.equal(p.jobs.safari, false);
});

test("server changes select server on every OS (Linux on ARM64), the console and frontend integration", () => {
  const p = plan(["remoteifes-server/src/app.js"]);
  assert.deepEqual(selected(p), ["server", "console", "deployment", "e2e", "startup", "pi32"]);
  assert.deepEqual(p.jobs.server, SERVER_OS);
});

test("server lockfile changes are server changes", () => {
  assert.deepEqual(selected(plan(["remoteifes-server/package-lock.json"])), ["server", "console", "deployment", "e2e", "startup", "pi32"]);
});

test("root entrypoint changes select the entrypoint job on every OS and the Raspberry Pi 3 userland", () => {
  for (const file of ["server.sh", "console.bat", "server.py", "startup/common.py", "startup/test/test_node.py"]) {
    const p = plan([file]);
    assert.deepEqual(selected(p), ["startup", "pi32"], file);
    assert.deepEqual(p.jobs.startup, STARTUP_OS, file);
  }
  assert.ok(classify(["server.js"]).has("unknown"), "only the entrypoint names match");
});

test("the armhf userland scripts select only that check; the console does not need it", () => {
  for (const file of ["virtual-lab/host/raspios-armhf.sh", "virtual-lab/host/importar-raspios.sh", "virtual-lab/host/raspios.json"]) {
    assert.deepEqual(selected(plan([file])), ["pi32"], file);
  }
  assert.deepEqual(selected(plan(["virtual-lab/host/raspios-arm64.sh"])), []);
  assert.equal(plan(["remoteifes-console/src/servidor.js"]).jobs.pi32, false);
});

test("Cordova changes select mobile validation and the server app contracts", () => {
  assert.deepEqual(selected(plan(["remoteifes-cordova/config.xml"])), ["server", "cordova", "android", "ios"]);
});

test("documentation changes select only the documentation contract tests", () => {
  const p = plan(["README.md", "docs/Projeto_AC.pdf"]);
  assert.deepEqual(selected(p), ["server"]);
  assert.deepEqual(p.jobs.server, ["ubuntu-24.04-arm"]);
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

test("the virtual hardware lab and its manual workflow select nothing here", () => {
  assert.deepEqual(selected(plan(["virtual-lab/executar.js", "virtual-lab/cenarios/06-nvs.test.js", ".github/workflows/virtual-hardware.yml"])), []);
  assert.equal(plan(["virtual-lab/lib/placa.js", "remoteifes-esp32/src/main.ino"]).jobs.firmware, true, "a firmware change next to it still selects the firmware job");
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
  for (const job of JOBS) needs[job] = { result: ["console", "packages", "deployment", "startup"].includes(job) ? "success" : "skipped" };
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
      env: { ...process.env, EVENT_NAME: "push", REF: "refs/heads/main", GITHUB_TOKEN: "", GITHUB_OUTPUT: pushOut },
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.equal(JSON.parse(fs.readFileSync(pushOut, "utf8").match(/^plan=(.*)$/m)[1]).mode, "full", "without a passing run to compare with, a push validates everything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the last passing run is the newest successful push or dispatch on main", async () => {
  const respond = (status, body) => async () => ({ ok: status === 200, json: async () => body });
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };
  const runs = [
    { event: "pull_request", head_branch: "main", head_sha: "a".repeat(40) },
    { event: "push", head_branch: "outro", head_sha: "b".repeat(40) },
    { event: "push", head_branch: "main", head_sha: "c".repeat(40) },
  ];
  assert.equal(await lastGreenSha(env, respond(200, { workflow_runs: runs })), "c".repeat(40));
  assert.equal(await lastGreenSha(env, respond(200, { workflow_runs: [] })), null);
  assert.equal(await lastGreenSha(env, respond(500, {})), null);
  assert.equal(await lastGreenSha(env, async () => { throw new Error("offline"); }), null);
  assert.equal(await lastGreenSha({}, respond(200, { workflow_runs: runs })), null, "no token, no query");
});

test("a push is diffed against the last passing run, so a cancelled run's changes are not dropped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "select-checks-green-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (file) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", file);
    return git("rev-parse", "HEAD");
  };
  let reply = { status: 200, runs: [] };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ workflow_runs: reply.runs }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "ci");
    const green = commit("README.md");
    const cancelled = commit("remoteifes-web/js/app.js");
    commit("remoteifes-server/src/app.js");

    const output = path.join(dir, "out.txt");
    const planFor = async (runs, status = 200) => {
      reply = { status, runs };
      fs.rmSync(output, { force: true });
      await promisify(execFile)(process.execPath, [path.join(__dirname, "select-checks.js")], {
        cwd: dir,
        env: {
          ...process.env,
          EVENT_NAME: "push",
          REF: "refs/heads/main",
          GITHUB_TOKEN: "token",
          GITHUB_REPOSITORY: "o/r",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          GITHUB_OUTPUT: output,
        },
      });
      return JSON.parse(fs.readFileSync(output, "utf8").match(/^plan=(.*)$/m)[1]);
    };

    const p = await planFor([{ event: "push", head_branch: "main", head_sha: green }]);
    assert.deepEqual(p.areas, ["server", "web"], "the web change of the cancelled run is validated again");
    assert.equal(p.jobs.ios, true);
    assert.equal(requests[0].auth, "Bearer token");
    assert.match(requests[0].url, /^\/repos\/o\/r\/actions\/workflows\/ci\.yml\/runs\?branch=main&status=success/);

    assert.deepEqual((await planFor([{ event: "push", head_branch: "main", head_sha: cancelled }])).areas, ["server"]);
    for (const [runs, status] of [[[], 200], [[{ event: "push", head_branch: "main", head_sha: "f".repeat(40) }], 200], [[], 500]]) {
      assert.equal((await planFor(runs, status)).mode, "full", "an unknown or unreachable base widens to full validation");
    }
  } finally {
    server.close();
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
