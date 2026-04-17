# .env File Setup Guide

Using a `.env` file is easier than Firebase Functions config! Here's how to set it up.

## Step 1: Create .env File

Create a file called `.env` in the `functions/` directory:

```bash
cd functions
touch .env
```

Or create it manually: `functions/.env`

## Step 2: Add Your Credentials

Open `functions/.env` and add:

```env
# Gmail Configuration
GMAIL_EMAIL=your-inbox@gmail.com
GMAIL_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=YOUR_CLIENT_SECRET
GMAIL_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
GMAIL_REDIRECT_URI=http://localhost

# Gemini AI Configuration
GEMINI_API_KEY=YOUR_GEMINI_API_KEY

# Twilio Configuration
TWILIO_ACCOUNT_SID=YOUR_TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN=YOUR_TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER=+15555551212
```

**Important:** Replace `YOUR_NEW_REFRESH_TOKEN_HERE` with your actual refresh token from OAuth Playground!

## Step 3: For Production Deployment

For Firebase Functions deployment, you need to set environment variables:

```bash
firebase functions:secrets:set GMAIL_EMAIL
firebase functions:secrets:set GMAIL_CLIENT_ID
firebase functions:secrets:set GMAIL_CLIENT_SECRET
firebase functions:secrets:set GMAIL_REFRESH_TOKEN
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_PHONE_NUMBER
```

**OR** use the simpler approach - Firebase Functions will automatically use environment variables if set!

## How It Works

- **Local development:** Uses `.env` file (via dotenv)
- **Production:** Uses Firebase environment variables or functions.config() as fallback
- **Priority:** Environment variables > Firebase config

## Benefits

✅ Easier to manage - edit one file  
✅ No need for `firebase functions:config:set`  
✅ Works with modern Firebase Functions  
✅ `.env` is already in `.gitignore` (secure)

## Update Refresh Token

When you get a new refresh token, just update the `.env` file:

```env
GMAIL_REFRESH_TOKEN=your-new-refresh-token-here
```

Then redeploy:

```bash
cd functions
npm run build
firebase deploy --only functions
```

## Verify

Check that your `.env` file exists:

```bash
ls -la functions/.env
```

You should see the file listed (it's hidden, so starts with `.`)


