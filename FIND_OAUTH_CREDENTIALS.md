# Where to Find Your Client ID and Client Secret

## After Creating OAuth Credentials

### Step 1: Create the Credentials (If You Haven't Already)

1. Go to: https://console.cloud.google.com/apis/credentials
2. Click **"+ Create Credentials"** > **"OAuth client ID"**
3. Fill in the form and click **"Create"**

### Step 2: The Popup Window

**Right after clicking "Create", a popup window will appear** with your credentials:

```
OAuth client created

Your Client ID
123456789-abcdefghijklmnop.apps.googleusercontent.com

Your Client Secret
GOCSPX-abcdefghijklmnopqrstuvwxyz

[OK]
```

**⚠️ IMPORTANT:** Copy these NOW! Once you click "OK", you won't see the Client Secret again!

### Step 3: If You Already Clicked "OK" (Don't Panic!)

If you already closed the popup, you can still find them:

1. Go to: https://console.cloud.google.com/apis/credentials
2. Look for the **"OAuth 2.0 Client IDs"** section
3. You'll see a list of your OAuth clients
4. Find the one you just created (it might be named "Gmail API Client" or "Web client 1")
5. Click on it (or click the **pencil/edit icon** ✏️)
6. You'll see:
   - **Client ID:** Visible in the details page
   - **Client Secret:** Click **"Show"** next to "Client secret" to reveal it

## Visual Guide

### Location 1: Popup After Creation
```
┌─────────────────────────────────────┐
│ OAuth client created                │
│                                     │
│ Your Client ID                      │
│ 123456789-abc...                   │ ← COPY THIS
│                                     │
│ Your Client Secret                  │
│ GOCSPX-abc...                      │ ← COPY THIS
│                                     │
│              [OK]                   │
└─────────────────────────────────────┘
```

### Location 2: Credentials Page (If You Missed the Popup)
```
Google Cloud Console
├── APIs & Services
    └── Credentials
        └── OAuth 2.0 Client IDs
            └── [Your Client Name] ← Click here
                ├── Client ID: 123456789-abc... ← Visible
                └── Client secret: [Show] ← Click to reveal
```

## Step-by-Step: Finding Them Now

1. **Go to:** https://console.cloud.google.com/apis/credentials
2. **Scroll down** to find **"OAuth 2.0 Client IDs"** section
3. **Click on your OAuth client** (the one you created)
4. **You'll see:**
   - Client ID: `123456789-abcdefg.apps.googleusercontent.com` ← Copy this
   - Client secret: `[Show]` ← Click this button to reveal
   - Copy the secret once it's shown

## What They Look Like

**Client ID:**
- Format: `123456789-abcdefghijklmnop.apps.googleusercontent.com`
- Usually 50-60 characters
- Always ends with `.apps.googleusercontent.com`

**Client Secret:**
- Format: `GOCSPX-abcdefghijklmnopqrstuvwxyz`
- Usually 30-40 characters
- Always starts with `GOCSPX-`

## Quick Links

- **Credentials Page:** https://console.cloud.google.com/apis/credentials
- **Direct Link:** Just go there and look for "OAuth 2.0 Client IDs"

## Troubleshooting

### "I don't see OAuth 2.0 Client IDs section"
- Make sure you're in the correct project (`njplu-94cdd`)
- Check that you've created at least one OAuth client
- Try refreshing the page

### "I can't see the Client Secret"
- Click the **"Show"** button next to "Client secret"
- If it says "Reset", you'll need to reset it (old one won't work)

### "I see multiple OAuth clients"
- Look for the one you just created
- Check the name or creation date
- You can click on any of them to see their credentials

## Save Them Safely

Once you have both:
- ✅ **Client ID:** `YOUR_CLIENT_ID`
- ✅ **Client Secret:** `YOUR_CLIENT_SECRET`

Save them in a secure place - you'll need them for the next step!


