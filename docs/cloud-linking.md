# Cloud linking (Google Drive, Dropbox) through rclone

ShotDrop links a user's own Google Drive or Dropbox with one button. Nothing is hosted by us: the sign-in is
OAuth between the user's browser, rclone and the provider, and tokens stay in a file on the user's PC.

Verified against rclone 1.75.2 (the version `scripts/fetch-binaries.mjs` pins) unless marked **(unverified)**.
The final browser sign-in was *not* exercised with a real account during development.

## How the flow works

1. **`rclone authorize "<backend>" [blob] [--auth-no-open-browser]`** starts a loopback web server on
   `127.0.0.1:53682`, opens the system browser (or just prints the URL with `--auth-no-open-browser`) and waits.
   After consent it prints the token to stdout between `--->` and `<---End paste` markers, then exits.
   - The optional second argument is a **base64url (no padding) JSON blob** of backend options. We use it for
     `scope` and the user's own `client_id` / `client_secret`, e.g. `{"scope":"drive.file","client_id":"…","client_secret":"…"}`.
     Checked by fetching the local `/auth` URL: it redirects to `accounts.google.com` with the right `scope=` and `client_id=`.
     (Plain base64 with `=` padding is rejected: "illegal base64 data".)
   - The port is fixed, so **only one sign-in can run at a time**. `CloudAccounts.link` refuses a second one; cancel kills the process.
   - The Dropbox redirect URI is `http://localhost:53682/`, Drive's is `http://127.0.0.1:53682/`. Both are what the
     provider app must have registered if you use your own app.
2. **`rclone config create <name> <type> scope=… token=<json> [client_id=… client_secret=…] --non-interactive --config <dataDir>/rclone.conf`**
   writes the remote without any further prompting. `--non-interactive` matters: if the token is unusable, rclone
   would otherwise start its own OAuth wizard (this happened in testing when a shell mangled the JSON quotes).
   With it, the remote is saved and rclone just reports a pending question (e.g. the shared-client-ID warning below).
3. Everything after that is plain rclone against the app-owned config: `lsjson --dirs-only`, `mkdir`, `about --json`,
   `config userinfo`, `config delete`, `copyto` (sync).

### Config isolation

All commands pass `--config <dataDir>/rclone.conf`; the user's own `rclone.conf` (`%APPDATA%\rclone\rclone.conf`) is
never read or written. Remotes in the app config are named `gdrive-xxxx` / `dropbox-xxxx` (random suffix, so any number of
accounts can be linked). `sync.ts` passes `--config` only when the destination's remote exists in the app config, so
existing destinations pointing at a remote in the user's own rclone.conf (the "Advanced: custom rclone remote" option)
keep working unchanged.

The token is passed as a command-line argument to `config create` for a split second, so it is visible to other
processes of the same user in the process list. Acceptable for a single-user desktop app; there is no stdin variant.

## Google Drive

### Scope: `drive.file` vs `drive`

| | `drive.file` (default) | `drive` (opt-in checkbox) |
|---|---|---|
| Access | Only files/folders **created by the app** (this OAuth client) | Everything in the user's Drive |
| Google review | Non-sensitive scope, no verification needed | Restricted scope; an unverified app shows a warning and (for your own client in Testing mode) a 100-user cap |
| Existing folders | **Invisible**: the folder browser shows only what ShotDrop created | Browsable, can pick any folder |
| Safety | Worst case ShotDrop can only touch its own uploads | Token can read/delete all of the user's Drive |

Decision: default to `drive.file`. The UI offers "Create folder" first, which is the natural flow for an ingest
destination (`ShotDrop/<shoot>`). A checkbox under "Sign-in options" opts in to full access for people who want to
upload into an existing shared folder. Consequence to explain in the UI: with `drive.file`, a folder the user made
by hand in Drive will not appear. Note files are tied to the OAuth client: if the user later re-links with a
*different* client ID, the folders created earlier are no longer visible to the new link **(unverified, but follows from Google's model)**.

### Client ID: the shared one is going away

rclone 1.75.2 itself warns on `config create`: *"rclone's shared Google Drive client_id is being retired and will stop
working during 2026. Create your own to avoid interruption."* So for Drive, **a user-supplied client ID should be treated
as the expected path**, not a rarity. Even before retirement the shared ID is rate limited across all rclone users.
Dropbox's shared app key also works but is shared and rate limited **(unverified for 2026)**.

The Sign-in options panel therefore has an optional Client ID / Client secret pair, passed in the authorize blob and
stored in the remote (`client_id`, `client_secret`). To create one (Drive):

1. <https://console.cloud.google.com/> → create a project → **APIs & Services → Library → Google Drive API → Enable**.
2. **OAuth consent screen**: user type *External*, fill the app name and email. Add the scope `…/auth/drive.file`
   (and `…/auth/drive` if using full access). Then **Publish app** ("In production"). This matters: while the app is in
   *Testing* status Google expires refresh tokens after **7 days**, and the link silently stops working weekly.
   `drive.file` is non-sensitive, so no verification is required to publish.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy client ID and secret into ShotDrop.
   (rclone's guide: <https://rclone.org/drive/#making-your-own-client-id>.)

Dropbox: <https://www.dropbox.com/developers/apps> → *Create app* → Scoped access → choose access type (below) →
Permissions tab: enable `files.metadata.read`, `files.metadata.write`, `files.content.read`, `files.content.write`
(plus `account_info.read` for the email) → Settings tab: add redirect URI `http://localhost:53682/`, copy App key / App secret.

### Quota and account info

`rclone about --json remote:` returns `total` / `used` / `free` (bytes) for Drive and Dropbox; the UI shows free space.
The signed-in email is best effort via `rclone config userinfo remote:`: it may fail with `drive.file` (no profile
scope) **(unverified)**, in which case the UI shows the remote name instead.

## Dropbox

- **App folder vs full access** is a property of the Dropbox *app*, not of rclone. rclone's built-in shared app is
  full-Dropbox **(unverified; check on first real link)**. A user who creates their own app can pick "App folder"
  and then ShotDrop sees only `Apps/<app name>/`, where the remote root is that folder. Same trade-off as Drive's
  `drive.file`, but folders the user makes inside the app folder are visible.
- rclone requests a short-lived access token plus a refresh token (offline access) automatically.

## Token refresh, revoking, accounts

- **Refresh**: rclone refreshes the access token on demand and writes the new token back into `rclone.conf`.
  Nothing to implement, but the config file must stay writable (it lives in the app's data dir). Refresh tokens die
  if the user revokes access, changes their Google password with certain policies, or (Google) the OAuth app is in
  Testing mode for >7 days. A dead token shows up as `invalid_grant` / 401 in the sync job errors; the fix is
  Disconnect + Connect again.
- **Disconnect** = `rclone config delete <name>`: it forgets the token locally. rclone has no revoke call, so the grant
  stays in the provider's list until the user removes it: Google <https://myaccount.google.com/permissions>,
  Dropbox <https://www.dropbox.com/account/connected_apps>. The UI should mention this (the confirm dialog says
  uploaded files stay in the cloud).
- **Delete protection**: `DELETE /api/cloud/accounts/:name` returns 409 while a destination still targets that account.
- **Multiple accounts**: supported by construction (unique remote names, one destination per remote+folder).
  Two sign-ins cannot run at once (fixed port 53682).

## OneDrive: not free

The authorize step is identical, but `rclone config create onedrive` also needs `drive_id` and `drive_type`
(personal / business / SharePoint); without them rclone asks interactively. Doing it properly means calling
Microsoft Graph (`/me/drives`) with the token to list drives and let the user choose, plus a different quota shape.
Roughly a day of work, so it is left out. Adding it would be one new entry in `TYPES` in `src/main/core/cloud.ts`
plus that drive-selection step.

## API (all local-only: 403 for LAN/tunnel requests)

| | |
|---|---|
| `GET /api/cloud/accounts` | `{accounts, linking}`; `linking.authUrl` is the sign-in URL if the browser did not open |
| `POST /api/cloud/link` `{provider, fullAccess?, clientId?, clientSecret?}` | Blocks up to 5 min until signed in; `201` account, `409` cancelled/busy, `502` error |
| `DELETE /api/cloud/link` | Cancel an in-progress sign-in |
| `GET /api/cloud/accounts/:name/folders?path=` | Sub-folders |
| `POST /api/cloud/accounts/:name/folders` `{path}` | Create a folder (`mkdir -p` semantics) |
| `GET /api/cloud/accounts/:name/info` | `{email, quota}` |
| `DELETE /api/cloud/accounts/:name` | Disconnect |

## Manual end-to-end test (needs a real account)

1. `npm run fetch-binaries`, then `npm run dev` (or use the portable build).
2. Settings → Sync → *Google Drive / Dropbox* → **Connect Google Drive**. The browser opens; approve. The panel shows
   "Finish signing in in your browser…" until you do; **Cancel** aborts.
3. The account appears with free space; the folder browser opens. Create a folder, **Use this folder**, name it, **Add**.
4. Drop a photo in via FTP (or Resync): it appears in that Drive folder, and `%APPDATA%\ShotDrop\rclone.conf`
   (or `.dev-data/app/rclone.conf` in dev) holds the remote while your own `rclone.conf` is unchanged.
5. Repeat with Dropbox. Try **Disconnect** while a destination uses the account (expect a refusal), then after removing it.
6. Try Sign-in options with your own client ID.
