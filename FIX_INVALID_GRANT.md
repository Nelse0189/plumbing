# Fix: Invalid Grant Error (Refresh Token Expired)

## The Problem

The error `invalid_grant` means your Gmail refresh token has expired or been revoked. This can happen if:
- You revoked access in your Google Account settings
- The token was invalidated
- Too much time passed (rare, but possible)

## Solution: Get a New Refresh Token

### Step 1: Go to OAuth Playground

1. Go to: https://developers.google.com/oauthplayground/
2. Click the **gear icon** ⚙️ (top right)
3. Check **"Use your own OAuth credentials"**
4. Enter your **OAuth Client ID** and **OAuth Client secret** from Google Cloud Console (APIs & Services → Credentials).
5. Click **"Close"**

### Step 2: Authorize Again

1. In the left sidebar, find **"Gmail API v1"**
2. Check these boxes:
   - ✅ `https://www.googleapis.com/auth/gmail.readonly`
   - ✅ `https://www.googleapis.com/auth/gmail.modify`
3. Click **"Authorize APIs"**
4. **Sign in with:** `thecirclehelp@gmail.com`
5. Click **"Allow"** or **"Continue"**

### Step 3: Exchange for New Refresh Token

1. Click **"Exchange authorization code for tokens"**
2. Copy the **Refresh Token** (starts with `1//0g...`)

### Step 4: Update Firebase Config

Run this command with your NEW refresh token:

```bash
firebase functions:config:set \
  gmail.refresh_token="YOUR_NEW_REFRESH_TOKEN_HERE"
```

Then redeploy:

```bash
cd functions
npm run build
firebase deploy --only functions:checkGmailForVoiceEmails
```

## Quick Fix Command

Once you have the new refresh token, replace `YOUR_NEW_REFRESH_TOKEN_HERE`:

```bash
firebase functions:config:set gmail.refresh_token="YOUR_NEW_REFRESH_TOKEN_HERE"
```

## Why This Happens

Refresh tokens can expire if:
- Access is revoked in Google Account settings
- The OAuth app is deleted/recreated
- Security settings change

## Prevention

- Don't revoke access in Google Account settings
- Keep your OAuth credentials secure
- If you need to revoke, you'll need to get a new token

## Verify It's Working

After updating, check the logs:

```bash
firebase functions:log --only checkGmailForVoiceEmails
```

You should see successful Gmail API calls instead of errors.


