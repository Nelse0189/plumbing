# Voice Email to Schedule Setup Guide

This feature allows clients to send voice recordings via email, which are automatically transcribed and converted into schedule appointments.

## How It Works

1. **Client sends email** with voice attachment to your Gmail address
2. **Gmail API** checks every 5 minutes for new emails with attachments
3. **Downloads audio files** from those emails
4. **Google Cloud Speech-to-Text** transcribes the voice recording
5. **Gemini AI** extracts appointment details (name, address, date, time, etc.)
6. **Schedule is automatically created** in your system

## Setup Instructions

### Option 1: Using Gmail API Directly (Recommended - FREE, No SendGrid!)

1. **Create a SendGrid account** (free tier available)
   - Sign up at https://sendgrid.com

2. **Set up Inbound Parse**
   - Go to Settings > Inbound Parse
   - Click "Add Host & URL"
   - Enter your domain or use a subdomain
   - Set the destination URL to:
     ```
     https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/processVoiceEmail
     ```
   - Example: `https://us-central1-njplu-94cdd.cloudfunctions.net/processVoiceEmail`
   - Check "POST the raw, full MIME message"
   - Save

3. **Create a forwarding email address**
   - Set up an email like `schedule@yourdomain.com` or `voice@yourdomain.com`
   - Forward all emails to your SendGrid inbound parse address

4. **Deploy the function**
   ```bash
   cd functions
   npm install
   npm run build
   firebase deploy --only functions:processVoiceEmail
   ```

### Option 2: Using Webhook (SendGrid/Mailgun) - Optional

If you prefer webhook-based approach:

**SendGrid:**
1. Create account at https://sendgrid.com
2. Set up Inbound Parse pointing to `processVoiceEmail` function
3. Forward emails to SendGrid address

**Mailgun:**
1. Create account at https://www.mailgun.com
2. Set up route forwarding to `processVoiceEmail` function

**Note:** Gmail API approach (Option 1) is simpler and free - no third-party services needed!

## Required Environment Variables

Make sure these are set in Firebase Functions:

```bash
# Google Cloud Speech-to-Text (uses default credentials if running on GCP)
# No API key needed if deployed to Firebase Functions

# Gemini API Key (already configured)
firebase functions:config:set gemini.api_key="YOUR_GEMINI_API_KEY"
```

## Google Cloud Speech-to-Text Setup

1. **Enable the API**
   ```bash
   gcloud services enable speech.googleapis.com
   ```

2. **Set up authentication**
   - Firebase Functions automatically use the default service account
   - Ensure the service account has "Cloud Speech Client" role
   - Or set `GOOGLE_APPLICATION_CREDENTIALS` environment variable

## Testing

1. **Send a test email** with a voice recording:
   - To: `schedule@yourdomain.com` (or your configured email)
   - Subject: Any subject
   - Attach: A voice recording file (MP3, WAV, OGG, M4A, or WebM)
   - Body: Optional text

2. **Check Firebase Console**
   - Go to Firestore > `emailRequests` collection
   - You should see a new document with status "processing" or "success"

3. **Check your schedule**
   - The appointment should appear in your schedule for the extracted date
   - Check the `schedules` collection in Firestore

## Voice Recording Tips for Clients

Tell your clients to:
- Speak clearly and slowly
- Include: Name, Address, Preferred Date, Preferred Time
- Example: "Hi, this is John Smith. I need an appointment at 123 Main Street, New York, NY 10001. Can we do it on March 15th around 2 PM? Thanks!"

## Supported Audio Formats

- MP3
- WAV
- OGG
- M4A
- WebM

## Troubleshooting

### "No audio attachment found"
- Make sure the email contains an audio file attachment
- Check that the file extension is supported
- Verify the email webhook is receiving the email correctly

### "Could not transcribe audio"
- Check Google Cloud Speech-to-Text API is enabled
- Verify service account permissions
- Check audio file is not corrupted

### "Missing required fields"
- The AI couldn't extract customer name or address
- Make sure the voice recording is clear
- Try re-recording with clearer speech

### Check logs
```bash
firebase functions:log --only processVoiceEmail
```

## Monitoring

Monitor email processing in Firestore:
- Collection: `emailRequests`
- Fields: `status`, `transcription`, `appointmentData`, `error`

## Security

- The webhook endpoint is public - consider adding authentication
- Add a secret token check in the function
- Rate limiting recommended for production use


