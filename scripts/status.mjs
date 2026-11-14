// Print the vault's on-chain state and recent events (read-only, no keys).
import { CONFIG, view, fmt } from "../lib/warden.mjs";
const s = await view("get_state");
console.log(`${CONFIG.vault}: balance ${fmt(s.balance)}, spent today ${fmt(s.spent_today)} of ${fmt(s.policy.daily_cap)}, nonce ${s.nonce}`);
console.log(`judge ${s.policy.judge_model}, attested signers: ${s.signers.map((x) => x.address).join(", ") || "none"}`);
for (const e of await view("get_events", { limit: 20 })) console.log(`#${e.id} ${e.kind.padEnd(13)} ${fmt(e.amount).padStart(10)} -> ${e.receiver} [${e.layer}] ${e.reason}`);
