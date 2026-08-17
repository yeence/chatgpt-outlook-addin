# imap-mcp-server

A custom [Model Context Protocol](https://modelcontextprotocol.io) server that lets
an MCP-compatible client (Claude Desktop, Claude Code, etc.) read email and write
drafts over **IMAP** — works with Gmail, Outlook/Office 365, iCloud, Fastmail, or
any standard IMAP provider.

## Tools

| Tool | Description |
|---|---|
| `list_mailboxes` | List all folders/mailboxes in the account |
| `list_messages` | List the most recent messages in a mailbox |
| `search_messages` | Search by from/to/subject/text/date range/unseen/flagged |
| `get_message` | Fetch full parsed content (body + attachment metadata) of one message by UID |
| `create_draft` | Compose a message and save it to the Drafts folder via IMAP APPEND |

This server is intentionally read-only against existing mail: there's no way to
mark messages read/unread, flag them, move them between folders, or delete
them. The only write path is `create_draft`, which saves a new message to the
Drafts folder (flagged `\Draft`) exactly like clicking "Save draft" in a mail
client — there is no `send_message` tool either, and nothing here can dispatch
an email. Sending requires SMTP, a separate protocol/credential this server
doesn't touch.

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

   `.env` is already listed in `.gitignore`, so it never gets committed. The
   server itself never contains a username or password — `src/imapClient.ts`
   only ever reads `process.env.IMAP_*`, which `dotenv` populates from `.env`
   at startup.

   **Always use an app password here, never your real account password.** An
   app password is a long random string scoped to one app, and it can be
   revoked independently at any time without changing your main password. See
   [Generating an App Password](#generating-an-app-password) below.

3. Common provider settings:

   | Provider | Host | Port |
   |---|---|---|
   | Gmail | `imap.gmail.com` | 993 |
   | Outlook/Office 365 | `outlook.office365.com` | 993 |
   | iCloud | `imap.mail.me.com` | 993 |
   | Fastmail | `imap.fastmail.com` | 993 |

## Generating an App Password

App passwords require two-factor authentication (2FA) to be enabled on the
account first — providers only offer the app-password option once 2FA is on.

**Gmail**
1. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification
2. Go to https://myaccount.google.com/apppasswords (sign in again if asked).
3. Enter a name for the app, e.g. `imap-mcp-server`, and click **Create**.
4. Google shows a 16-character password once — copy it immediately into
   `IMAP_PASSWORD` in `.env`. It won't be shown again; if you lose it, revoke
   it and generate a new one.

**Outlook / Office 365 (personal Microsoft account)**
1. Enable two-step verification: https://account.live.com/proofs/manage
2. Go to https://account.live.com/proofs/AppPassword
3. Click **Create a new app password** and copy the generated password into
   `IMAP_PASSWORD`.
4. For work/school (Microsoft 365 tenant) accounts, app passwords are
   controlled by your admin under Security settings — basic auth/IMAP may be
   disabled entirely, in which case OAuth2/XOAUTH2 is required (see
   [OAuth-only providers](#oauth-only-providers) below).

**iCloud**
1. Enable two-factor authentication on your Apple ID (required).
2. Go to https://appleid.apple.com/account/manage, sign in, and open
   **Sign-In and Security → App-Specific Passwords**.
3. Click **Generate an app-specific password**, name it, and copy it into
   `IMAP_PASSWORD`.

**Fastmail**
1. Go to Settings → **Password & Security → App passwords**.
2. Click **New app password**, choose access scope "Mail (IMAP/SMTP)", and
   copy the generated password into `IMAP_PASSWORD`.

After generating the password, keep it only in your local `.env` file (or
your MCP client's env config, e.g. `claude_desktop_config.json`) — never in
code, chat, or a committed file. If a password is ever pasted somewhere
public by mistake, revoke it immediately from the same settings page and
generate a new one.

## Testing the connection safely

Before wiring the server into an MCP client, validate that IMAP connectivity
and the underlying logic behind each tool actually work, without exposing any
of your data:

```bash
npm run test:imap
```

This runs `scripts/test-connection.ts`, a local script that:

- connects and authenticates using the same `.env` values as the server;
- exercises the logic behind `list_mailboxes`, `list_messages`, and
  `get_message` against your real mailbox;
- prints **only pass/fail status and counts** — never your password, never
  message subjects/bodies/senders, and never full mailbox names. Your email
  address is shown masked (e.g. `jo***@example.com`) so you can confirm which
  account it connected to.

`create_draft` is not exercised by default, since it's the one operation that
writes something. To also test it, run:

```bash
npm run test:imap -- --create-draft
```

This appends one throwaway draft (subject `[imap-mcp-server self-test] <timestamp>`,
addressed only to yourself) to your Drafts folder, confirms it saved, and then
deletes that single test message immediately afterward using a direct IMAP
call local to the script — the MCP server itself has no delete tool, so this
cleanup step exists only inside the test script, purely to leave your mailbox
exactly as it found it.

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

- Set `IMAP_ALLOWED_MAILBOXES` in `.env` (comma-separated) to restrict which
  folders any tool — including `create_draft`'s destination — can touch, e.g.
  `IMAP_ALLOWED_MAILBOXES=INBOX,Drafts`.
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
