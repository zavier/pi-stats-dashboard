import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/aggregate.js";

const u = (n, c = 1) => ({ input: n, output: n, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n * 2, cost: { total: c } });

test("aggregates sessions, forks, transcripts, tools and warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-"));
  await mkdir(join(root, "project"), { recursive: true });
  const a = { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: u(10), stopReason: "stop", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] } };
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  await writeFile(join(root, "project", "a.jsonl"), [header, JSON.stringify(a), "bad json", JSON.stringify({ type: "compaction", id: "c", timestamp: new Date().toISOString(), usage: u(2) })].join("\n"));
  await writeFile(join(root, "project", "fork.jsonl"), [header, JSON.stringify(a)].join("\n"));
  await mkdir(join(root, "project", "subagent-artifacts"));
  await writeFile(join(root, "project", "subagent-artifacts", "x_transcript.jsonl"), JSON.stringify({ recordType: "message", role: "assistant", runId: "r", timestamp: Date.now(), provider: "p", model: "m2", usage: u(3) }));
  const out = await aggregate(root);
  assert.equal(out.totals.all.requests, 3);
  assert.equal(out.totals.all.input, 15);
  assert.equal(out.diagnostics.invalidLines, 1);
  assert.equal(out.by.tool.bash.requests, 1);
});

test("range breakdowns exclude records outside the selected range", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-range-"));
  await mkdir(join(root, "project"), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  const now = Date.now(), old = now - 40 * 86400000;
  const msg = (id, model, ts, n, content = []) => JSON.stringify({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "assistant", provider: "p-" + model, model, usage: u(n), stopReason: "stop", content } });
  const tool = [{ type: "toolCall", id: "t1", name: "oldtool", arguments: {} }];
  await writeFile(join(root, "project", "s.jsonl"), [header, msg("recent", "new-model", now, 10), msg("old", "old-model", old, 5, tool)].join("\n"));
  const out = await aggregate(root);
  assert.equal(out.by.model["p-new-model/new-model"].requests, 1);
  assert.equal(out.by.model["p-old-model/old-model"].requests, 1);
  assert.equal(out.byRange.all.model["p-old-model/old-model"].requests, 1);
  assert.equal(out.byRange.today.model["p-new-model/new-model"].requests, 1);
  assert.equal(out.byRange.today.model["p-old-model/old-model"], undefined);
  assert.equal(out.byRange.month.model["p-old-model/old-model"], undefined);
  assert.equal(out.byRange.month.model["p-new-model/new-model"].requests, 1);
  assert.equal(out.by.tool.oldtool.requests, 1);
  assert.equal(out.byRange.today.tool.oldtool, undefined);
  assert.equal(Object.keys(out.daysRange.today).length, 1);
  assert.ok(out.daysRange.all[new Date(old).toISOString().slice(0, 10)].requests > 0);
  const day = new Date(now).toISOString().slice(0, 10), oldDay = new Date(old).toISOString().slice(0, 10);
  assert.equal(out.seriesRange.all[day].model["p-new-model/new-model"], 20);
  assert.equal(out.seriesRange.all[day].provider["p-new-model"], 20);
  assert.equal(out.seriesRange.all[oldDay].model["p-old-model/old-model"], 10);
  assert.equal(out.seriesRange.today[day].model["p-new-model/new-model"], 20);
  assert.equal(out.seriesRange.today[oldDay], undefined);
});

test("token totals use usage.totalTokens and keep reasoning separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-tok-"));
  await mkdir(join(root, "project"), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  // reasoning is recorded but excluded from totalTokens by Pi
  const usage = { input: 100, output: 40, reasoning: 25, cacheRead: 10, cacheWrite: 0, totalTokens: 150, cost: { total: 0.5 } };
  const asst = JSON.stringify({ type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage, stopReason: "stop", content: [] } });
  await writeFile(join(root, "project", "one.jsonl"), [header, asst].join("\n"));
  await writeFile(join(root, "project", "two.jsonl"), [header, asst].join("\n")); // forked copy
  const out = await aggregate(root);
  assert.equal(out.totals.all.requests, 1);
  assert.equal(out.totals.all.tokens, 150); // not 175
  assert.equal(out.totals.all.reasoning, 25); // still recorded for display
});

test("token totals fall back to component sum when totalTokens is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-fb-"));
  await mkdir(join(root, "project"), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  const usage = { input: 7, output: 3, cacheRead: 5, cacheWrite: 2 };
  const asst = JSON.stringify({ type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage, stopReason: "stop", content: [] } });
  await writeFile(join(root, "project", "s.jsonl"), [header, asst].join("\n"));
  const out = await aggregate(root);
  assert.equal(out.totals.all.tokens, 17);
});

test("day buckets use local dates consistent with range cutoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-tz-"));
  await mkdir(join(root, "project"), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  const early = new Date();
  early.setHours(0, 30, 0, 0); // 00:30 local today
  const asst = JSON.stringify({ type: "message", id: "a1", timestamp: early.toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop", content: [] } });
  await writeFile(join(root, "project", "s.jsonl"), [header, asst].join("\n"));
  const out = await aggregate(root);
  const local = `${early.getFullYear()}-${String(early.getMonth() + 1).padStart(2, "0")}-${String(early.getDate()).padStart(2, "0")}`;
  assert.deepEqual(Object.keys(out.daysRange.today), [local]);
});

test("project labels use the decoded cwd path relative to the given root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-proj-"));
  await mkdir(join(root, "-Users-someone-secret-project-"), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  const asst = JSON.stringify({ type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop", content: [] } });
  await writeFile(join(root, "-Users-someone-secret-project-", "s.jsonl"), [header, asst].join("\n"));
  const out = await aggregate(root);
  const keys = Object.keys(out.by.project);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "/Users/someone/secret/project");
});

test("project label prefers the session cwd over the decoded slug", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-cwd-"));
  await mkdir(join(root, "--Users-someone-real-project--"), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/actual/path/with-hyphen" });
  const asst = JSON.stringify({ type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop", content: [] } });
  await writeFile(join(root, "--Users-someone-real-project--", "s.jsonl"), [header, asst].join("\n"));
  const out = await aggregate(root);
  assert.deepEqual(Object.keys(out.by.project), ["/actual/path/with-hyphen"]);
});

test("unreadable session files are skipped instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-broken-"));
  await symlink(join(root, "does-not-exist.jsonl"), join(root, "broken.jsonl"));
  const out = await aggregate(root);
  assert.equal(out.diagnostics.unreadableFiles, 1);
});
