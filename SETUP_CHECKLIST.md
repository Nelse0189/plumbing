# Complete Setup Checklist

Follow this checklist to get your voice email to schedule system fully working.

## ✅ What's Already Built

- ✅ Gmail checking function (checks every 30 seconds)
- ✅ Transcription extraction from email body/text attachments
- ✅ AI appointment extraction (Gemini AI)
- ✅ Automatic schedule creation
- ✅ Morning confirmation texts (8 AM on appointment day)
- ✅ 1-hour reminder texts

**Note:** The system extracts transcriptions directly from email body or text attachments - no audio transcription needed!

## 📋 Setup Steps

### 1. Twilio API Setup (For SMS)

**Get Twilio Account:**
1. Sign up at https://www.twilio.com (free trial available)
2. Get your Account SID and Auth Token from dashboard
3. Get a phone number (or use trial number)

**Set Firebase Config:**
```bash
firebase functions:config:set \
  twilio.account_sid="YOUR_ACCOUNT_SID" \
  twilio.auth_token="YOUR_AUTH_TOKEN" \
  twilio.phone_number="+1234567890"
```

### 2. Gmail API Setup (For Email Checking)

**Enable Gmail API:**
```bash
gcloud services enable gmail.googleapis.com
```

**Create OAuth Credentials:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. APIs & Services > Credentials
3. Create OAuth 2.0 Client ID
4. Application type: Web application
5. Authorized redirect URI: `http://localhost`
6. Save Client ID and Client Secret

**Get Refresh Token:**
- See `GMAIL_SETUP.md` for detailed instructions
- Or use [OAuth Playground](https://developers.google.com/oauthplayground/)
  - Select Gmail API v1 scopes:
    - `https://www.googleapis.com/auth/gmail.readonly`
    - `https://www.googleapis.com/auth/gmail.modify`

**Set Firebase Config:**
```bash
firebase functions:config:set \
  gmail.email="thecirclehelp@gmail.com" \
  gmail.client_id="YOUR_CLIENT_ID" \
  gmail.client_secret="YOUR_CLIENT_SECRET" \
  gmail.refresh_token="YOUR_REFRESH_TOKEN"
```

### 3. Gemini AI Setup (For Appointment Extraction)

**Get Gemini API Key:**
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create API key
3. Copy the key

**Set Firebase Config:**
```bash
firebase functions:config:set \
  gemini.api_key="YOUR_GEMINI_API_KEY"
```

### 4. Google Cloud Speech-to-Text Setup (Optional)

**Note:** If emails already contain transcriptions (which is your case), you don't need this!

Only enable if you want to support audio file transcription as a fallback:
```bash
gcloud services enable speech.googleapis.com
```

### 5. Deploy Functions

```bash
cd functions
npm install
npm run build
firebase deploy --only functions
```

This deploys:
- `checkGmailForVoiceEmails` - Checks Gmail every 30 seconds
- `sendMorningConfirmations` - Sends confirmation texts at 8 AM
- `sendReminders` - Sends 1-hour reminder texts
- `checkGmailNow` - Manual trigger (optional)

### 6. Test the System

1. **Send a test email:**
   - To: `thecirclehelp@gmail.com`
   - Subject: Test Appointment
   - Body: Include the transcription text:
     > "Hi, this is John Smith. I need an appointment at 123 Main Street, New York, NY 10001. Can we do it tomorrow at 2 PM? My phone is 555-1234."
   
   **OR** attach a .txt file with the transcription

2. **Wait up to 30 seconds** (or call `checkGmailNow` manually)

3. **Check Firestore:**
   - `emailRequests` collection - should show processing/success
   - `schedules` collection - should show new appointment
   - `morningConfirmations` collection - should show pending confirmation

4. **Check your schedule** - appointment should appear!

5. **Wait until 8 AM** - customer should receive confirmation text

## 📧 How Clients Use It

**Simple Instructions for Clients:**
1. Record a voice message with:
   - Your name
   - Full address
   - Preferred date and time
   - Phone number (optional but recommended)
2. Email the transcription to: `thecirclehelp@gmail.com`
3. That's it! You'll receive:
   - Confirmation text the morning of your appointment
   - Reminder text 1 hour before

## 🔍 Monitoring

**Check Logs:**
```bash
firebase functions:log
```

**Check Firestore Collections:**
- `emailRequests` - All email processing attempts
- `schedules` - All appointments
- `morningConfirmations` - Morning texts to send
- `reminders` - 1-hour reminders to send

## 🐛 Troubleshooting

### "Gmail credentials not configured"
- Make sure all 4 Gmail config values are set
- Redeploy after setting config

### "No transcription found in email"
- Make sure email body contains the transcription text
- Or attach a .txt file with the transcription
- Check that email is not empty

### "Could not transcribe audio" (if using audio fallback)
- Check Speech-to-Text API is enabled
- Verify audio file is not corrupted
- Check audio is clear and in English/Spanish

### "Missing required fields"
- AI couldn't extract name or address
- Make sure voice recording is clear
- Speak slowly and include full address

### Texts not sending
- Check Twilio credentials are correct
- Verify phone number format (+1234567890)
- Check Twilio account has credits

## 📊 Cost Estimate

**Free Tier Usage:**
- Gmail checks: ~86,400/month (4% of limit) ✅ FREE
- Function invocations: ~86,400/month (4% of limit) ✅ FREE
- Compute time: ~44,000 GB-seconds (11% of limit) ✅ FREE

**Paid Services:**
- Twilio: ~$0.0075 per SMS (first 100 free on trial)
- Google Cloud Speech-to-Text: $0.006 per 15 seconds (only if using audio transcription)
- Gemini AI: Free tier available

**Estimated Monthly Cost:** $3-15 depending on volume (lower since no transcription needed!)

## ✅ Verification Checklist

- [ ] Twilio credentials configured
- [ ] Gmail API enabled and credentials set
- [ ] Gemini API key configured
- [ ] Speech-to-Text API enabled
- [ ] Functions deployed successfully
- [ ] Test email sent and processed
- [ ] Appointment appears in schedule
- [ ] Morning confirmation text received (at 8 AM)
- [ ] 1-hour reminder text received

## 🎉 You're Done!

Once all steps are complete, your system will:
1. ✅ Check Gmail every 30 seconds for emails with transcriptions
2. ✅ Extract transcription from email body or text attachments
3. ✅ Extract appointment details using AI
4. ✅ Create appointments in your schedule
5. ✅ Send confirmation text at 8 AM on appointment day
6. ✅ Send reminder text 1 hour before appointment

