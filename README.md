# NJ Plumbing Scheduling System

A modern scheduling website for plumbing companies built with Vite + React, featuring a Monkeytype-inspired dark theme UI.

## Features

- 🗓️ **Schedule Management**: Input and manage schedules for multiple trucks
- 📍 **Interactive Map**: Visualize all stops on a Google Maps component
- 🎨 **Monkeytype Style**: Dark theme with monospace fonts and clean design
- ☁️ **Firestore Integration**: Schedules are saved to Firebase Firestore (cloud storage)
- 🔍 **Address Geocoding**: Automatically converts addresses to map coordinates
- 📱 **SMS Scheduling**: Automatically schedule appointments via SMS using Twilio and Gemini AI
- ⏰ **Reminder System**: Automatic SMS reminders sent 1 hour before appointments
- 🎙️ **Plaud Call Intake**: Sync Plaud Note recordings, highlight booked appointments, and ask AI about the day's calls

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Google Maps API:**
   - Get a Google Maps API key from [Google Cloud Console](https://console.cloud.google.com/)
   - Enable the following APIs:
     - Maps JavaScript API
     - Geocoding API
   - Create a `.env` file in the root directory:
     ```
     VITE_GOOGLE_MAPS_API_KEY=your_api_key_here
     ```

3. **Set up Firebase Cloud Functions (for SMS scheduling):**
   - Install Firebase CLI: `npm install -g firebase-tools`
   - Login: `firebase login`
   - Initialize Functions: `cd functions && npm install`
   - Get API keys:
     - **Gemini API**: Get from [Google AI Studio](https://makersuite.google.com/app/apikey)
     - **Twilio**: Get Account SID, Auth Token, and Phone Number from [Twilio Console](https://console.twilio.com/)
   - Set environment variables in Firebase (using Firebase Functions config):
     ```bash
     firebase functions:config:set gemini.api_key="your_gemini_key"
     firebase functions:config:set twilio.account_sid="your_account_sid"
     firebase functions:config:set twilio.auth_token="your_auth_token"
     firebase functions:config:set twilio.phone_number="+1234567890"
     ```
   - Or use environment variables (for local development):
     - Create `functions/.env` file with:
       ```
       GEMINI_API_KEY=your_gemini_key
       TWILIO_ACCOUNT_SID=your_account_sid
       TWILIO_AUTH_TOKEN=your_auth_token
       TWILIO_PHONE_NUMBER=+1234567890
       ```
   - Deploy functions: `firebase deploy --only functions`
   - Set up Twilio webhook: In Twilio Console, set the webhook URL to your `handleSMSReply` function URL (found in Firebase Console after deployment)

4. **Run the development server:**
   ```bash
   npm run dev
   ```

5. **Build for production:**
   ```bash
   npm run build
   ```

## Usage

1. **Select a date** using the date picker in the header
2. **Choose a truck** from the truck buttons
3. **Add stops** by clicking "+ Add Stop" and filling in:
   - Customer Name (required)
   - Address (required)
   - Phone (optional, but required for SMS scheduling)
   - Time (required)
   - Notes (optional)
4. **Initiate SMS Scheduling**: Click the "📱 SMS Schedule" button on any stop with a phone number
   - The system will send an SMS to the customer with available time slots
   - Gemini AI will parse their reply and confirm the appointment
   - A reminder SMS will be sent automatically 1 hour before the appointment
5. **View on map** by switching to "Map View" tab
6. **Edit or delete** stops as needed

Schedules are automatically saved to Firestore and sync across all devices.

## Tech Stack

- **Vite** - Build tool and dev server
- **React** - UI framework
- **TypeScript** - Type safety
- **Firebase Firestore** - Cloud database for schedules
- **Firebase Cloud Functions** - Backend service for SMS scheduling
- **Twilio** - SMS messaging service
- **Google Gemini AI** - Natural language processing for SMS replies
- **Google Maps API** - Map visualization and geocoding
- **date-fns** - Date formatting

## Project Structure

```
src/
  ├── components/
  │   ├── ScheduleForm.tsx  # Schedule input form with SMS scheduling
  │   └── MapView.tsx        # Map visualization
  ├── firebase/
  │   └── config.ts          # Firebase configuration
  ├── services/
  │   ├── scheduleService.ts # Firestore service functions
  │   └── smsService.ts      # SMS scheduling service
  ├── utils/
  │   └── geocode.ts         # Address geocoding utility
  ├── types.ts               # TypeScript interfaces
  ├── App.tsx                # Main app component
  └── index.css              # Global styles (Monkeytype theme)
functions/
  └── src/
      └── index.ts           # Firebase Cloud Functions (SMS & reminders)
```
