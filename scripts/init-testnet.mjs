// Make your own Warden on testnet: creates a fresh owner account from the
// public testnet faucet and writes warden.local.json. Then run setup + demo.
//   node scripts/init-testnet.mjs && node scripts/setup.mjs && node scripts/demo.mjs
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { ROOT, saveKey } from "../lib/warden.mjs";

const id = process.argv[2] || `warden-${Math.random().toString(36).slice(2, 8)}.testnet`;
const kp = KeyPair.fromRandom("ed25519");
const r = await fetch("https://helper.nearprotocol.com/account", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
});
if (!r.ok) throw new Error(`faucet said ${r.status}: ${(await r.text()).slice(0, 200)}`);
saveKey(id, id, kp);
fs.writeFileSync(path.join(ROOT, "warden.local.json"), JSON.stringify({ owner: id }, null, 2) + "\n");
console.log(`created ${id} (10 NEAR from the testnet faucet), key in ~/.near-warden/${id}.json`);
console.log(`next: node scripts/setup.mjs && node scripts/demo.mjs`);
