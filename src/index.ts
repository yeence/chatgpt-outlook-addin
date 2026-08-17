#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { simpleParser } from "mailparser";
import { z } from "zod";
import {
  assertMailboxAllowed,
  buildRawMessage,
  buildSearch,
  loadConfig,
  resolveDraftsMailbox,
  withClient,
  withMailbox,
} from "./imapClient.js";

const config = loadConfig();

const server = new McpServer({
  name: "imap-mcp-server",
  version: "0.1.0",
});

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

server.registerTool(
  "list_mailboxes",
  {
    title: "List mailboxes",
    description: "List all IMAP mailboxes/folders available in the account, with their status flags.",
    inputSchema: {},
  },
  async () => {
    try {
      const mailboxes = await withClient(config, async (client) => {
        const list = await client.list();
        return list.map((m) => ({
          path: m.path,
          name: m.name,
          delimiter: m.delimiter,
          specialUse: m.specialUse ?? null,
          flags: Array.from(m.flags ?? []),
        }));
      });
      return text(mailboxes);
    } catch (err) {
      return errorResult(err);
    }
  }
);

const listSchema = {
  mailbox: z.string().default("INBOX").describe("Mailbox/folder to list, e.g. INBOX"),
  limit: z
    .number()
    .int()
    .positive()
    .max(config.maxResults)
    .default(Math.min(20, config.maxResults))
    .describe("Max number of messages to return (most recent first)"),
  unseenOnly: z.boolean().default(false).describe("Only return unread messages"),
};

server.registerTool(
  "list_messages",
  {
    title: "List recent messages",
    description:
      "List the most recent messages in a mailbox with basic metadata (uid, subject, from, date, flags). Use get_message to fetch full content.",
    inputSchema: listSchema,
  },
  async ({ mailbox, limit, unseenOnly }) => {
    try {
      assertMailboxAllowed(config, mailbox);
      const messages = await withClient(config, (client) =>
        withMailbox(client, mailbox, async () => {
          const search = unseenOnly ? { seen: false } : { all: true };
          const uids = await client.search(search, { uid: true });
          if (!uids || uids.length === 0) return [];
          const recentUids = uids.slice(-limit).reverse();

          const results: Record<string, unknown>[] = [];
          for await (const msg of client.fetch(
            recentUids,
            { envelope: true, flags: true, uid: true, size: true },
            { uid: true }
          )) {
            results.push({
              uid: msg.uid,
              subject: msg.envelope?.subject ?? null,
              from: msg.envelope?.from?.map((a) => a.address).join(", ") ?? null,
              to: msg.envelope?.to?.map((a) => a.address).join(", ") ?? null,
              date: msg.envelope?.date ?? null,
              flags: Array.from(msg.flags ?? []),
              size: msg.size ?? null,
            });
          }
          return results;
        })
      );
      return text(messages);
    } catch (err) {
      return errorResult(err);
    }
  }
);

const searchSchema = {
  mailbox: z.string().default("INBOX"),
  from: z.string().optional().describe("Filter by sender address/name substring"),
  to: z.string().optional().describe("Filter by recipient address/name substring"),
  subject: z.string().optional().describe("Filter by subject substring"),
  text: z.string().optional().describe("Filter by body text substring"),
  since: z.string().optional().describe("ISO date; only messages on/after this date"),
  before: z.string().optional().describe("ISO date; only messages before this date"),
  unseen: z.boolean().optional().describe("Only unread messages"),
  flagged: z.boolean().optional().describe("Only flagged/starred messages"),
  limit: z
    .number()
    .int()
    .positive()
    .max(config.maxResults)
    .default(Math.min(20, config.maxResults)),
};

server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description:
      "Search a mailbox using IMAP SEARCH criteria (from/to/subject/text/date range/unseen/flagged). Returns matching messages, most recent first.",
    inputSchema: searchSchema,
  },
  async (args) => {
    try {
      assertMailboxAllowed(config, args.mailbox);
      const search = buildSearch(args);
      if (Object.keys(search).length === 0) {
        return errorResult(
          "Provide at least one search criterion (from, to, subject, text, since, before, unseen, flagged)."
        );
      }

      const messages = await withClient(config, (client) =>
        withMailbox(client, args.mailbox, async () => {
          const uids = await client.search(search, { uid: true });
          if (!uids || uids.length === 0) return [];
          const limited = uids.slice(-args.limit).reverse();

          const results: Record<string, unknown>[] = [];
          for await (const msg of client.fetch(
            limited,
            { envelope: true, flags: true, uid: true },
            { uid: true }
          )) {
            results.push({
              uid: msg.uid,
              subject: msg.envelope?.subject ?? null,
              from: msg.envelope?.from?.map((a) => a.address).join(", ") ?? null,
              date: msg.envelope?.date ?? null,
              flags: Array.from(msg.flags ?? []),
            });
          }
          return results;
        })
      );
      return text(messages);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_message",
  {
    title: "Get full message",
    description:
      "Fetch and parse the full content of a single message by UID, including text/HTML body and attachment metadata.",
    inputSchema: {
      mailbox: z.string().default("INBOX"),
      uid: z.number().int().positive().describe("Message UID (from list_messages/search_messages)"),
      maxBodyLength: z
        .number()
        .int()
        .positive()
        .default(20000)
        .describe("Truncate the text body to this many characters"),
    },
  },
  async ({ mailbox, uid, maxBodyLength }) => {
    try {
      assertMailboxAllowed(config, mailbox);
      const result = await withClient(config, (client) =>
        withMailbox(client, mailbox, async () => {
          const raw = await client.download(uid, undefined, { uid: true });
          if (!raw) return null;
          const parsed = await simpleParser(raw.content);
          return {
            uid,
            subject: parsed.subject ?? null,
            from: parsed.from?.text ?? null,
            to: parsed.to && "text" in parsed.to ? parsed.to.text : null,
            cc: parsed.cc && "text" in parsed.cc ? parsed.cc.text : null,
            date: parsed.date ?? null,
            text: parsed.text
              ? parsed.text.slice(0, maxBodyLength)
              : null,
            textTruncated: (parsed.text?.length ?? 0) > maxBodyLength,
            html: parsed.html ? "[html body present, use text field]" : null,
            attachments: parsed.attachments.map((a) => ({
              filename: a.filename ?? null,
              contentType: a.contentType,
              size: a.size,
            })),
          };
        })
      );
      if (!result) return errorResult(`Message uid=${uid} not found in ${mailbox}`);
      return text(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "create_draft",
  {
    title: "Create draft",
    description:
      "Compose a message and save it as a draft via IMAP APPEND (flagged \\Draft). This never sends mail — it only writes to the Drafts mailbox, exactly like clicking \"Save draft\" in a mail client.",
    inputSchema: {
      to: z.array(z.string()).optional().describe("Recipient addresses"),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string().optional(),
      text: z.string().optional().describe("Plain-text body"),
      html: z.string().optional().describe("HTML body"),
      inReplyTo: z.string().optional().describe("Message-Id header of the message being replied to"),
      references: z.array(z.string()).optional().describe("Message-Id chain for threading"),
      mailbox: z
        .string()
        .optional()
        .describe("Destination mailbox; defaults to the account's Drafts folder"),
    },
  },
  async ({ to, cc, bcc, subject, text: bodyText, html, inReplyTo, references, mailbox }) => {
    try {
      if (!to?.length && !subject && !bodyText && !html) {
        return errorResult("Provide at least one of: to, subject, text, html.");
      }

      const result = await withClient(config, async (client) => {
        const targetMailbox = mailbox ?? (await resolveDraftsMailbox(config, client));
        assertMailboxAllowed(config, targetMailbox);

        const raw = await buildRawMessage({
          from: config.user,
          to,
          cc,
          bcc,
          subject,
          text: bodyText,
          html,
          inReplyTo,
          references,
        });

        return client.append(targetMailbox, raw, ["\\Draft"]);
      });

      return text(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting imap-mcp-server:", err);
  process.exit(1);
});
