#!/bin/bash
# Firebase Functions Config Setup Script
# Fill in your values below and run: bash SET_FIREBASE_CONFIG.sh

# Gmail Configuration
GMAIL_EMAIL="thecirclehelp@gmail.com"
GMAIL_CLIENT_ID="YOUR_CLIENT_ID_HERE"
GMAIL_CLIENT_SECRET="YOUR_CLIENT_SECRET_HERE"
GMAIL_REFRESH_TOKEN="YOUR_REFRESH_TOKEN_HERE"

# Gemini AI Configuration
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"

# Twilio Configuration (if you have it)
TWILIO_ACCOUNT_SID="YOUR_TWILIO_ACCOUNT_SID_HERE"
TWILIO_AUTH_TOKEN="YOUR_TWILIO_AUTH_TOKEN_HERE"
TWILIO_PHONE_NUMBER="YOUR_TWILIO_PHONE_NUMBER_HERE"

# Set Firebase Functions Config
echo "Setting Firebase Functions configuration..."

firebase functions:config:set \
  gmail.email="$GMAIL_EMAIL" \
  gmail.client_id="$GMAIL_CLIENT_ID" \
  gmail.client_secret="$GMAIL_CLIENT_SECRET" \
  gmail.refresh_token="$GMAIL_REFRESH_TOKEN" \
  gemini.api_key="$GEMINI_API_KEY" \
  twilio.account_sid="$TWILIO_ACCOUNT_SID" \
  twilio.auth_token="$TWILIO_AUTH_TOKEN" \
  twilio.phone_number="$TWILIO_PHONE_NUMBER"

echo "✅ Configuration set successfully!"
echo ""
echo "To verify, run: firebase functions:config:get"


