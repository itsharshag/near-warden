// One-time testnet setup: sub-accounts, deploy, init, the agent's scoped key,
// and the attested TEE signer. Re-runnable: skips what already exists.
//   node scripts/setup.mjs            (needs KEYS/<owner>.json)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG, ROOT, KeyPair, account, saveKey, provider, nearToYocto, teraToGas, attest, view, JUDGE_SYSTEM_PROMPT } from "../lib/warden.mjs";
import { actions, PublicKey } from "near-api-js";

const owner = account(CONFIG.owner);
const exists = async (id) => provider.viewAccount({ accountId: id }).then(() => true, () => false);

async function sub(id, near) {
  if (await exists(id)) return console.log(`= ${id} exists`);
  const kp = KeyPair.fromRandom("ed25519");
  await owner.signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(nearToYocto(near)), actions.addFullAccessKey(kp.getPublicKey())],
  });
  saveKey(id, id, kp);
  console.log(`+ ${id} (${near} NEAR)`);
}

await sub(CONFIG.vault, "6");
await sub(CONFIG.vendor, "0.2");
await sub(CONFIG.newVendor, "0.2");
await sub(CONFIG.attacker, "0.2");

const vaultAdmin = account(CONFIG.vault);
const wasm = fs.readFileSync(path.join(ROOT, "contract/res/warden.wasm"));
const policy = {
  per_payment_cap: nearToYocto(CONFIG.policy.per_payment_cap).toString(),
  daily_cap: nearToYocto(CONFIG.policy.daily_cap).toString(),
  auto_approve_below: nearToYocto(CONFIG.policy.auto_approve_below).toString(),
  allowlist: [CONFIG.vendor],
  judge_model: CONFIG.judgeModel,
  judge_system_prompt: JUDGE_SYSTEM_PROMPT,
};

let initialized = await view("get_state").then(() => true, () => false);
const acts = [actions.deployContract(wasm)];
if (!initialized) acts.push(actions.functionCall("new", { owner: CONFIG.owner, policy, mandate: CONFIG.mandate }, teraToGas("100"), 0n));
await vaultAdmin.signAndSendTransaction({ receiverId: CONFIG.vault, actions: acts });
console.log(`+ deployed warden.wasm (sha256 ${crypto.createHash("sha256").update(wasm).digest("hex").slice(0, 16)}...)${initialized ? "" : " and initialized"}`);
if (initialized) {
  await owner.callFunction({ contractId: CONFIG.vault, methodName: "set_policy", args: { policy }, gas: teraToGas("50") });
  await owner.callFunction({ contractId: CONFIG.vault, methodName: "set_mandate", args: { mandate: CONFIG.mandate }, gas: teraToGas("50") });
  console.log("+ policy and mandate updated");
}

// The agent's key: function-call only, receiver = the vault, methods pay + report,
// 0.5 NEAR gas allowance. It cannot transfer, deploy, add keys or call anything else.
const agentFile = "agent-" + CONFIG.vault;
if (!fs.existsSync(path.join(process.env.WARDEN_KEYS || path.join(process.env.HOME, ".near-warden"), agentFile + ".json"))) {
  const kp = KeyPair.fromRandom("ed25519");
  await vaultAdmin.signAndSendTransaction({
    receiverId: CONFIG.vault,
    actions: [actions.addFunctionCallAccessKey(kp.getPublicKey(), CONFIG.vault, ["pay", "report"], nearToYocto("0.5"))],
  });
  saveKey(agentFile, CONFIG.vault, kp);
  console.log(`+ agent function-call key ${kp.getPublicKey().toString()}`);
}

// Owner hands the vault's full-access key back: after this only the owner
// (via owner-only methods) and the scoped agent key remain. Kept as an opt-in
// step so the demo stays redeployable: WARDEN_LOCK=1 node scripts/setup.mjs
if (process.env.WARDEN_LOCK === "1") {
  const keys = await provider.viewAccessKeyList({ accountId: CONFIG.vault });
  const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key);
  await vaultAdmin.signAndSendTransaction({ receiverId: CONFIG.vault, actions: full.map((pk) => actions.deleteKey(PublicKey.fromString(pk))) });
  console.log(`+ removed ${full.length} full-access key(s) from the vault`);
}

// Verify the judge model's TEE attestation, then register its signer on chain.
const a = attest(CONFIG.judgeModel);
if (!a.ok) throw new Error("attestation failed: " + a.error);
fs.mkdirSync(path.join(ROOT, "evidence"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "evidence/attestation-latest.json"), JSON.stringify(a, null, 2));
const state = await view("get_state");
for (const m of a.models) {
  if (state.signers.some((s) => s.address === m.signing_address)) { console.log(`= signer ${m.signing_address} registered`); continue; }
  await owner.callFunction({
    contractId: CONFIG.vault,
    methodName: "add_signer",
    args: { address: m.signing_address, model: CONFIG.judgeModel, evidence_sha256: a.report_sha256 },
    gas: teraToGas("30"),
  });
  console.log(`+ attested signer ${m.signing_address} (${m.checks.length} checks passed, TCB ${m.tcb_status})`);
}
console.log("done:", JSON.stringify({ vault: CONFIG.vault, balance: (await view("get_state")).balance }));
