#!/usr/bin/env node
/**
 * Local, read-mostly self-test for the IMAP MCP server.
 *
 * Verifies the connection and the same logic the MCP tools use
 * (list_mailboxes / list_messages / get_message, and optionally
 * create_draft) without ever printing credentials, message bodies,
 * subjects, or sender/recipient addresses to the console — only
 * counts and pass/fail status.
 *
 * Usage:
 *   npm run test:imap                # connection + read-only checks
 *   npm run test:imap -- --create-draft
 *                                     # also exercises create_draft;
 *                                     # the test draft is deleted again
 *                                     # immediately after, via a direct
 *                                     # imapflow call local to this
 *                                     # script (the MCP server itself
 *                                     # exposes no delete tool).
 */
import "dotenv/config";
import {
  assertMailboxAllowed,
  buildRawMessage,
  loadConfig,
  resolveDraftsMailbox,
  withClient,
  withMailbox,
} from "../src/imapClient.js";

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}

let failures = 0;

function ok(label: string, detail?: string) {
  console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
}

function fail(label: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ✗ ${label}: ${msg}`);
  failures++;
}

function skip(label: string, reason: string) {
  console.log(`  – ${label} skipped (${reason})`);
}

const CREATE_DRAFT_TEST = process.argv.includes("--create-draft");

async function main() {
  console.log("imap-mcp-server — connection self-test");
  console.log("(no credentials, message content, or addresses are ever printed)\n");

  const config = loadConfig();
  console.log(`Account: ${maskEmail(config.user)}`);
  console.log(`Host:    ${config.host}:${config.port} (secure=${config.secure})\n`);

  await withClient(config, async (client) => {
    ok("Connect + authenticate");

    let mailboxCount = 0;
    try {
      const mailboxes = await client.list();
      mailboxCount = mailboxes.length;
      ok("list_mailboxes", `${mailboxCount} mailboxes`);
    } catch (err) {
      fail("list_mailboxes", err);
      return;
    }

    let latestUid: number | null = null;
    try {
      await withMailbox(client, "INBOX", async () => {
        const uids = await client.search({ all: true }, { uid: true });
        const count = uids ? uids.length : 0;
        ok("list_messages (INBOX)", `${count} messages`);
        if (uids && uids.length > 0) {
          latestUid = uids[uids.length - 1];
        }
      });
    } catch (err) {
      fail("list_messages (INBOX)", err);
    }

    if (latestUid !== null) {
      try {
        await withMailbox(client, "INBOX", async () => {
          const raw = await client.download(latestUid as number, undefined, { uid: true });
          ok("get_message", raw ? "fetched content" : "no content returned");
        });
      } catch (err) {
        fail("get_message", err);
      }
    } else {
      skip("get_message", "INBOX has no messages");
    }

    if (CREATE_DRAFT_TEST) {
      try {
        const draftsMailbox = await resolveDraftsMailbox(config, client);
        assertMailboxAllowed(config, draftsMailbox);

        const raw = await buildRawMessage({
          from: config.user,
          to: [config.user],
          subject: `[imap-mcp-server self-test] ${new Date().toISOString()}`,
          text: "Automated self-test draft from test-connection.ts. Safe to ignore; it is deleted automatically right after this check runs.",
        });

        const appended = await client.append(draftsMailbox, raw, ["\\Draft"]);
        if (!appended || !appended.uid) {
          throw new Error("server did not return a UID for the appended draft; cannot verify/clean up");
        }
        ok("create_draft", `saved to ${draftsMailbox}`);

        await withMailbox(client, draftsMailbox, async () => {
          await client.messageFlagsAdd({ uid: String(appended.uid) }, ["\\Deleted"], { uid: true });
          await client.messageDelete({ uid: String(appended.uid) }, { uid: true });
        });
        ok("cleanup", "test draft removed");
      } catch (err) {
        fail("create_draft", err);
      }
    } else {
      skip("create_draft", "pass --create-draft to test it; it cleans up after itself");
    }
  });

  console.log();
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("All checks passed.");
}

main().catch((err) => {
  fail("Unexpected error", err);
  process.exitCode = 1;
});
