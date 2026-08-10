# Teams Work Order Automation

This workflow turns PDF work orders attached to Microsoft Teams channel messages
into reviewed unscheduled jobs, SMS-assisted schedule entries, and CSV records
that can be opened in Google Sheets.

## Workflow

1. Open `teams-test.html`, sign in to Microsoft, and choose a team/channel.
2. Channel PDFs are imported automatically: Firebase cache is checked first;
   uncached PDFs are downloaded, text-extracted, cleaned with `gpt-5.6-luna`,
   and saved to `workOrders`.
3. Matching channel notes (same post, or other posts mentioning the work-order
   number / customer / address) are appended under **Channel notes**.
4. Incomplete imports land in **Needs review**; complete ones in **Unscheduled**.
5. Staff can edit a record and click **Update Firebase job** if corrections are
   needed. Use **Re-import** only to force a fresh AI pass.
6. **Schedule by text** sends available times only to `SMS_TEST_RECIPIENT`.
7. A reply selecting a valid time moves the work order into the scheduled
   database and truck schedule.
8. **Export CSV for Google Sheets** downloads reviewed rows in a
   Sheets-compatible format.

AI output is never scheduled automatically. Human review is required because
PDF extraction can misread names, dates, phone numbers, or handwritten/scanned
documents.

## Required Microsoft Graph delegated permissions

```text
User.Read
Team.ReadBasic.All
Channel.ReadBasic.All
ChannelMessage.Read.All
Files.Read.All
```

`Files.Read.All` is required to resolve the actual document library behind a
Teams channel through the Graph `filesFolder` API. Access remains delegated: the
app still acts as the signed-in user and cannot read files that user cannot
access.

## Environment configuration

Copy the server-side template:

```bash
cp functions/.env.example functions/.env
```

Fill in:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
MICROSOFT_TENANT_ID=your-entra-tenant-id

TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
SMS_TEST_RECIPIENT=+18609643025

COMPANY_NAME=Your Plumbing Company
```

`OPENAI_API_KEY` and Twilio credentials are server secrets. Never put them in a
`VITE_` variable, browser code, or source control. Vite variables are bundled
into public JavaScript.

The callable functions validate the user's Microsoft Graph access token and,
when `MICROSOFT_TENANT_ID` is configured, reject accounts from other tenants.

Deploy the functions after configuring the environment:

```bash
npm --prefix functions run build
firebase deploy --only functions
```

The current project uses Firebase string parameters loaded from the Functions
environment for compatibility with its existing functions. Before a production
launch, migrate credentials to `defineSecret`, bind those secrets to every
function that uses them, and store their values in Firebase Secret Manager.

## SMS compliance and operations

- Send messages only when the customer has authorized transactional texts.
- Register US application-to-person traffic as required by Twilio (for example,
  A2P 10DLC or an approved toll-free sender).
- Maintain opt-out handling (`STOP`) and honor revocation immediately.
- Keep the reminder transactional; do not add marketing content.
- Verify the extracted phone number and appointment date before saving.
- Restrict Firestore and application access because work orders contain
  customer personal information.
- While test mode is enabled, all outbound scheduling and reminder messages are
  routed to `SMS_TEST_RECIPIENT`; customer phone numbers are stored but not used
  as message destinations.

## CT Dispatch board

The main app **Dispatch** tab is a 5-truck Connecticut day board:

1. Work orders for the selected date appear as **Not Ready** (no notes on the
   PDF/doc) or **Ready / Unassigned** (notes present).
2. Drag jobs onto trucks and reorder stops. Default route order is farthest from
   the depot (`DISPATCH_ORIGIN_ADDRESS`, default `216 Berlin Lane, Berlin, CT`)
   first; higher **Priority** overrides distance.
3. Default arrival windows by stop position (plumber can edit any window):
   - 1st: 8 AM–12 PM
   - 2nd: 10 AM–2 PM
   - 3rd: 12 PM–4 PM
   - then +2 hours start for later stops
4. **Set** locks the truck and queues morning window texts for
   `DISPATCH_MORNING_HOUR` Eastern (default 7 AM). Texts still go only to
   `SMS_TEST_RECIPIENT` until customer sending is enabled.
5. **Reopen** unlocks the truck and cancels pending morning texts.

### Temporary voice window confirmations

Each assigned stop has **Call test confirmation**. It places an immediate
voice call only to `SMS_TEST_RECIPIENT`—never the work order's customer number
in the current test mode—and says the stop's configured arrival window. The
callee presses **1** (or says “yes”) to confirm, or **2** (or says “no”) to
decline. The call delivery state, answer, and captured keypad/speech detail
are stored in `voiceConfirmations` and shown directly on the dispatch stop.

This is a manual dispatcher action; it does not place automatic customer calls.
Before moving out of test mode, obtain the appropriate customer-call consent,
use the work order's verified phone number only, and review the voice script.

Frontend optional vars (`.env.local`):

```env
VITE_DISPATCH_ORIGIN_ADDRESS=216 Berlin Lane, Berlin, CT
VITE_DISPATCH_MORNING_HOUR=7
VITE_GOOGLE_MAPS_API_KEY=...
```

`VITE_GOOGLE_MAPS_API_KEY` enables distance ordering from the depot.

## Current limitations

- Image-only/scanned PDFs require OCR; text PDFs are supported now.
- CSV export is compatible with Google Sheets but does not write directly into a
  Google Sheet.
- Functions must be deployed before AI extraction and SMS scheduling work.
- Firebase Authentication/App Check and production Firestore security rules
  should be added before exposing the application broadly.
