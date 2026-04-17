# Gmail Setup - No SendGrid Needed!

This setup uses Gmail API directly - completely free, no third-party services required!

## How It Works

1. **Function checks Gmail every 5 minutes** for new emails with attachments
2. **Downloads any audio files** from those emails
3. **Transcribes and processes** them automatically
4. **Creates appointments** in your schedule

## Setup Steps

### 1. Enable Gmail API (On Your Firebase/Google Cloud Project)

**Important:** You enable the Gmail API on your Firebase project's Google Cloud account, but you can use ANY Gmail account!

```bash
# Enable Gmail API in Google Cloud Console
gcloud services enable gmail.googleapis.com
```

Or go to: https://console.cloud.google.com/apis/library/gmail.googleapis.com

**Note:** This enables the API for your Firebase project. You'll then authorize a different Gmail account (like `schedule@yourdomain.com` or `yourname@gmail.com`) to use it.

### 2. Create OAuth Credentials (On Your Firebase Project)

**See `GET_OAUTH_CREDENTIALS.md` for detailed step-by-step instructions!**

Quick version:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your Firebase project (`njplu-94cdd`)
3. Enable **OAuth Consent Screen** (first time only):
   - Go to **APIs & Services** > **OAuth consent screen**
   - Choose **External**, fill in app name and email
   - Add scopes: `gmail.readonly` and `gmail.modify`
   - Add test user: `thecirclehelp@gmail.com`
4. Create **OAuth Client ID**:
   - Go to **APIs & Services** > **Credentials**
   - Click **Create Credentials** > **OAuth client ID**
   - Choose **Web application**
   - Add redirect URI: `http://localhost`
   - Save the **Client ID** and **Client Secret**

**Note:** These credentials are tied to your Firebase project, but they'll authorize access to ANY Gmail account you choose in step 3.

### 3. Get Refresh Token (For thecirclehelp@gmail.com)

**See `GET_REFRESH_TOKEN.md` for detailed step-by-step instructions!**

**Quick Method (Recommended):**
1. Go to: https://developers.google.com/oauthplayground/
2. Click gear icon ⚙️ → Check "Use your own OAuth credentials"
3. Enter your Client ID and Client Secret
4. Select Gmail API scopes: `gmail.readonly` and `gmail.modify`
5. Click "Authorize APIs"
6. **Sign in with:** `thecirclehelp@gmail.com`
7. Click "Exchange authorization code for tokens"
8. Copy the **Refresh Token** (starts with `1//0g...`)

**Alternative:** Use the script method - see `GET_REFRESH_TOKEN.md` for details.

```bash
# Install dependencies
npm install googleapis readline

# Run the auth script (create this file)
```

Create `functions/get-gmail-token.js`:

```javascript
const { google } = require('googleapis');
const readline = require('readline');

const oauth2Client = new google.auth.OAuth2(
  'YOUR_CLIENT_ID',
  'YOUR_CLIENT_SECRET',
  'http://localhost'
);

const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

const url = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
});

console.log('Visit this URL:', url);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Enter the code from that page: ', (code) => {
  oauth2Client.getToken(code, (err, token) => {
    if (err) return console.error('Error retrieving access token', err);
    console.log('Refresh Token:', token.refresh_token);
    console.log('Access Token:', token.access_token);
    rl.close();
  });
});
```

Run it:
```bash
node functions/get-gmail-token.js
```

Copy the **Refresh Token** - you'll need it!

### 4. Set Environment Variables

Set these in Firebase Functions. **Use the Gmail address you authorized in step 3:**

```bash
firebase functions:config:set \
  gmail.email="thecirclehelp@gmail.com" \
  gmail.client_id="YOUR_CLIENT_ID" \
  gmail.client_secret="YOUR_CLIENT_SECRET" \
  gmail.refresh_token="YOUR_REFRESH_TOKEN"
```

**Important:** 
- `gmail.email` = The Gmail account you want to check (can be different from your Firebase account)
- `gmail.client_id` and `gmail.client_secret` = From your Firebase project (step 2)
- `gmail.refresh_token` = From authorizing that Gmail account (step 3)

Or set them in `.env` for local development:

```env
GMAIL_EMAIL=your-email@gmail.com
GMAIL_CLIENT_ID=your_client_id
GMAIL_CLIENT_SECRET=your_client_secret
GMAIL_REFRESH_TOKEN=your_refresh_token
```

### 5. Deploy Functions

```bash
cd functions
npm install
npm run build
firebase deploy --only functions:checkGmailForVoiceEmails,functions:checkGmailNow
```

## Usage

### Automatic (Recommended)

The function `checkGmailForVoiceEmails` runs automatically every 5 minutes and checks for new emails.

### Manual Check

Call this URL to check immediately:
```
https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/checkGmailNow
```

## How Clients Use It

Clients just send an email to your Gmail address (e.g., `schedule@yourdomain.com` or `yourname@gmail.com`) with a voice recording attached. That's it!

The system will:
1. Check every 5 minutes for new emails
2. Find emails with audio attachments
3. Process them automatically
4. Create appointments

## Email Address

You can use:
- Your existing Gmail address
- A Gmail alias (e.g., `yourname+schedule@gmail.com`)
- A custom domain email that forwards to Gmail

## Testing

1. Send yourself an email with a voice recording attached
2. Wait up to 5 minutes (or call `checkGmailNow` manually)
3. Check Firestore `emailRequests` collection
4. Check your schedule - the appointment should appear!

## Troubleshooting

### "Gmail credentials not configured"
- Make sure you set all 4 environment variables
- Redeploy after setting config

### "No emails found"
- Check the email address matches exactly
- Make sure emails are unread
- Check that emails have attachments

### "Error retrieving access token"
- Refresh token may have expired
- Re-run the auth script to get a new token

### Check logs
```bash
firebase functions:log --only checkGmailForVoiceEmails
```

## Advantages Over SendGrid/Mailgun

✅ **Free** - No monthly fees  
✅ **Simple** - Uses your existing Gmail  
✅ **No domain setup** - Works with any Gmail address  
✅ **Reliable** - Google's infrastructure  
✅ **Secure** - OAuth 2.0 authentication  

## Security Note

The refresh token gives access to read your Gmail. Keep it secure:
- Don't commit it to git
- Use Firebase Functions config (encrypted)
- Rotate it if compromised

