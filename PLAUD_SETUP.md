# Plaud Call Intake Setup

Office calls are recorded on a Plaud Note, transcribed by Plaud, then synced
into the dispatch app. This uses the same official developer API as the Plaud
CLI (`plaud files`, `plaud transcript`, `plaud summary`).

## Connect from the Calls tab (recommended)

Plaud's official CLI login currently shows a broken page with labels like
`oauth_bind_device_title`. Use the normal Plaud website instead:

1. Open https://web.plaud.ai and sign in as usual.
2. In Edge, open Developer tools with **Ctrl+Shift+I**, right-click → **Inspect**,
   or **Fn+F12**. Or use ⋯ → More tools → Developer tools.
3. Open the **Network** tab, refresh the page, and click a request whose URL
   contains `api.plaud.ai`.
4. Open **Cookies** or **Headers → Cookie**. You can paste the entire Cookie
   line on the Calls tab. The app extracts `pld_wt` or `pld_ut` (the `eyJ...`
   value). Semicolons only separate cookies.
5. Ignore `pld_sessionMeta` / `token_id`. Those are not the login token.
6. If Cookie has no `eyJ` value, try Local Storage → `https://web.plaud.ai` →
   the key that ends with `:workspaceList` → copy `workspaceToken`.
7. Or in the Console tab run:

   ```js
   const key = Object.keys(localStorage).find(k => k.endsWith(':workspaceList'));
   const list = JSON.parse(localStorage.getItem(key) || '[]');
   copy(list[0].workspaceToken);
   ```

8. On the dispatch **Calls** tab, paste that Cookie line or token and click **Connect Plaud account**.

Do not paste the token into chat. The Calls tab stores it in a private
Firestore document used only by Cloud Functions.

## One-time Plaud CLI login

Run this on your own computer, not in the Cloud Agent terminal. `plaud login`
opens a browser and writes tokens to your home directory. A global `npm
install -g` is not required and often fails with `EACCES`. The official OAuth
page may currently fail with a broken bind-device screen; use the Calls tab
method above if that happens.

On a trusted machine with Node.js 20+:

```bash
npx -y @plaud-ai/cli login
npx -y @plaud-ai/cli me
npx -y @plaud-ai/cli today
```

On Windows PowerShell, `npx` can fail with `PSSecurityException` because
script execution is disabled. Use Command Prompt, or call the `.cmd` shim:

```bat
npx.cmd -y @plaud-ai/cli login
npx.cmd -y @plaud-ai/cli me
```

If you prefer a local install instead of `npx`:

```bash
npm install @plaud-ai/cli
npx plaud login
```

A successful login creates `tokens.json`. `version-check.json` only means the
CLI started; it is not the login file.

| Computer | Token file |
| --- | --- |
| Windows | `C:\Users\<you>\.plaud\tokens.json` |
| macOS / Linux | `~/.plaud/tokens.json` |

If that file is missing, login did not finish. Run `login` again and leave the
terminal open until it says authorization succeeded. If no browser opens, copy
the URL printed in the terminal and open it yourself, then click **Authorize**.

Confirm with:

```bat
npx.cmd -y @plaud-ai/cli me
dir %USERPROFILE%\.plaud
```

`me` should print your Plaud account. Then open `tokens.json` and copy the
`refresh_token` value into Cloud Functions:

```env
PLAUD_REFRESH_TOKEN=paste-refresh-token-here
PLAUD_API_BASE=https://platform.plaud.ai/developer/api
```

Deploy functions after saving the token. From the **repo root** (not `functions/`):

```bash
npx firebase-tools login --no-localhost
npm run deploy:functions
```

`login --no-localhost` is required in this remote terminal. The default login redirects to `localhost:9005`, which will show “refused to connect.” After Allow, copy the authorization code from the browser and paste it back into the terminal.

There is no global `firebase` command in this project. Use `npx firebase-tools` or `npm run deploy:functions`.

Plaud's developer API requires a paid Plaud plan (Pro or Unlimited). The free
Starter tier cannot list recordings.

## Daily workflow

1. Record customer calls on the Plaud Note and let them sync to Plaud.
2. Open the **Calls** tab and click **Import all Plaud calls** to pull every
   recording from Plaud (already saved calls are skipped). Use **Sync this day**
   if you only want the selected date. The list defaults to all imported
   recordings; switch to **Show this day** to filter.
3. The 15-minute background job still pulls only the last two days.
4. Review summaries. Booked water-heater appointments become work orders, with
   the confirming transcript sentence highlighted.
5. Ask the day-chat questions such as "Which calls booked appointments?"

If the Calls tab still shows 0 recordings, the connected login is not the
account that owns the files. Sign in at https://web.plaud.ai as the plumber
whose Plaud Note made the recordings, then paste that session Cookie and
click **Connect Plaud account**. A user token (`pld_ut`) can look connected
while returning an empty library; the app now mints a workspace token and
follows Plaud’s regional API automatically.

## Manual fallback

If a recording is not in Plaud yet, paste `plaud transcript <id>` output into
**Import a transcript manually** on the Calls tab.

## Token refresh

Access tokens expire about every hour. The functions refresh them with
`PLAUD_REFRESH_TOKEN` and store the latest pair in `plaudAuth/tokens`. That
document is not readable from the browser. If sync starts failing with an
auth error, run `plaud login` again and update `PLAUD_REFRESH_TOKEN`.
