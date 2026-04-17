# Quick Configuration Reference

## Your Gmail Account
**Email to check:** `thecirclehelp@gmail.com`

## Firebase Config Commands

Once you have all your credentials, run:

```bash
firebase functions:config:set \
  gmail.email="thecirclehelp@gmail.com" \
  gmail.client_id="YOUR_CLIENT_ID" \
  gmail.client_secret="YOUR_CLIENT_SECRET" \
  gmail.refresh_token="YOUR_REFRESH_TOKEN" \
  gemini.api_key="YOUR_GEMINI_API_KEY" \
  twilio.account_sid="YOUR_TWILIO_ACCOUNT_SID" \
  twilio.auth_token="YOUR_TWILIO_AUTH_TOKEN" \
  twilio.phone_number="+1234567890"
```

## Test Email

Send test emails to: **thecirclehelp@gmail.com**

## What Gets Checked

The system checks `thecirclehelp@gmail.com` every 30 seconds for:
- New unread emails
- Emails with transcriptions in the body
- Emails with .txt attachments containing transcriptions


