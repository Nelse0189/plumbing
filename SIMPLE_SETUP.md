# Simple Setup - Gmail Only (No SendGrid!)

You don't need SendGrid or Mailgun. Just use Gmail directly!

## Quick Start

1. **Enable Gmail API**
   ```bash
   gcloud services enable gmail.googleapis.com
   ```

2. **Get OAuth Credentials**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - APIs & Services > Credentials
   - Create OAuth 2.0 Client ID
   - Save Client ID and Client Secret

3. **Get Refresh Token** (one-time)
   - Use the script in `GMAIL_SETUP.md` to authorize and get refresh token
   - Or use [this online tool](https://developers.google.com/oauthplayground/)

4. **Set Config**
   ```bash
   firebase functions:config:set \
     gmail.email="your-email@gmail.com" \
     gmail.client_id="YOUR_CLIENT_ID" \
     gmail.client_secret="YOUR_CLIENT_SECRET" \
     gmail.refresh_token="YOUR_REFRESH_TOKEN"
   ```

5. **Deploy**
   ```bash
   cd functions
   npm install
   npm run build
   firebase deploy --only functions:checkGmailForVoiceEmails
   ```

## That's It!

Now clients can:
- Send emails with voice recordings to your Gmail address
- The system checks every 5 minutes automatically
- Appointments are created automatically

No webhooks, no SendGrid, no Mailgun - just Gmail!

## Manual Check

Want to check immediately? Call:
```
https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/checkGmailNow
```

See `GMAIL_SETUP.md` for detailed instructions.


