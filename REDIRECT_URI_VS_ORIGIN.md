# Redirect URI vs JavaScript Origin - What's the Difference?

## The Error You're Seeing

If you see: **"Invalid Origin: URIs must not contain a path or end with '/'"**

You're trying to add it to the **wrong section**!

## Two Different Sections

When editing your OAuth client, you'll see TWO sections:

### 1. Authorized JavaScript origins (WRONG for OAuth Playground)
- **Location:** Near the top of the form
- **Rule:** Cannot have paths, must be just domain
- **Example:** `https://developers.google.com` ✅
- **Example:** `https://developers.google.com/oauthplayground` ❌ (has path - invalid!)

### 2. Authorized redirect URIs (CORRECT for OAuth Playground)
- **Location:** Lower on the form, below JavaScript origins
- **Rule:** CAN have paths
- **Example:** `https://developers.google.com/oauthplayground` ✅ (valid!)
- **Example:** `http://localhost` ✅

## Where to Add OAuth Playground URI

✅ **Add to:** "Authorized redirect URIs"  
❌ **NOT to:** "Authorized JavaScript origins"

## Visual Guide

```
OAuth Client Edit Form
├── Application type: Web application
├── Name: Gmail API Client
│
├── Authorized JavaScript origins ← DON'T ADD HERE
│   └── (Cannot have paths)
│
└── Authorized redirect URIs ← ADD HERE ✅
    ├── http://localhost
    └── + Add URI
        └── https://developers.google.com/oauthplayground ← Add this
```

## Quick Fix

1. Scroll down past "Authorized JavaScript origins"
2. Find "Authorized redirect URIs" section
3. Click "+ Add URI" in THAT section
4. Add: `https://developers.google.com/oauthplayground`
5. Save

## Why This Matters

- **JavaScript origins** = Where your app runs from (domain only)
- **Redirect URIs** = Where OAuth sends users after authorization (can have paths)

OAuth Playground needs the redirect URI, not the JavaScript origin!


