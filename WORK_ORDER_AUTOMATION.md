# Teams Work Order Automation

This workflow turns PDF work orders attached to Microsoft Teams channel messages
into reviewed unscheduled jobs, SMS-assisted schedule entries, and CSV records
that can be opened in Google Sheets.

## Workflow

1. Open `teams-test.html`, sign in to Microsoft, and choose a team/channel.
2. Select **Process work order** on a PDF attachment.
3. The PDF is downloaded from the team's SharePoint drive and its text is
   extracted locally in the browser.
4. The text—not the PDF file—is sent to the `extractWorkOrder` Firebase callable
   function. OpenAI returns structured fields.
5. A staff member verifies the work-order number, customer, phone, address, job
   type, date, and time.
6. **Save to unscheduled jobs** stores the reviewed record without contacting
   anyone.
7. **Schedule by text** sends available times only to `SMS_TEST_RECIPIENT`.
8. A reply selecting a valid time moves the work order into the scheduled
   database and truck schedule.
9. **Export CSV for Google Sheets** downloads all reviewed rows in a
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
OPENAI_MODEL=gpt-5-mini
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

## Current limitations

- Image-only/scanned PDFs require OCR; text PDFs are supported now.
- CSV export is compatible with Google Sheets but does not write directly into a
  Google Sheet.
- Functions must be deployed before AI extraction and SMS scheduling work.
- Firebase Authentication/App Check and production Firestore security rules
  should be added before exposing the application broadly.
