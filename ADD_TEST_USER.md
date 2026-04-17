# Fix: Add Test User to OAuth Consent Screen

## The Problem

Your OAuth app is in "Testing" mode, which means only approved test users can access it. You need to add `thecirclehelp@gmail.com` as a test user.

## Solution: Add Test User

### Step 1: Go to OAuth Consent Screen

1. Go to: https://console.cloud.google.com/apis/credentials/consent
2. Make sure you're in project: **njplu-94cdd**

### Step 2: Add Test User

1. Scroll down to the **"Test users"** section
2. Click **"+ Add Users"** button
3. Enter the email: `thecirclehelp@gmail.com`
4. Click **"Add"**
5. You should now see `thecirclehelp@gmail.com` in the test users list
6. Click **"Save"** at the bottom (if there's a save button)

### Step 3: Try OAuth Playground Again

1. Go back to: https://developers.google.com/oauthplayground/
2. Try authorizing again
3. It should work now! ✅

## Alternative: If You Don't See "Test Users" Section

If your app is in "Production" mode or you don't see test users:

1. Go to OAuth consent screen: https://console.cloud.google.com/apis/credentials/consent
2. Check the **"Publishing status"** at the top
3. If it says "In production", you're good (no test users needed)
4. If it says "Testing", you need to add test users (follow steps above)

## Quick Checklist

- [ ] Go to OAuth consent screen
- [ ] Find "Test users" section
- [ ] Click "+ Add Users"
- [ ] Add: `thecirclehelp@gmail.com`
- [ ] Save
- [ ] Try OAuth Playground again

## Visual Guide

```
OAuth Consent Screen
├── App information
├── App domain
├── Authorized domains
├── Developer contact information
│
└── Test users ← Find this section
    └── + Add Users ← Click here
        └── Enter: thecirclehelp@gmail.com
            └── Add
```

## Still Having Issues?

- Make sure you're signed in to Google Cloud Console with the account that owns the project
- Check that `thecirclehelp@gmail.com` is spelled correctly (no typos)
- Wait a few seconds after adding before trying again
- Try signing out and back in to OAuth Playground

## Note About Production Mode

If you want to make this available to everyone (not just test users), you'll need to:
1. Complete Google's verification process (can take weeks)
2. For now, adding test users is the quickest solution


