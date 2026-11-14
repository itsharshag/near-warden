// Writes the latest testnet runs from evidence/ into README.md's "Live run" table.
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const rows = [];
const latest = new Map();
// The latest full community run, then any later single-scene runs replace their scenes.
const commons = path.join(ROOT, "evidence/commons-run.json");
if (fs.existsSync(commons)) {
  const runs = JSON.parse(fs.readFileSync(commons, "utf8")).runs;
  const full = runs.reduce((at, r, i) => (new Set(r.results.map((x) => x.scene)).size >= 5 ? i : at), 0);
  const byScene = new Map();
  for (const run of runs.slice(full)) {
    const scenes = new Set(run.results.filter((r) => r.kind !== "skipped").map((r) => r.scene));
    for (const sc of scenes) byScene.set(sc, run.results.filter((r) => r.scene === sc).map((r) => ({ ...r, vault: run.vault })));
  }
  for (const [sc, rs] of byScene) rs.forEach((r, i) => latest.set(sc + i, r));
}
const agent = path.join(ROOT, "evidence/demo-run.json");
if (fs.existsSync(agent)) { const run = JSON.parse(fs.readFileSync(agent, "utf8")); for (const r of run.results) latest.set("agent-" + r.scene + "|" + (r.tx || r.reason), { ...r, scene: "agent wallet: " + r.scene, vault: run.vault }); }
for (const r of latest.values()) {
  const tx = r.tx ? `[${r.tx.slice(0, 8)}...](https://testnet.nearblocks.io/txns/${r.tx})` : "rejected before execution";
  rows.push(`| ${r.scene} | ${String(r.kind).replace("_", " ")} | ${r.layer} | ${String(r.reason || "").replace(/\|/g, "/").slice(0, 120)} | ${tx} |`);
}
const table = `| Scene | Outcome | Decided by | Reason (from the contract's event) | Transaction |\n|---|---|---|---|---|\n${rows.join("\n")}`;
const p = path.join(ROOT, "README.md");
const s = fs.readFileSync(p, "utf8").replace(/<!--RUN-->[\s\S]*?<!--\/RUN-->/, `<!--RUN-->\n${table}\n<!--/RUN-->`);
fs.writeFileSync(p, s);
console.log(`${rows.length} rows`);
