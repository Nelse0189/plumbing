# Fix Redirect URI Mismatch Error

## The Problem

OAuth Playground uses `https://developers.google.com/oauthplayground` as its redirect URI, but your OAuth client doesn't have this authorized.

## Solution: Add OAuth Playground Redirect URI

### Step 1: Go to Google Cloud Console

1. Go to: https://console.cloud.google.com/apis/credentials
2. Make sure you're in project: **njplu-94cdd**

### Step 2: Edit Your OAuth Client

1. Find your OAuth client in the **"OAuth 2.0 Client IDs"** section
2. Click on it (or click the **pencil/edit icon** ✏️)

### Step 3: Add OAuth Playground Redirect URI

**IMPORTANT:** Make sure you're adding it to **"Authorized redirect URIs"** NOT "Authorized JavaScript origins"!

1. Scroll down to find **"Authorized redirect URIs"** section
   - This is DIFFERENT from "Authorized JavaScript origins" (which is above it)
   - Redirect URIs CAN have paths (like `/oauthplayground`)
   - JavaScript origins CANNOT have paths
2. Click **"+ Add URI"** (in the Redirect URIs section)
3. Add this exact URI:
   ```
   https://developers.google.com/oauthplayground
   ```
4. Click **"Add"**
5. You should now have:
   - `http://localhost` (if you added it before)
   - `https://developers.google.com/oauthplayground` (newly added)
6. Click **"Save"** at the bottom

**If you see "Invalid Origin" error:** You're in the wrong section! Look for "Authorized redirect URIs" (lower on the page), not "Authorized JavaScript origins".

### Step 4: Try OAuth Playground Again

1. Go back to: https://developers.google.com/oauthplayground/
2. Click the gear icon ⚙️
3. Make sure "Use your own OAuth credentials" is checked
4. Enter your Client ID and Client Secret
5. Click "Close"
6. Select Gmail scopes and click "Authorize APIs"
7. It should work now! ✅

## Alternative: Use Your Own Redirect URI

If you prefer not to use OAuth Playground's redirect URI, you can:

1. Keep only `http://localhost` in authorized redirect URIs
2. Use the script method instead (see `GET_REFRESH_TOKEN.md` Method 2)

## Quick Fix Checklist

- [ ] Go to Google Cloud Console Credentials page
- [ ] Click on your OAuth client
- [ ] Add `https://developers.google.com/oauthplayground` to Authorized redirect URIs
- [ ] Click Save
- [ ] Try OAuth Playground again

## Visual Guide

```
Google Cloud Console
├── APIs & Services
    └── Credentials
        └── OAuth 2.0 Client IDs
            └── [Your Client] ← Click here
                └── Authorized redirect URIs
                    ├── http://localhost
                    └── + Add URI ← Click here
                        └── Enter: https://developers.google.com/oauthplayground
                            └── Save
```

## Still Having Issues?

- Make sure you're editing the correct OAuth client
- Check that the URI is exactly: `https://developers.google.com/oauthplayground` (no trailing slash)
- Wait a few seconds after saving before trying again
- Try clearing browser cache

