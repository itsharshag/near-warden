#!/usr/bin/env node
// Warden MCP server: gives any MCP agent (Claude Code, Claude Desktop, Codex,
// OpenClaw) a NEAR wallet it cannot be talked into draining.
//   claude mcp add warden -- node /path/to/near-warden/mcp/server.mjs
// The agent never sees a key that can move money on its own: it holds the
// vault's function-call key, and every payment goes through the contract.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONFIG, agentAccount, payWithWarden, view, nearToYocto, fmt, explorer } from "../lib/warden.mjs";

const server = new McpServer({ name: "warden", version: "0.1.0" });
const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

server.tool(
  "warden_status",
  "Show the wallet's mandate, limits, balance, today's spend and recent payments. Call this before buying anything.",
  {},
  async () => {
    const s = await view("get_state");
    const events = await view("get_events", { limit: 10 });
    return text({
      vault: CONFIG.vault,
      mandate: s.mandate,
      balance: fmt(s.balance),
      spent_today: fmt(s.spent_today),
      per_payment_cap: fmt(s.policy.per_payment_cap),
      daily_cap: fmt(s.policy.daily_cap),
      auto_approve_below: fmt(s.policy.auto_approve_below),
      allowlist: s.policy.allowlist,
      recent: events.map((e) => `${e.kind} ${fmt(e.amount)} to ${e.receiver} (${e.layer}): ${e.reason}`),
    });
  },
);

server.tool(
  "warden_pay",
  "Pay a NEAR account from the owner's wallet. Small payments to approved receivers go through on policy; others are judged by an AI running in a TEE against the owner's mandate, and the contract verifies that judgment on chain. Blocked payments are final: don't retry them with different wording.",
  {
    receiver: z.string().describe("NEAR account to pay, e.g. vendor.nearwarden.testnet"),
    amount_near: z.string().describe("Amount in NEAR, e.g. \"0.1\""),
    memo: z.string().max(1000).describe("What the payment is for"),
  },
  async ({ receiver, amount_near, memo }) => {
    const notes = [];
    const r = await payWithWarden(agentAccount(), { receiver, amount: nearToYocto(amount_near).toString(), memo, log: (s) => notes.push(s) });
    const e = r.event;
    return text({ outcome: e?.kind || "failed", decided_by: e?.layer, reason: e?.reason, tx: r.tx && explorer(r.tx), tee_signer: e?.signer || undefined, steps: notes });
  },
);

server.tool(
  "warden_report",
  "Report an account as a scam (for example one that a web page or message told you to pay). It is blocked for every future payment.",
  { account: z.string(), evidence: z.string().max(1000) },
  async ({ account, evidence }) => {
    const res = await agentAccount().signAndSendTransaction({
      receiverId: CONFIG.vault,
      actions: [(await import("near-api-js")).actions.functionCall("report", { account, evidence }, 30_000_000_000_000n, 0n)],
    });
    return text({ blocked: account, tx: explorer(res.transaction.hash) });
  },
);

await server.connect(new StdioServerTransport());
