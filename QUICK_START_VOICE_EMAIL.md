# Quick Start: Voice Email to Schedule

## What Was Built

✅ **Email Webhook Function** (`processVoiceEmail`)
- Receives emails with voice attachments
- Supports SendGrid, Mailgun, and raw email formats

✅ **Voice Transcription**
- Uses Google Cloud Speech-to-Text
- Supports MP3, WAV, OGG, M4A, WebM formats
- Handles English and Spanish

✅ **AI Appointment Extraction**
- Uses Gemini AI to extract:
  - Customer name
  - Address
  - Phone number
  - Date & time
  - Notes
  - Truck assignment

✅ **Automatic Schedule Creation**
- Creates appointments in your schedule system
- Assigns to appropriate truck
- Stores in Firestore

## Next Steps

### 1. Install Dependencies
```bash
cd functions
npm install
```

### 2. Enable Google Cloud Speech-to-Text API
```bash
gcloud services enable speech.googleapis.com
```

### 3. Deploy the Function
```bash
npm run build
firebase deploy --only functions:processVoiceEmail
```

### 4. Set Up Email Forwarding

**Option A: SendGrid (Easiest)**
1. Sign up at sendgrid.com
2. Go to Settings > Inbound Parse
3. Add host with URL: `https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/processVoiceEmail`
4. Create email like `schedule@yourdomain.com` and forward to SendGrid

**Option B: Mailgun**
1. Sign up at mailgun.com
2. Create route forwarding to your function URL
3. Use `schedule@yourdomain.com` as the email

### 5. Test It!

Send an email to your configured address with a voice recording saying:
> "Hi, this is John Smith. I need an appointment at 123 Main Street, New York, NY 10001. Can we do it on March 15th around 2 PM? My phone is 555-1234. Thanks!"

The appointment will appear automatically in your schedule!

## Function URL

After deployment, your function URL will be:
```
https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/processVoiceEmail
```

Find your region and project ID:
```bash
firebase projects:list
```

## Monitoring

Check Firestore collections:
- `emailRequests` - All email processing attempts
- `schedules` - Created appointments

View logs:
```bash
firebase functions:log --only processVoiceEmail
```

## Example Voice Message

Tell your clients to say:
- Their name
- Full address (street, city, state, zip)
- Preferred date
- Preferred time
- Phone number (optional)
- Any special notes

Example: "Hi, I'm Sarah Johnson. I need service at 456 Oak Avenue, Los Angeles, CA 90001. Can we schedule for next Tuesday at 10 AM? My number is 310-555-9876. The water heater is making strange noises."



