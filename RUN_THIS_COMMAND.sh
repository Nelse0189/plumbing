#!/bin/bash
# Example only — fill in your own values (do not commit real secrets).
# Prefer functions/.env + Gen 2 deploy for this project.

firebase functions:config:set \
  gmail.email="YOUR_GMAIL_ADDRESS" \
  gmail.client_id="YOUR_CLIENT_ID.apps.googleusercontent.com" \
  gmail.client_secret="YOUR_CLIENT_SECRET" \
  gmail.refresh_token="YOUR_REFRESH_TOKEN" \
  gemini.api_key="YOUR_GEMINI_API_KEY" \
  twilio.account_sid="YOUR_TWILIO_ACCOUNT_SID" \
  twilio.auth_token="YOUR_TWILIO_AUTH_TOKEN" \
  twilio.phone_number="YOUR_TWILIO_FROM_NUMBER"

echo "Configuration command template (edit placeholders before running)."


