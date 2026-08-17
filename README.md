# imap-mcp-server

A custom [Model Context Protocol](https://modelcontextprotocol.io) server that lets
an MCP-compatible client (Claude Desktop, Claude Code, etc.) read and manage email
over **IMAP** — works with Gmail, Outlook/Office 365, iCloud, Fastmail, or any
standard IMAP provider.

## Tools

| Tool | Description |
|---|---|
| `list_mailboxes` | List all folders/mailboxes in the account |
| `list_messages` | List the most recent messages in a mailbox |
| `search_messages` | Search by from/to/subject/text/date range/unseen/flagged |
| `get_message` | Fetch full parsed content (body + attachment metadata) of one message by UID |
| `create_draft` | Compose a message and save it to the Drafts folder via IMAP APPEND |
| `set_flags` | Add/remove flags, e.g. mark read/unread or starred |
| `move_message` | Move a message to another folder |
| `delete_message` | Delete a message (soft-flag or permanent expunge) |

This server never sends mail. Writing is limited to `create_draft`, which saves
a message to the Drafts folder (flagged `\Draft`) exactly like clicking "Save
draft" in a mail client — there is no `send_message` tool, and none of the IMAP
operations here can dispatch an email. Sending requires SMTP, a separate
protocol/credential this server doesn't touch.

`create_draft` auto-detects the Drafts folder (via the `\Drafts` special-use
flag, falling back to a folder literally named "Drafts"). Override with
`IMAP_DRAFTS_MAILBOX` in `.env` if your provider names it differently (e.g.
Gmail uses `[Gmail]/Drafts`).

## Setup

1. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

2. Copy `.env.example` to `.env` and fill in your IMAP credentials:

   ```bash
   cp .env.example .env
   ```

   ```ini
   IMAP_HOST=imap.gmail.com
   IMAP_PORT=993
   IMAP_SECURE=true
   IMAP_USER=you@gmail.com
   IMAP_PASSWORD=your-app-password
   ```

   **Use an app password, not your normal password.** For Gmail, enable 2FA then
   create one at https://myaccount.google.com/apppasswords. For Outlook/Office
   365, create an app password under Security settings, or use `outlook.office365.com`
   as the host with modern auth if your tenant requires OAuth (see note below).

3. Common provider settings:

   | Provider | Host | Port |
   |---|---|---|
   | Gmail | `imap.gmail.com` | 993 |
   | Outlook/Office 365 | `outlook.office365.com` | 993 |
   | iCloud | `imap.mail.me.com` | 993 |
   | Fastmail | `imap.fastmail.com` | 993 |

## Running standalone

```bash
npm run dev      # runs directly from TypeScript via tsx
# or
npm run build && npm start
```

The server communicates over stdio, per the MCP spec — it's meant to be launched
by an MCP client, not run interactively.

## Using with Claude Desktop / Claude Code

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imap": {
      "command": "node",
      "args": ["/absolute/path/to/imap-mcp-server/dist/index.js"],
      "env": {
        "IMAP_HOST": "imap.gmail.com",
        "IMAP_PORT": "993",
        "IMAP_SECURE": "true",
        "IMAP_USER": "you@gmail.com",
        "IMAP_PASSWORD": "your-app-password"
      }
    }
  }
}
```

Or point `command`/`args` at `npx tsx /absolute/path/to/src/index.ts` to skip the
build step during development.

## Safety notes

- `delete_message` defaults to **permanent** deletion (flags `\Deleted` and
  expunges). Pass `permanent: false` to just flag it without expunging.
- Set `IMAP_ALLOWED_MAILBOXES` in `.env` (comma-separated) to restrict which
  folders `move_message`/`delete_message`/etc. can touch, e.g.
  `IMAP_ALLOWED_MAILBOXES=INBOX,Archive`.
- `IMAP_MAX_RESULTS` caps how many messages a single `list_messages`/
  `search_messages` call can return (default 50), to avoid dumping huge mailboxes
  into a model's context.
- Credentials are read from environment variables only — never hardcode them in
  the MCP client config committed to source control.

## OAuth-only providers

Gmail and Office 365 accounts with "less secure app access" disabled and no app
password option require XOAUTH2. `imapflow` (the underlying client) supports
passing an OAuth2 access token via `auth: { user, accessToken }` instead of a
password — if you need this, extend `src/imapClient.ts` to source a token (e.g.
via a refresh-token exchange) instead of `IMAP_PASSWORD`.
