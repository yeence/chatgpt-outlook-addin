import { ImapFlow, type ImapFlowOptions, type SearchObject } from "imapflow";

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  maxResults: number;
  allowedMailboxes: string[] | null;
  draftsMailbox: string | null;
}

export function loadConfig(): ImapConfig {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (!host || !user || !password) {
    throw new Error(
      "Missing IMAP configuration. Set IMAP_HOST, IMAP_USER and IMAP_PASSWORD (see .env.example)."
    );
  }

  const allowed = process.env.IMAP_ALLOWED_MAILBOXES;

  return {
    host,
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: (process.env.IMAP_SECURE ?? "true").toLowerCase() !== "false",
    user,
    password,
    maxResults: Number(process.env.IMAP_MAX_RESULTS ?? 50),
    allowedMailboxes: allowed
      ? allowed.split(",").map((m) => m.trim()).filter(Boolean)
      : null,
    draftsMailbox: process.env.IMAP_DRAFTS_MAILBOX?.trim() || null,
  };
}

export function assertMailboxAllowed(config: ImapConfig, mailbox: string) {
  if (config.allowedMailboxes && !config.allowedMailboxes.includes(mailbox)) {
    throw new Error(
      `Mailbox "${mailbox}" is not in IMAP_ALLOWED_MAILBOXES (${config.allowedMailboxes.join(", ")}).`
    );
  }
}

export async function withClient<T>(
  config: ImapConfig,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const options: ImapFlowOptions = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
  };

  const client = new ImapFlow(options);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export async function resolveDraftsMailbox(
  config: ImapConfig,
  client: ImapFlow
): Promise<string> {
  if (config.draftsMailbox) return config.draftsMailbox;

  const list = await client.list();
  const bySpecialUse = list.find((m) => m.specialUse === "\\Drafts");
  if (bySpecialUse) return bySpecialUse.path;

  const byName = list.find((m) => /drafts/i.test(m.name));
  if (byName) return byName.path;

  return "Drafts";
}

export async function withMailbox<T>(
  client: ImapFlow,
  mailbox: string,
  fn: () => Promise<T>
): Promise<T> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export function buildSearch(criteria: {
  unseen?: boolean;
  flagged?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
}): SearchObject {
  const search: SearchObject = {};
  if (criteria.unseen) search.seen = false;
  if (criteria.flagged) search.flagged = true;
  if (criteria.from) search.from = criteria.from;
  if (criteria.to) search.to = criteria.to;
  if (criteria.subject) search.subject = criteria.subject;
  if (criteria.text) search.body = criteria.text;
  if (criteria.since) search.since = new Date(criteria.since);
  if (criteria.before) search.before = new Date(criteria.before);
  return search;
}
