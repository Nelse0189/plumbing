# How to Get Refresh Token for thecirclehelp@gmail.com

You have your Client ID and Client Secret. Now you need to authorize `thecirclehelp@gmail.com` to get a refresh token.

## Method 1: Using OAuth Playground (Easiest - Recommended)

### Step 0: Add OAuth Playground Redirect URI (IMPORTANT!)

**Before using OAuth Playground, you MUST add its redirect URI to your OAuth client:**

1. Go to: https://console.cloud.google.com/apis/credentials
2. Click on your OAuth client
3. Scroll to **"Authorized redirect URIs"**
4. Click **"+ Add URI"**
5. Add: `https://developers.google.com/oauthplayground`
6. Click **"Save"**

**If you get "redirect_uri_mismatch" error:** See `FIX_REDIRECT_URI.md` for detailed fix!

### Step 1: Go to OAuth Playground

1. Go to: https://developers.google.com/oauthplayground/
2. Click the **gear icon** ⚙️ (top right) to open settings
3. Check the box: **"Use your own OAuth credentials"**
4. Enter:
   - **OAuth Client ID:** Your Client ID (from previous step)
   - **OAuth Client secret:** Your Client Secret (from previous step)
5. Click **"Close"**

### Step 2: Select Gmail Scopes

1. In the left sidebar, find **"Gmail API v1"**
2. Check these boxes:
   - ✅ `https://www.googleapis.com/auth/gmail.readonly`
   - ✅ `https://www.googleapis.com/auth/gmail.modify`
3. Click **"Authorize APIs"** button (blue button at bottom)

### Step 3: Sign In and Authorize

1. A popup will ask you to sign in
2. **Sign in with:** `thecirclehelp@gmail.com` (the account you want to check)
3. Click **"Continue"** or **"Allow"** to grant permissions
4. You'll see a message like "Authorization successful"

### Step 4: Exchange for Refresh Token

1. After authorization, you'll see a code in the left panel
2. Click **"Exchange authorization code for tokens"** button
3. You'll see tokens appear on the right side:
   - **Refresh token:** `1//0gabcdefghijklmnop...` ← **COPY THIS!**
   - Access token (you don't need this)

### Step 5: Save Your Refresh Token

Copy the **Refresh token** - it looks like:
```
1//0gabcdefghijklmnopqrstuvwxyz1234567890
```

**Save it safely** - you'll need it for Firebase config!

---

## Method 2: Using a Script (Alternative)

If OAuth Playground doesn't work, you can use a Node.js script:

### Step 1: Create the Script

Create a file `functions/get-refresh-token.js`:

```javascript
const { google } = require('googleapis');
const readline = require('readline');

// Replace these with YOUR credentials
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET_HERE';
const REDIRECT_URI = 'http://localhost';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
  prompt: 'consent' // Force consent screen to get refresh token
});

console.log('\n🔗 Visit this URL to authorize:');
console.log(authUrl);
console.log('\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('After authorizing, paste the code from the URL here: ', (code) => {
  oauth2Client.getToken(code, (err, token) => {
    if (err) {
      console.error('❌ Error getting token:', err);
      return;
    }
    
    console.log('\n✅ SUCCESS! Here are your tokens:\n');
    console.log('Refresh Token:');
    console.log(token.refresh_token);
    console.log('\n');
    console.log('Access Token (not needed):');
    console.log(token.access_token);
    console.log('\n');
    console.log('⚠️  Save the Refresh Token - you won\'t see it again!');
    
    rl.close();
  });
});
```

### Step 2: Install Dependencies

```bash
cd functions
npm install googleapis
```

### Step 3: Run the Script

1. Edit `get-refresh-token.js` and replace `YOUR_CLIENT_ID_HERE` and `YOUR_CLIENT_SECRET_HERE` with your actual credentials
2. Run:
   ```bash
   node get-refresh-token.js
   ```
3. It will show you a URL - visit it in your browser
4. Sign in with `thecirclehelp@gmail.com`
5. Copy the code from the URL after authorization
6. Paste it back into the terminal
7. You'll see your refresh token!

---

## Method 3: Using Google Cloud Console (Advanced)

1. Go to: https://console.cloud.google.com/apis/credentials
2. Click on your OAuth client
3. Under "Authorized redirect URIs", make sure `http://localhost` is listed
4. Use OAuth Playground (Method 1) - it's easier!

---

## What You Should Have Now

✅ **Client ID:** `123456789-abc.apps.googleusercontent.com`  
✅ **Client Secret:** `GOCSPX-abc...`  
✅ **Refresh Token:** `1//0gabcdefghijklmnop...` ← **You just got this!**

## Next Step: Set Firebase Config

Once you have all three, run:

```bash
firebase functions:config:set \
  gmail.email="thecirclehelp@gmail.com" \
  gmail.client_id="YOUR_CLIENT_ID" \
  gmail.client_secret="YOUR_CLIENT_SECRET" \
  gmail.refresh_token="YOUR_REFRESH_TOKEN"
```

Replace:
- `YOUR_CLIENT_ID` with your Client ID
- `YOUR_CLIENT_SECRET` with your Client Secret  
- `YOUR_REFRESH_TOKEN` with your Refresh Token

## Troubleshooting

### "Access blocked: This app's request is invalid" or "Error 403: access_denied"
- **You MUST add `thecirclehelp@gmail.com` as a test user!**
- Go to: https://console.cloud.google.com/apis/credentials/consent
- Scroll to "Test users" section
- Click "+ Add Users" and add `thecirclehelp@gmail.com`
- See `ADD_TEST_USER.md` for detailed instructions

### "Redirect URI mismatch"
- Make sure `http://localhost` is in your authorized redirect URIs
- In OAuth Playground, make sure you checked "Use your own OAuth credentials"

### "Invalid grant"
- Make sure you're signing in with `thecirclehelp@gmail.com`
- Try clearing browser cache and trying again

### Refresh token not showing
- Make sure you selected `access_type: 'offline'` (OAuth Playground does this automatically)
- Make sure you clicked "Exchange authorization code for tokens"

## Quick Links

- **OAuth Playground:** https://developers.google.com/oauthplayground/
- **Google Cloud Console:** https://console.cloud.google.com/apis/credentials

