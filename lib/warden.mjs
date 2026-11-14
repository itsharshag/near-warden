// Shared client code: NEAR accounts, the Warden contract, and the TEE judge.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, yoctoToNear } from "near-api-js";
import { ethers } from "ethers";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
export const NEARAI = process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1";
export const KEYS = process.env.WARDEN_KEYS || path.join(process.env.HOME, ".near-warden");
// warden.config.json is the deployed demo. scripts/init-testnet.mjs writes
// warden.local.json (gitignored) with your own owner, and every account name
// is derived from the owner.
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "warden.config.json"), "utf8"));
const localFile = path.join(ROOT, "warden.local.json");
const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {};
export const CONFIG = { ...base, ...local };
if (local.owner) {
  for (const [k, sub] of [["vault", "vault"], ["vendor", "vendor"], ["newVendor", "newsdata"], ["attacker", "drainer"]]) CONFIG[k] = `${sub}.${local.owner}`;
  CONFIG.mandate = base.mandate.replaceAll(base.vendor, CONFIG.vendor);
}
export const provider = new JsonRpcProvider({ url: RPC });
export { nearToYocto, yoctoToNear, teraToGas, KeyPair };

export const JUDGE_MODEL = CONFIG.judgeModel;
export const JUDGE_SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, "lib/judge-system-prompt.txt"), "utf8");

/** Load a signer for `accountId` from KEYS/<accountId>.json (never in the repo). */
export function account(accountId, file = accountId) {
  const p = path.join(KEYS, file + ".json");
  const { private_key } = JSON.parse(fs.readFileSync(p, "utf8"));
  return new Account(accountId, provider, private_key);
}

export function saveKey(file, accountId, kp) {
  fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(KEYS, file + ".json"), JSON.stringify({ account_id: accountId, private_key: kp.toString() }), { mode: 0o600 });
}

export const view = (method, args = {}) =>
  provider.callFunction({ contractId: CONFIG.vault, method, args });

export function nearAiKey() {
  if (process.env.NEARAI_API_KEY) return process.env.NEARAI_API_KEY;
  const f = path.join(KEYS, "nearai.key");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  throw new Error("Set NEARAI_API_KEY (a NEAR AI Cloud key from cloud.near.ai)");
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * Ask the TEE judge about a payment and collect the evidence the contract checks.
 * The user message comes from the contract's own `judge_prompt` view, so the judge
 * always sees the on-chain mandate and nonce.
 */
export async function judge({ receiver, amount, memo, promptOverride, log = () => {} }) {
  // promptOverride exists only so the demo can show an agent lying to the judge.
  const prompt = promptOverride ?? (await view("judge_prompt", { receiver, amount, memo }));
  const body = JSON.stringify({
    model: JUDGE_MODEL,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 1200,
    stream: false,
  });
  const requestBytes = Buffer.from(body, "utf8");
  log(`judge: asking ${JUDGE_MODEL} inside its TEE (request sha256 ${sha256(requestBytes).slice(0, 16)}...)`);
  const r = await fetch(`${NEARAI}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nearAiKey()}`,
      "x-no-aliasing": "true",
      "Accept-Encoding": "identity",
    },
    body: requestBytes,
  });
  const responseBytes = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`judge HTTP ${r.status}: ${responseBytes.toString().slice(0, 300)}`);
  const resp = JSON.parse(responseBytes.toString("utf8"));
  const content = resp.choices?.[0]?.message?.content || "";
  // The signature is recorded shortly after the completion: retry briefly.
  let sig;
  for (let i = 0; i < 10; i++) {
    const s = await fetch(`${NEARAI}/signature/${resp.id}?signing_algo=ecdsa&model=${encodeURIComponent(JUDGE_MODEL)}`, {
      headers: { Authorization: `Bearer ${nearAiKey()}` },
    });
    if (s.ok) {
      const j = await s.json();
      if (j.signature) { sig = j; break; }
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!sig) throw new Error("judge signature not available");
  const expected = `${JUDGE_MODEL}:${sha256(requestBytes)}:${sha256(responseBytes)}`;
  if (sig.text !== expected) throw new Error(`signed text mismatch: ${sig.text} vs ${expected}`);
  const recovered = ethers.verifyMessage(Buffer.from(sig.text, "utf8"), sig.signature).toLowerCase();
  log(`judge: answer signed by ${recovered} (${sig.signature_kind || "unknown kind"})`);
  return {
    content,
    signer: recovered,
    signatureKind: sig.signature_kind,
    verdict: {
      request: requestBytes.toString("base64"),
      response: responseBytes.toString("base64"),
      signature: Buffer.from(ethers.getBytes(sig.signature)).toString("base64"),
    },
  };
}

/** Call `pay` on the vault with the agent's function-call key. */
export async function pay(agent, { receiver, amount, memo, verdict }) {
  const res = await agent.signAndSendTransaction({
    receiverId: CONFIG.vault,
    actions: [
      actions.functionCall("pay", { receiver, amount, memo, verdict: verdict || null }, teraToGas("150"), 0n),
    ],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const b64 = res.status?.SuccessValue;
  const event = b64 ? JSON.parse(Buffer.from(b64, "base64").toString()) : null;
  return { tx: res.transaction?.hash || res.transaction_outcome?.id, event, raw: res };
}

export function attest(model = JUDGE_MODEL) {
  const out = execFileSync("python3", [path.join(ROOT, "verifier/attest.py"), model], { encoding: "utf8", maxBuffer: 1 << 24 });
  return JSON.parse(out);
}

export const explorer = (tx) => `https://testnet.nearblocks.io/txns/${tx}`;
export const fmt = (y) => `${yoctoToNear(BigInt(y), 3)} NEAR`;

/**
 * The whole flow an agent framework needs: try policy alone, and if the
 * contract asks for a verdict, get one from the TEE judge and try again.
 */
export async function payWithWarden(agent, { receiver, amount, memo, log = () => {} }) {
  const first = await pay(agent, { receiver, amount, memo });
  if (first.event?.kind !== "needs_verdict") return first;
  log(`policy: ${first.event.reason}`);
  const j = await judge({ receiver, amount, memo, log });
  log(`judge: ${j.content.trim().slice(0, 240)}`);
  const second = await pay(agent, { receiver, amount, memo, verdict: j.verdict });
  return { ...second, judge: j.content, firstTx: first.tx };
}

export function agentAccount() {
  return account(CONFIG.vault, "agent-" + CONFIG.vault);
}
