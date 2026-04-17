# Gmail Account Setup Explained

## Quick Answer

✅ **Enable Gmail API** on your Firebase/Google Cloud project  
✅ **Use ANY Gmail account** you want - doesn't have to match your Firebase account!

## How It Works

### Step 1: Enable API (On Firebase Project)
- Gmail API is enabled on your **Firebase project's Google Cloud account**
- This is like "turning on the feature" for your project
- Project: `njplu-94cdd` (your Firebase project)

### Step 2: Create OAuth Credentials (On Firebase Project)
- OAuth credentials are created in your **Firebase project**
- These credentials allow your Firebase Functions to access Gmail
- They're tied to your project, not a specific Gmail account

### Step 3: Authorize a Gmail Account (Any Gmail!)
- You authorize **any Gmail account** you want to use
- This can be:
  - `schedule@yourdomain.com` (if you have Google Workspace)
  - `yourname@gmail.com` (personal Gmail)
  - `business@gmail.com` (any Gmail account)
- This gives your Firebase Functions permission to read that specific Gmail inbox

### Step 4: Configure Functions
- Set `gmail.email` to the Gmail account you authorized
- Functions will check that inbox every 30 seconds

## Example Setup

**Firebase Project:** `njplu-94cdd` (your account)  
**Gmail to Check:** `schedule@yourdomain.com` (different account)

This works perfectly! The Gmail API is enabled on your Firebase project, but you're checking a different Gmail account.

## Common Scenarios

### Your Setup
- Enable API on Firebase project (`njplu-94cdd`)
- Authorize `thecirclehelp@gmail.com`
- Set `gmail.email="thecirclehelp@gmail.com"`

### Other Examples
- Personal Gmail: `you@gmail.com`
- Business Email: `schedule@yourdomain.com`
- Separate Account: `njplumbing.schedule@gmail.com`

## Important Notes

1. **OAuth Credentials** = Tied to your Firebase project
2. **Gmail Account** = Can be any Gmail account you authorize
3. **Refresh Token** = Specific to the Gmail account you authorize
4. **Email Address** = The inbox that gets checked

## Security

- The OAuth credentials are stored securely in Firebase Functions config
- Only the Gmail account you authorize can be accessed
- You can revoke access anytime by removing the refresh token

## Summary

**Enable API on Firebase project → Authorize any Gmail account → Use that Gmail!**

The Gmail account doesn't need to match your Firebase account at all!

