# How to Get OAuth Credentials for Gmail API

## Step-by-Step Guide

### Step 1: Go to Google Cloud Console

1. Open your browser and go to: https://console.cloud.google.com/
2. Make sure you're signed in with the account that owns your Firebase project
3. Select your project: **njplu-94cdd** (or your Firebase project name)

### Step 2: Enable Gmail API (If Not Already Enabled)

1. In the left sidebar, click **"APIs & Services"** > **"Library"**
2. Search for **"Gmail API"**
3. Click on **"Gmail API"**
4. Click the **"Enable"** button
5. Wait for it to enable (usually takes a few seconds)

**OR** use the direct link:
https://console.cloud.google.com/apis/library/gmail.googleapis.com

### Step 3: Create OAuth Consent Screen

**First time only - you need to configure the consent screen:**

1. Go to **"APIs & Services"** > **"OAuth consent screen"**
2. Choose **"External"** (unless you have Google Workspace)
3. Click **"Create"**
4. Fill in the required fields:
   - **App name:** `NJ Plumbing Scheduling` (or any name)
   - **User support email:** Your email
   - **Developer contact information:** Your email
5. Click **"Save and Continue"**
6. On **"Scopes"** page, click **"Add or Remove Scopes"**
   - Search for and add:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.modify`
   - Click **"Update"**
   - Click **"Save and Continue"**
7. On **"Test users"** page (if shown):
   - Click **"+ Add Users"**
   - Add `thecirclehelp@gmail.com` (this is REQUIRED!)
   - Click **"Add"**
   - Click **"Save and Continue"**
8. Review and click **"Back to Dashboard"**

**⚠️ IMPORTANT:** If you get "access_denied" error later, you need to add `thecirclehelp@gmail.com` as a test user. See `ADD_TEST_USER.md` for how to add it after setup.

### Step 4: Create OAuth Credentials

1. Go to **"APIs & Services"** > **"Credentials"**
2. Click **"+ Create Credentials"** at the top
3. Select **"OAuth client ID"**
4. If prompted, choose **"Web application"** as the application type
5. Fill in the form:
   - **Name:** `Gmail API Client` (or any name)
   - **Authorized redirect URIs:** Click **"+ Add URI"**
     - Add: `http://localhost`
     - Click **"Add"** again and add: `http://localhost:3000` (optional)
6. Click **"Create"**
7. **IMPORTANT:** A popup window will appear immediately with your credentials:
   ```
   ┌─────────────────────────────────────┐
   │ OAuth client created                │
   │                                     │
   │ Your Client ID                      │
   │ 123456789-abc...                   │ ← COPY THIS NOW!
   │                                     │
   │ Your Client Secret                  │
   │ GOCSPX-abc...                      │ ← COPY THIS NOW!
   │                                     │
   │              [OK]                   │
   └─────────────────────────────────────┘
   ```
   - **Copy both values BEFORE clicking OK!**
   - Once you click OK, you won't see the Client Secret again easily
8. Click **"OK"** (after copying both values)

**If you already clicked OK:** See `FIND_OAUTH_CREDENTIALS.md` for how to find them again!

### Step 5: Save Your Credentials

**Save these somewhere safe:**
- ✅ **Client ID:** `YOUR_CLIENT_ID`
- ✅ **Client Secret:** `YOUR_CLIENT_SECRET`

You'll need these in the next step when getting the refresh token.

## What You Have Now

✅ OAuth Client ID  
✅ OAuth Client Secret  
✅ Gmail API Enabled  

## Next Step

Now you need to get a **Refresh Token** by authorizing `thecirclehelp@gmail.com`. See `GET_REFRESH_TOKEN.md` for instructions.

## Troubleshooting

### "OAuth consent screen not configured"
- Make sure you completed Step 3 above
- You must configure the consent screen before creating credentials

### "Redirect URI mismatch"
- Make sure you added `http://localhost` exactly as shown
- No trailing slashes

### Can't find "Create Credentials"
- Make sure you're in the correct project (`njplu-94cdd`)
- Check that you're in **"APIs & Services"** > **"Credentials"**

### Credentials not showing
- Refresh the page
- Check you're in the right project
- Look in the "OAuth 2.0 Client IDs" section

## Quick Links

- **Google Cloud Console:** https://console.cloud.google.com/
- **APIs & Services:** https://console.cloud.google.com/apis/credentials
- **OAuth Consent Screen:** https://console.cloud.google.com/apis/credentials/consent
- **Gmail API:** https://console.cloud.google.com/apis/library/gmail.googleapis.com

