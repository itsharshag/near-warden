// Community setup on testnet: a Sputnik DAO with a treasury, a Warden vault the
// DAO owns, a payout agent with a function-call key, contributors, and the
// attested TEE signer. Re-runnable: skips what already exists.
//   WARDEN_CONFIG=commons node scripts/setup-commons.mjs [funder.testnet ...]
// Funders are faucet accounts with keys in ~/.near-warden used to pay storage.
import fs from "node:fs";
import path from "node:path";
import { CONFIG, ROOT, KeyPair, account, saveKey, provider, nearToYocto, teraToGas, attest, view, JUDGE_SYSTEM_PROMPT, KEYS } from "../lib/warden.mjs";
import { actions } from "near-api-js";

const owner = account(CONFIG.owner);
const funders = process.argv.slice(2).map((id) => account(id));
const exists = async (id) => provider.viewAccount({ accountId: id }).then(() => true, () => false);
const bal = async (id) => BigInt((await provider.viewAccount({ accountId: id })).amount);
const N = (x) => nearToYocto(String(x));

// 1. Pool faucet funds on the owner.
for (const f of funders) {
  const b = await bal(f.accountId);
  if (b > N(1)) {
    await f.signAndSendTransaction({ receiverId: CONFIG.owner, actions: [actions.transfer(b - N(0.5))] });
    console.log(`+ ${f.accountId} sent ${(b - N(0.5)) / N(1)} NEAR to the owner`);
  }
}

// 2. The DAO: the owner is its only council member; anyone may file proposals.
if (!(await exists(CONFIG.dao))) {
  const policy = {
    roles: [
      { name: "council", kind: { Group: CONFIG.council }, permissions: ["*:*"], vote_policy: {} },
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: N(CONFIG.community.dao_bond).toString(),
    proposal_period: "604800000000000",
    bounty_bond: N(0.1).toString(),
    bounty_forgiveness_period: "86400000000000",
  };
  const args = { config: { name: CONFIG.dao.split(".")[0], purpose: "Warden Commons: a community treasury whose small payouts run through a Warden vault", metadata: "" }, policy };
  await owner.signAndSendTransaction({
    receiverId: "sputnikv2.testnet",
    actions: [actions.functionCall("create", { name: CONFIG.dao.split(".")[0], args: Buffer.from(JSON.stringify(args)).toString("base64") }, teraToGas("250"), N(6))],
  });
  console.log(`+ DAO ${CONFIG.dao}`);
}
// Treasury for grants voted by the DAO.
if ((await bal(CONFIG.dao)) < N(8)) {
  await owner.signAndSendTransaction({ receiverId: CONFIG.dao, actions: [actions.transfer(N(3))] });
  console.log(`+ 3 NEAR into the DAO treasury`);
}

// 3. Accounts: the vault and the contributors.
async function sub(id, near) {
  if (await exists(id)) return console.log(`= ${id} exists`);
  const kp = KeyPair.fromRandom("ed25519");
  await owner.signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(N(near)), actions.addFullAccessKey(kp.getPublicKey())] });
  saveKey(id, id, kp);
  console.log(`+ ${id} (${near} NEAR)`);
}
await sub(CONFIG.vault, 5);
for (const c of CONFIG.contributors) await sub(c, 0.1);

// 4. Deploy and configure the vault while the owner still holds it.
const vaultAdmin = account(CONFIG.vault);
const wasm = fs.readFileSync(path.join(ROOT, "contract/res/warden.wasm"));
const policy = {
  per_payment_cap: N(CONFIG.policy.per_payment_cap).toString(),
  daily_cap: N(CONFIG.policy.daily_cap).toString(),
  auto_approve_below: N(CONFIG.policy.auto_approve_below).toString(),
  allowlist: [],
  judge_model: CONFIG.judgeModel,
  judge_system_prompt: JUDGE_SYSTEM_PROMPT,
};
const initialized = await view("get_state").then(() => true, () => false);
if (!initialized) {
  await vaultAdmin.signAndSendTransaction({
    receiverId: CONFIG.vault,
    actions: [actions.deployContract(wasm), actions.functionCall("new", { owner: CONFIG.owner, policy, mandate: CONFIG.mandate }, teraToGas("100"), 0n)],
  });
  console.log("+ deployed and initialized the vault");
}
let st = await view("get_state");
if (st.owner === CONFIG.owner) {
  await owner.callFunction({
    contractId: CONFIG.vault,
    methodName: "set_community",
    args: { community: { dao: CONFIG.dao, council: CONFIG.council, trusted_after: CONFIG.community.trusted_after, dao_bond: N(CONFIG.community.dao_bond).toString() } },
    gas: teraToGas("30"),
  });
  console.log("+ community: DAO, council, trust after", CONFIG.community.trusted_after, "payouts");
}

// 5. The payout agent's key: function-call only, methods pay + report.
const agentFile = "agent-" + CONFIG.vault;
if (!fs.existsSync(path.join(KEYS, agentFile + ".json"))) {
  const kp = KeyPair.fromRandom("ed25519");
  await vaultAdmin.signAndSendTransaction({ receiverId: CONFIG.vault, actions: [actions.addFunctionCallAccessKey(kp.getPublicKey(), CONFIG.vault, ["pay", "report"], N(0.5))] });
  saveKey(agentFile, CONFIG.vault, kp);
  console.log(`+ agent function-call key ${kp.getPublicKey().toString()}`);
}

// 6. Attested TEE signer.
const a = attest(CONFIG.judgeModel);
if (!a.ok) throw new Error("attestation failed: " + a.error);
fs.mkdirSync(path.join(ROOT, "evidence"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "evidence/attestation-latest.json"), JSON.stringify(a, null, 2));
st = await view("get_state");
for (const m of a.models) {
  if (st.signers.some((s) => s.address === m.signing_address)) { console.log(`= signer ${m.signing_address}`); continue; }
  if (st.owner !== CONFIG.owner) { console.log(`! signer ${m.signing_address} needs a DAO proposal now`); continue; }
  await owner.callFunction({ contractId: CONFIG.vault, methodName: "add_signer", args: { address: m.signing_address, model: CONFIG.judgeModel, evidence_sha256: a.report_sha256 }, gas: teraToGas("30") });
  console.log(`+ attested signer ${m.signing_address} (${m.checks.length} checks, TCB ${m.tcb_status})`);
}

// 7. Hand the vault to the DAO: from now on only a DAO vote changes its rules.
// The vault's own full-access key goes too, so not even its creator can move funds.
st = await view("get_state");
if (st.owner === CONFIG.owner) {
  await owner.callFunction({ contractId: CONFIG.vault, methodName: "set_owner", args: { owner: CONFIG.dao }, gas: teraToGas("30") });
  console.log(`+ vault owner is now ${CONFIG.dao}`);
}
const keys = await provider.viewAccessKeyList({ accountId: CONFIG.vault });
const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key);
if (full.length && process.env.WARDEN_LOCK === "1") {
  const { PublicKey } = await import("near-api-js");
  await vaultAdmin.signAndSendTransaction({ receiverId: CONFIG.vault, actions: full.map((pk) => actions.deleteKey(PublicKey.fromString(pk))) });
  console.log(`+ removed ${full.length} full-access key(s) from the vault`);
}
console.log("done:", JSON.stringify({ vault: CONFIG.vault, dao: CONFIG.dao, vault_balance: String((await bal(CONFIG.vault)) / N(1)), dao_balance: String((await bal(CONFIG.dao)) / N(1)) }));
