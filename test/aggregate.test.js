import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/aggregate.js";

const u = (n, c = 1) => ({ input: n, output: n, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n * 2, cost: { total: c } });

test("aggregates sessions, forks, transcripts, tools and warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-"));
  await mkdir(join(root, "project"), { recursive: true });
  const a = { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: u(10), stopReason: "stop", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] } };
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  await writeFile(join(root, "project", "a.jsonl"), [header, JSON.stringify({ type: "message", id: "u", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "NOOO!!! you forgot" }] } }), JSON.stringify(a), "bad json", JSON.stringify({ type: "compaction", id: "c", timestamp: new Date().toISOString(), usage: u(2) })].join("\n"));
  await writeFile(join(root, "project", "fork.jsonl"), [header, JSON.stringify(a)].join("\n"));
  await mkdir(join(root, "project", "subagent-artifacts"));
  await writeFile(join(root, "project", "subagent-artifacts", "x_transcript.jsonl"), JSON.stringify({ recordType: "message", role: "assistant", runId: "r", timestamp: Date.now(), provider: "p", model: "m2", usage: u(3) }));
  const out = await aggregate(root);
  assert.equal(out.totals.all.requests, 3);
  assert.equal(out.totals.all.input, 15);
  assert.equal(out.diagnostics.invalidLines, 1);
  assert.equal(out.behavior.messages, 1);
  assert.ok(out.behavior.anguish > 0);
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
