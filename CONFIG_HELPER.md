# Firebase Config Helper

## Option 1: Share Your Credentials (I'll Create the Command)

Just paste your credentials here and I'll create the exact command for you:

**What I need:**
1. ✅ Client ID: `your-client-id-here`
2. ✅ Client Secret: `your-client-secret-here`
3. ✅ Refresh Token: `your-refresh-token-here`
4. ⚠️ Gemini API Key: `your-gemini-key-here` (if you have it)
5. ⚠️ Twilio Account SID: `your-twilio-sid-here` (if you have it)
6. ⚠️ Twilio Auth Token: `your-twilio-token-here` (if you have it)
7. ⚠️ Twilio Phone Number: `+1234567890` (if you have it)

**I'll create the exact command you need to run!**

## Option 2: Use the Script

1. Open `SET_FIREBASE_CONFIG.sh`
2. Replace all `YOUR_*_HERE` values with your actual credentials
3. Run: `bash SET_FIREBASE_CONFIG.sh`

## Option 3: Manual Command

Replace the values in this command:

```bash
firebase functions:config:set \
  gmail.email="thecirclehelp@gmail.com" \
  gmail.client_id="YOUR_CLIENT_ID" \
  gmail.client_secret="YOUR_CLIENT_SECRET" \
  gmail.refresh_token="YOUR_REFRESH_TOKEN" \
  gemini.api_key="YOUR_GEMINI_API_KEY" \
  twilio.account_sid="YOUR_TWILIO_ACCOUNT_SID" \
  twilio.auth_token="YOUR_TWILIO_AUTH_TOKEN" \
  twilio.phone_number="YOUR_TWILIO_PHONE_NUMBER"
```

## Security Note

- These credentials are stored securely in Firebase Functions config
- They're encrypted and only accessible to your Firebase project
- Never commit these to git or share publicly

## Verify Configuration

After setting config, verify it:

```bash
firebase functions:config:get
```

This will show all your configured values (secrets are masked for security).


