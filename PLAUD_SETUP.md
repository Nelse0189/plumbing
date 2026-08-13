# Plaud Call Intake Setup

Office calls are recorded on a Plaud Note, transcribed by Plaud, then synced
into the dispatch app. This uses the same official developer API as the Plaud
CLI (`plaud files`, `plaud transcript`, `plaud summary`).

## One-time Plaud login

Run this on your own computer, not in the Cloud Agent terminal. `plaud login`
opens a browser and writes tokens to your home directory. A global `npm
install -g` is not required and often fails with `EACCES`.

On a trusted machine with Node.js 20+:

```bash
npx -y @plaud-ai/cli login
npx -y @plaud-ai/cli me
npx -y @plaud-ai/cli today
```

If you prefer a local install instead of `npx`:

```bash
npm install @plaud-ai/cli
npx plaud login
```

`plaud login` stores tokens at `~/.plaud/tokens.json`. Copy the
`refresh_token` value into Cloud Functions:

```env
PLAUD_REFRESH_TOKEN=paste-refresh-token-here
PLAUD_API_BASE=https://platform.plaud.ai/developer/api
```

Deploy functions after saving the token:

```bash
npm --prefix functions run build
firebase deploy --only functions,firestore:rules
```

Plaud's developer API requires a paid Plaud plan (Pro or Unlimited). The free
Starter tier cannot list recordings.

## Daily workflow

1. Record customer calls on the Plaud Note and let them sync to Plaud.
2. Open the **Calls** tab and choose the day.
3. Click **Sync Plaud recordings**, or wait for the 15-minute background sync.
4. Review summaries. Booked water-heater appointments become work orders, with
   the confirming transcript sentence highlighted.
5. Ask the day-chat questions such as "Which calls booked appointments?"

If Plaud still shows a recording without a transcript, the app keeps it as
`awaiting_transcript` and retries on the next sync.

## Manual fallback

If a recording is not in Plaud yet, paste `plaud transcript <id>` output into
**Import a transcript manually** on the Calls tab.

## Token refresh

Access tokens expire about every hour. The functions refresh them with
`PLAUD_REFRESH_TOKEN` and store the latest pair in `plaudAuth/tokens`. That
document is not readable from the browser. If sync starts failing with an
auth error, run `plaud login` again and update `PLAUD_REFRESH_TOKEN`.
