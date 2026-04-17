import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import twilio from "twilio";
import { SpeechClient } from "@google-cloud/speech";
import formidable from "formidable";
// @ts-ignore - mailparser doesn't have types
import { simpleParser } from "mailparser";
import { google } from "googleapis";
import * as dotenv from "dotenv";
import { defineString } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import type { Response } from "express";

dotenv.config();

setGlobalOptions({ region: "us-central1" });

admin.initializeApp();

/**
 * All params load from `functions/.env` at deploy (Firebase CLI) and locally via dotenv.
 * Optional later: move sensitive keys to `defineSecret` + `firebase functions:secrets:set`
 * for Secret Manager instead of plain env vars on Cloud Run.
 */
const strGeminiApiKey = defineString("GEMINI_API_KEY", { default: "" });
const strTwilioAuthToken = defineString("TWILIO_AUTH_TOKEN", { default: "" });
const strGmailClientSecret = defineString("GMAIL_CLIENT_SECRET", { default: "" });
const strGmailRefreshToken = defineString("GMAIL_REFRESH_TOKEN", { default: "" });
const strTwilioAccountSid = defineString("TWILIO_ACCOUNT_SID", { default: "" });
const strTwilioPhoneNumber = defineString("TWILIO_PHONE_NUMBER", { default: "" });
const strGmailEmail = defineString("GMAIL_EMAIL", { default: "" });
const strGmailClientId = defineString("GMAIL_CLIENT_ID", { default: "" });
const strGmailRedirectUri = defineString("GMAIL_REDIRECT_URI", {
  default: "http://localhost",
});

function makeTwilioClient() {
  return twilio(strTwilioAccountSid.value(), strTwilioAuthToken.value());
}

const speechClient = new SpeechClient();

interface ScheduleRequest {
  phoneNumber: string;
  customerName: string;
  address: string;
  date: string;
  availableTimeSlots: string[];
}

export const initiateScheduling = onCall(
  {
    cors: true,
  },
  async (request) => {
    const data = request.data as ScheduleRequest;
    try {
      const { phoneNumber, customerName, address, date, availableTimeSlots } =
        data;

      if (!phoneNumber || !customerName || !date) {
        throw new HttpsError("invalid-argument", "Missing required fields");
      }

      const timeSlotsText = availableTimeSlots.join(", ");

      const genAI = new GoogleGenerativeAI(strGeminiApiKey.value());
      const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
      const prompt = `You are a friendly plumbing company assistant. Create a short, professional SMS message (under 160 characters) to schedule a water heater appointment. 

Customer: ${customerName}
Address: ${address}
Date: ${date}
Available time slots: ${timeSlotsText}

Create a friendly message asking them to reply with their preferred time slot.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const message = response.text();

      const twilioClient = makeTwilioClient();
      const twilioMessage = await twilioClient.messages.create({
        body: message,
        from: strTwilioPhoneNumber.value(),
        to: phoneNumber,
      });

      await admin.firestore().collection("schedulingRequests").add({
        phoneNumber,
        customerName,
        address,
        date,
        availableTimeSlots,
        status: "pending",
        twilioMessageSid: twilioMessage.sid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, messageSid: twilioMessage.sid };
    } catch (error) {
      console.error("Error initiating scheduling:", error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", "Failed to initiate scheduling");
    }
  }
);

export const handleSMSReply = onRequest(
  {
    invoker: "public",
    cors: false,
  },
  async (req, res) => {
    try {
      const messageBody = req.body.Body;
      const fromNumber = req.body.From;

      const requestsSnapshot = await admin
        .firestore()
        .collection("schedulingRequests")
        .where("phoneNumber", "==", fromNumber)
        .where("status", "==", "pending")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (requestsSnapshot.empty) {
        res.status(200).send("No pending scheduling request found");
        return;
      }

      const requestDoc = requestsSnapshot.docs[0];
      const requestData = requestDoc.data();

      const genAI = new GoogleGenerativeAI(strGeminiApiKey.value());
      const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
      const prompt = `The customer replied: "${messageBody}"

Available time slots: ${requestData.availableTimeSlots.join(", ")}

Extract the time slot they want. If they didn't specify a time, suggest the first available slot. Respond with ONLY the time slot in HH:MM format (24-hour), or "unclear" if you can't determine.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const selectedTime = response.text().trim();

      const twilioClient = makeTwilioClient();
      const fromNumberPhone = strTwilioPhoneNumber.value();

      if (
        selectedTime !== "unclear" &&
        requestData.availableTimeSlots.includes(selectedTime)
      ) {
        const confirmationMessage = `Great! We've scheduled your water heater appointment for ${requestData.date} at ${selectedTime}. We'll send you a reminder 1 hour before.`;

        await twilioClient.messages.create({
          body: confirmationMessage,
          from: fromNumberPhone,
          to: fromNumber,
        });

        await requestDoc.ref.update({
          status: "confirmed",
          selectedTime,
          confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const appointmentDateTime = new Date(
          `${requestData.date}T${selectedTime}:00`
        );
        const reminderDateTime = new Date(
          appointmentDateTime.getTime() - 60 * 60 * 1000
        );

        await admin.firestore().collection("reminders").add({
          phoneNumber: fromNumber,
          customerName: requestData.customerName,
          address: requestData.address,
          appointmentDate: requestData.date,
          appointmentTime: selectedTime,
          reminderTime: reminderDateTime.toISOString(),
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const clarificationMessage = `Could you please specify your preferred time? Available slots: ${requestData.availableTimeSlots.join(", ")}`;

        await twilioClient.messages.create({
          body: clarificationMessage,
          from: fromNumberPhone,
          to: fromNumber,
        });
      }

      res.status(200).send("OK");
    } catch (error) {
      console.error("Error handling SMS reply:", error);
      res.status(500).send("Error");
    }
  }
);

export const sendReminders = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/New_York",
  },
  async () => {
    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

    const remindersSnapshot = await admin
      .firestore()
      .collection("reminders")
      .where("status", "==", "pending")
      .where("reminderTime", "<=", fiveMinutesFromNow.toISOString())
      .get();

    const twilioClient = makeTwilioClient();
    const fromPhone = strTwilioPhoneNumber.value();

    for (const reminderDoc of remindersSnapshot.docs) {
      const reminder = reminderDoc.data();

      try {
        const reminderMessage = `Reminder: Your water heater appointment is in 1 hour at ${reminder.appointmentTime}.\n\nAddress: ${reminder.address}`;

        await twilioClient.messages.create({
          body: reminderMessage,
          from: fromPhone,
          to: reminder.phoneNumber,
        });

        await reminderDoc.ref.update({
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (error) {
        console.error(`Error sending reminder to ${reminder.phoneNumber}:`, error);
      }
    }
  }
);

export const sendMorningConfirmations = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "America/New_York",
  },
  async () => {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);

    const confirmationsSnapshot = await admin
      .firestore()
      .collection("morningConfirmations")
      .where("status", "==", "pending")
      .where("confirmationTime", "<=", tenMinutesFromNow.toISOString())
      .get();

    const twilioClient = makeTwilioClient();
    const fromPhone = strTwilioPhoneNumber.value();

    for (const confirmationDoc of confirmationsSnapshot.docs) {
      const confirmation = confirmationDoc.data();

      try {
        const confirmationMessage = `Good morning! This is a reminder that you have a plumbing appointment today at ${confirmation.appointmentTime}.\n\nAddress: ${confirmation.address}\n\nPlease reply CONFIRM if you'll be available, or let us know if you need to reschedule.`;

        await twilioClient.messages.create({
          body: confirmationMessage,
          from: fromPhone,
          to: confirmation.phoneNumber,
        });

        await confirmationDoc.ref.update({
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Sent morning confirmation to ${confirmation.phoneNumber}`);
      } catch (error) {
        console.error(
          `Error sending morning confirmation to ${confirmation.phoneNumber}:`,
          error
        );
      }
    }
  }
);

// Helper function to transcribe audio using Google Cloud Speech-to-Text (kept for fallback)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
  try {
    const encoding = mimeType.includes("mpeg") || mimeType.includes("mp3")
      ? "MP3"
      : mimeType.includes("wav")
      ? "LINEAR16"
      : mimeType.includes("ogg")
      ? "OGG_OPUS"
      : "WEBM_OPUS";

    const request = {
      audio: {
        content: audioBuffer.toString("base64"),
      },
      config: {
        encoding: encoding as any,
        sampleRateHertz: 16000,
        languageCode: "en-US",
        alternativeLanguageCodes: ["es-US"], // Support Spanish too
        enableAutomaticPunctuation: true,
        model: "latest_long",
      },
    };

    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      ?.map((result) => result.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join(" ") || "";

    return transcription;
  } catch (error) {
    console.error("Error transcribing audio:", error);
    throw error;
  }
}

async function extractAppointmentDetails(
  transcription: string,
  geminiApiKey: string
): Promise<{
  customerName: string;
  address: string;
  phone?: string;
  date: string;
  time: string;
  notes?: string;
  truckId?: string;
}> {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
  
  const prompt = `You are an AI assistant for a plumbing company scheduling system. Extract appointment details from the following conversation transcript.

The transcript is a text conversation that may contain customer information, appointment requests, addresses, phone numbers, dates, and times.

Transcript: "${transcription}"

Extract the following information:
- customerName: Full name of the customer
- address: Complete address including street, city, state, zip
- phone: Phone number (if mentioned)
- date: Appointment date in YYYY-MM-DD format (if not specified, use today's date: ${new Date().toISOString().split('T')[0]})
- time: Preferred time in HH:MM format (24-hour, default to 09:00 if not specified)
- notes: Any additional notes or special instructions
- truckId: Which truck to assign (truck1, truck2, or truck3) - distribute evenly if not specified

Respond with ONLY a valid JSON object in this exact format:
{
  "customerName": "string",
  "address": "string",
  "phone": "string or empty",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "notes": "string or empty",
  "truckId": "truck1" | "truck2" | "truck3"
}

If any information is missing or unclear, make reasonable assumptions based on context.`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Extract JSON from response (handle markdown code blocks if present)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    
    const appointmentData = JSON.parse(jsonMatch[0]);
    
    // Validate required fields
    if (!appointmentData.customerName || !appointmentData.address) {
      throw new Error("Missing required fields: customerName or address");
    }
    
    // Set defaults
    if (!appointmentData.date) {
      appointmentData.date = new Date().toISOString().split('T')[0];
    }
    if (!appointmentData.time) {
      appointmentData.time = "09:00";
    }
    if (!appointmentData.truckId) {
      // Distribute evenly: use date hash to assign truck
      const dateHash = appointmentData.date.split('-').reduce((a: number, b: string) => a + parseInt(b), 0);
      appointmentData.truckId = `truck${(dateHash % 3) + 1}`;
    }
    
    return appointmentData;
  } catch (error) {
    console.error("Error extracting appointment details:", error);
    throw error;
  }
}

async function generateCallInsights(
  transcription: string,
  geminiApiKey: string
): Promise<{
  callSummary: string;
  customerServiceTips: string[];
}> {
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
  const safeTranscript = transcription.replace(/```/g, "`");

  const prompt = `You coach plumbing company staff on customer service. Read this transcript (call, voicemail, or email text between customer and company).

Transcript:
"""
${safeTranscript}
"""

Return ONLY valid JSON (no markdown) in this exact shape:
{
  "callSummary": "string — 2-4 sentences: what the customer needs, urgency, key facts, and emotional tone so the tech is prepared",
  "customerServiceTips": ["string", "..."] — 3-6 short, actionable tips for the plumber or office staff: communication, empathy, clarity, expectations, follow-up. Reference this transcript when possible. If service was strong, include reinforcing positives. Never insult; frame as constructive growth. If only the customer speaks (voicemail), tip whoever will call back.
}`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in call insights response");
  }
  const parsed = JSON.parse(jsonMatch[0]) as {
    callSummary?: string;
    customerServiceTips?: unknown;
  };
  const callSummary =
    typeof parsed.callSummary === "string" ? parsed.callSummary.trim() : "";
  const customerServiceTips = Array.isArray(parsed.customerServiceTips)
    ? parsed.customerServiceTips
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return {
    callSummary: callSummary || "No summary could be generated from this transcript.",
    customerServiceTips:
      customerServiceTips.length > 0
        ? customerServiceTips
        : [
            "End each call by confirming address, arrival window, and best callback number.",
          ],
  };
}

// Helper function to geocode address (for future use)
// @ts-ignore - unused but kept for future geocoding feature
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    // You can use Google Geocoding API here
    // For now, return null - geocoding can be done client-side
    return null;
  } catch (error) {
    console.error("Error geocoding address:", error);
    return null;
  }
}

/** .txt or text/plain attachments (not HTML) used as call transcripts */
function isTextTranscriptAttachment(
  filename: string | undefined | null,
  mimeType: string | undefined | null
): boolean {
  const name = (filename || "").toLowerCase();
  const mt = (mimeType || "").toLowerCase();
  if (mt.startsWith("audio/")) return false;
  if (name.endsWith(".txt")) return true;
  if (mt.includes("text/plain")) return true;
  return false;
}

function longestTranscriptCandidate(...candidates: string[]): string {
  const trimmed = candidates.map((c) => (c || "").trim()).filter(Boolean);
  if (trimmed.length === 0) return "";
  return trimmed.sort((a, b) => b.length - a.length)[0];
}

function extractPlainTextBodyFromGmailParts(parts: any[]): string {
  let text = "";
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data && !part.filename) {
      const decoded = Buffer.from(part.body.data, "base64").toString("utf-8");
      if (!text || text.length < decoded.length) text = decoded;
    } else if (part.mimeType === "text/html" && part.body?.data && !text && !part.filename) {
      const html = Buffer.from(part.body.data, "base64").toString("utf-8");
      text = html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    } else if (part.parts) {
      const nestedText = extractPlainTextBodyFromGmailParts(part.parts);
      if (nestedText && (!text || text.length < nestedText.length)) text = nestedText;
    }
  }
  return text;
}

function collectGmailTextAttachmentParts(parts: any[] | undefined, acc: any[] = []): any[] {
  if (!parts) return acc;
  for (const p of parts) {
    if (p.filename && isTextTranscriptAttachment(p.filename, p.mimeType)) {
      acc.push(p);
    }
    if (p.parts) collectGmailTextAttachmentParts(p.parts, acc);
  }
  return acc;
}

async function loadGmailAttachmentBodyAsUtf8(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  part: { body?: { data?: string; attachmentId?: string }; filename?: string }
): Promise<string> {
  try {
    if (part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8");
    }
    if (part.body?.attachmentId) {
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.body.attachmentId,
      });
      const raw = att.data.data;
      if (!raw) return "";
      const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
      return Buffer.from(normalized, "base64").toString("utf-8");
    }
  } catch (e) {
    console.error("Failed to read Gmail text attachment:", part.filename, e);
  }
  return "";
}

async function buildTranscriptFromGmailMessage(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  payload: any
): Promise<{ transcript: string; emailText: string }> {
  let emailText = "";
  if (payload.body?.data) {
    emailText = Buffer.from(payload.body.data, "base64").toString("utf-8");
  } else if (payload.parts) {
    emailText = extractPlainTextBodyFromGmailParts(payload.parts);
  }

  const attachParts = collectGmailTextAttachmentParts(payload.parts);
  const chunks: string[] = [];
  for (const part of attachParts) {
    const t = (await loadGmailAttachmentBodyAsUtf8(gmail, messageId, part)).trim();
    if (t) chunks.push(t);
  }
  const fromFiles = chunks.join("\n\n");
  const transcript = longestTranscriptCandidate(emailText, fromFiles);
  return { transcript, emailText: emailText || fromFiles };
}

// Webhook endpoint to handle email with voice attachments
// Compatible with SendGrid Inbound Parse, Mailgun, and other email webhook services
export const processVoiceEmail = onRequest(
  {
    invoker: "public",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (req, res) => {
  try {
    const geminiApiKey = strGeminiApiKey.value();

    // Set CORS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    // Optional: Add security token check
    // const authToken = req.headers["x-auth-token"];
    // if (authToken !== process.env.EMAIL_WEBHOOK_TOKEN) {
    //   res.status(401).send("Unauthorized");
    //   return;
    // }

    // Log the email processing request
    console.log("Processing email with voice attachment...");
    
    // Store email processing request
    const emailRequestRef = await admin.firestore().collection("emailRequests").add({
      rawBody: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
      headers: req.headers,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "processing",
    });

    let audioBuffer: Buffer | null = null;
    let mimeType = "audio/mpeg";
    let emailText = "";
    let supplementalTranscript = "";

    // Handle different email webhook formats
    // Format 1: SendGrid Inbound Parse (multipart/form-data or raw email)
    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      return new Promise<void>((resolve) => {
        const form = formidable({});
        form.parse(req, async (err: any, fields: any, files: any) => {
          if (err) {
            console.error("Error parsing form:", err);
            res.status(400).send("Error parsing email");
            resolve();
            return;
          }

          try {
            // Extract email text from fields
            emailText = (Array.isArray(fields.text) ? fields.text[0] : fields.text) || 
                       (Array.isArray(fields.html) ? fields.html[0] : fields.html) || "";

            const fs = require("fs") as typeof import("fs");
            let textFromAttachments = "";
            const fileKeys = Object.keys(files);
            const handleUploadedFile = (f: {
              filepath?: string;
              mimetype?: string;
              originalFilename?: string | null;
            }) => {
              if (!f?.filepath) return;
              if (f.mimetype?.startsWith("audio/") || f.originalFilename?.match(/\.(mp3|wav|ogg|m4a|webm)$/i)) {
                if (!audioBuffer) {
                  audioBuffer = fs.readFileSync(f.filepath);
                  mimeType = f.mimetype || "audio/mpeg";
                }
                return;
              }
              if (isTextTranscriptAttachment(f.originalFilename || undefined, f.mimetype)) {
                const chunk = fs.readFileSync(f.filepath, "utf-8");
                if (chunk.trim()) {
                  textFromAttachments += (textFromAttachments ? "\n\n" : "") + chunk.trim();
                }
              }
            };
            for (const key of fileKeys) {
              const file = (files as any)[key];
              if (file && Array.isArray(file)) {
                for (const f of file) handleUploadedFile(f);
              } else if (file) {
                handleUploadedFile(file);
              }
            }

            const combinedTranscript = longestTranscriptCandidate(emailText, textFromAttachments);
            if (combinedTranscript) {
              await processTranscriptionAndCreateSchedule(
                combinedTranscript,
                emailText || combinedTranscript,
                emailRequestRef.id,
                res,
                geminiApiKey
              );
            } else if (audioBuffer) {
              await processAudioAndCreateSchedule(
                audioBuffer,
                mimeType,
                emailText,
                emailRequestRef.id,
                res,
                geminiApiKey
              );
            } else {
              res.status(400).json({ success: false, error: "No transcription or audio found in email" });
            }
            resolve();
          } catch (error) {
            console.error("Error processing form:", error);
            res.status(500).json({ success: false, error: "Failed to process email" });
            resolve();
          }
        });
      });
    }

    // Format 2: Raw email (RFC 822) - parse with mailparser
    if (req.headers["content-type"]?.includes("message/rfc822") || req.body.raw || req.body.email) {
      try {
        const rawEmail = req.body.raw || req.body.email || Buffer.from(JSON.stringify(req.body));
        const email = await simpleParser(Buffer.isBuffer(rawEmail) ? rawEmail : Buffer.from(rawEmail));
        emailText = email.text || email.html || "";

        let textFromAttachments = "";
        if (email.attachments && email.attachments.length > 0) {
          for (const attachment of email.attachments) {
            if (attachment.contentType?.startsWith("audio/") ||
                attachment.filename?.match(/\.(mp3|wav|ogg|m4a|webm)$/i)) {
              if (!audioBuffer) {
                audioBuffer = Buffer.isBuffer(attachment.content)
                  ? attachment.content
                  : Buffer.from(attachment.content as Buffer);
                mimeType = attachment.contentType || "audio/mpeg";
              }
              continue;
            }
            if (isTextTranscriptAttachment(attachment.filename, attachment.contentType)) {
              const buf = Buffer.isBuffer(attachment.content)
                ? attachment.content
                : Buffer.from(attachment.content as Buffer);
              const chunk = buf.toString("utf-8").trim();
              if (chunk) {
                textFromAttachments += (textFromAttachments ? "\n\n" : "") + chunk;
              }
            }
          }
        }

        const combinedTranscript = longestTranscriptCandidate(emailText, textFromAttachments);
        if (combinedTranscript) {
          await processTranscriptionAndCreateSchedule(
            combinedTranscript,
            emailText || combinedTranscript,
            emailRequestRef.id,
            res,
            geminiApiKey
          );
        } else if (audioBuffer) {
          await processAudioAndCreateSchedule(
            audioBuffer,
            mimeType,
            emailText,
            emailRequestRef.id,
            res,
            geminiApiKey
          );
        } else {
          res.status(400).json({ success: false, error: "No transcription or audio found in email" });
        }
        return;
      } catch (error) {
        console.error("Error parsing email:", error);
        res.status(400).json({ success: false, error: "Error parsing email" });
        return;
      }
    }

    // Format 3: JSON webhook (Mailgun, etc.) or SendGrid with attachments
    if (req.body.attachment_count || req.body.attachments || req.body.attachment) {
      emailText = req.body["body-plain"] || req.body["body-html"] || req.body.text || "";

      if (req.body.audio) {
        audioBuffer = Buffer.from(req.body.audio, "base64");
        mimeType = req.body.audio_type || req.body.content_type || "audio/mpeg";
      } else if (req.body.attachment && typeof req.body.attachment === "string") {
        try {
          const buf = Buffer.from(req.body.attachment, "base64");
          const ct = String(req.body.content_type || "").toLowerCase();
          const fn = String(
            req.body.filename || req.body.attachment_filename || ""
          ).toLowerCase();
          if (isTextTranscriptAttachment(fn || undefined, ct || undefined)) {
            supplementalTranscript = buf.toString("utf-8");
          } else {
            audioBuffer = buf;
            mimeType = req.body.content_type || "audio/mpeg";
          }
        } catch (e) {
          console.log("Attachment is not base64, may be a URL");
        }
      }
    }

    const mergedWebhookTranscript = longestTranscriptCandidate(
      emailText,
      supplementalTranscript
    );
    if (mergedWebhookTranscript) {
      await processTranscriptionAndCreateSchedule(
        mergedWebhookTranscript,
        emailText || mergedWebhookTranscript,
        emailRequestRef.id,
        res,
        geminiApiKey
      );
    } else if (audioBuffer) {
      await processAudioAndCreateSchedule(
        audioBuffer,
        mimeType,
        emailText,
        emailRequestRef.id,
        res,
        geminiApiKey
      );
    } else {
      res.status(400).json({ success: false, error: "No transcription or audio found in email" });
    }
  } catch (error) {
    console.error("Error processing voice email:", error);
    res.status(500).json({ 
      success: false, 
      error: "Failed to process email",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
  }
);

// Helper function to process audio and create schedule (fallback for audio files)
async function processAudioAndCreateSchedule(
  audioBuffer: Buffer,
  mimeType: string,
  emailText: string,
  emailRequestId: string,
  res: Response,
  geminiApiKey: string
) {
  try {
    // Transcribe audio
    const transcription = await transcribeAudio(audioBuffer, mimeType);
    // Then process the transcription
    await processTranscriptionAndCreateSchedule(
      transcription,
      emailText,
      emailRequestId,
      res,
      geminiApiKey
    );
  } catch (error) {
    console.error("Error in processAudioAndCreateSchedule:", error);
    await admin.firestore().collection("emailRequests").doc(emailRequestId).update({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to process audio",
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to process audio",
    });
  }
}

async function processTranscriptionAndCreateSchedule(
  transcription: string,
  emailText: string,
  emailRequestId: string,
  res: Response,
  geminiApiKey: string
) {
  const emailRequestRef = admin.firestore().collection("emailRequests").doc(emailRequestId);
  
  try {
    // Verify the document exists before trying to update it
    const emailRequestDoc = await emailRequestRef.get();
    if (!emailRequestDoc.exists) {
      console.error(`Email request document ${emailRequestId} does not exist`);
      // Create it if it doesn't exist
      await emailRequestRef.set({
        status: "error",
        error: "Email request document was not found",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(500).json({ 
        success: false, 
        error: "Email request document not found" 
      });
      return;
    }

    if (!transcription || transcription.trim().length === 0) {
      await emailRequestRef.update({
        status: "error",
        error: "No transcription found in email",
        transcription: "",
      });
      res.status(400).json({ 
        success: false, 
        error: "No transcription found in email body or attachments" 
      });
      return;
    }

    console.log("Using transcription from email:", transcription);

    // Step 1: Extract appointment details and call coaching (parallel)
    console.log("Extracting appointment details and call insights...");
    const [appointmentData, callInsights] = await Promise.all([
      extractAppointmentDetails(transcription, geminiApiKey),
      generateCallInsights(transcription, geminiApiKey).catch((err) => {
        console.error("Call insights generation failed:", err);
        return null;
      }),
    ]);
    console.log("Appointment data:", appointmentData);

    // Step 3: Get or create schedule for the date
    const scheduleRef = admin.firestore().collection("schedules").doc(appointmentData.date);
    const scheduleDoc = await scheduleRef.get();
    
    let trucks: any[] = [];
    if (scheduleDoc.exists) {
      const scheduleData = scheduleDoc.data();
      trucks = scheduleData?.trucks || [];
    } else {
      // Initialize with default trucks
      trucks = [
        { id: "truck1", name: "Truck 1", stops: [] },
        { id: "truck2", name: "Truck 2", stops: [] },
        { id: "truck3", name: "Truck 3", stops: [] },
      ];
    }

    // Step 3: Find the truck and add the stop
    const truckIndex = trucks.findIndex(t => t.id === appointmentData.truckId);
    if (truckIndex === -1) {
      throw new Error(`Truck ${appointmentData.truckId} not found`);
    }

    const newStop = {
      id: Date.now().toString(),
      address: appointmentData.address,
      customerName: appointmentData.customerName,
      phone: appointmentData.phone || "",
      time: appointmentData.time,
      notes: appointmentData.notes || "",
      lat: null,
      lng: null,
      ...(callInsights
        ? {
            callSummary: callInsights.callSummary,
            customerServiceTips: callInsights.customerServiceTips,
          }
        : {}),
    };

    trucks[truckIndex].stops.push(newStop);

    // Step 4: Save the updated schedule
    await scheduleRef.set({
      date: appointmentData.date,
      trucks: trucks,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Step 5: Create morning confirmation reminder if phone number is available
    if (appointmentData.phone) {
      const appointmentDate = new Date(`${appointmentData.date}T${appointmentData.time}:00`);
      const morningConfirmationTime = new Date(appointmentDate);
      morningConfirmationTime.setHours(8, 0, 0, 0); // 8 AM on appointment day
      
      // Only create if appointment is in the future
      if (morningConfirmationTime > new Date()) {
        await admin.firestore().collection("morningConfirmations").add({
          phoneNumber: appointmentData.phone,
          customerName: appointmentData.customerName,
          address: appointmentData.address,
          appointmentDate: appointmentData.date,
          appointmentTime: appointmentData.time,
          confirmationTime: morningConfirmationTime.toISOString(),
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    // Step 6: Update email request status
    await emailRequestRef.update({
      status: "success",
      transcription: transcription,
      appointmentData: appointmentData,
      scheduleDate: appointmentData.date,
      stopId: newStop.id,
      ...(callInsights && {
        callSummary: callInsights.callSummary,
        customerServiceTips: callInsights.customerServiceTips,
      }),
    });

    console.log(`Successfully created appointment for ${appointmentData.customerName} on ${appointmentData.date} at ${appointmentData.time}`);

    res.status(200).json({
      success: true,
      message: "Appointment created successfully",
      appointment: {
        customerName: appointmentData.customerName,
        address: appointmentData.address,
        date: appointmentData.date,
        time: appointmentData.time,
        truckId: appointmentData.truckId,
      },
      ...(callInsights && {
        callInsights: {
          callSummary: callInsights.callSummary,
          customerServiceTips: callInsights.customerServiceTips,
        },
      }),
    });
  } catch (error) {
    console.error("Error in processTranscriptionAndCreateSchedule:", error);
    try {
      // Try to update the document, but handle case where it might not exist
      const emailRequestDoc = await emailRequestRef.get();
      if (emailRequestDoc.exists) {
        await emailRequestRef.update({
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      } else {
        // Create it if it doesn't exist
        await emailRequestRef.set({
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (updateError) {
      console.error("Error updating email request document:", updateError);
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to process appointment",
    });
  }
}

export type GmailPollContext = {
  geminiApiKey: string;
  gmailEmail: string;
  gmailClientId: string;
  gmailClientSecret: string;
  gmailRefreshToken: string;
  gmailRedirectUri: string;
};

async function checkGmailForVoiceEmailsInternal(ctx: GmailPollContext) {
  const gmailEmail = ctx.gmailEmail || "";
  const gmailRefreshToken = ctx.gmailRefreshToken || "";

  if (!gmailEmail || !gmailRefreshToken) {
    console.warn(
      "[checkGmailForVoiceEmails] Missing Gmail config (need GMAIL_EMAIL + GMAIL_REFRESH_TOKEN and client id/secret in functions/.env). " +
        "Set variables in functions/.env (or Cloud Run env) and redeploy."
    );
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    ctx.gmailClientId,
    ctx.gmailClientSecret,
    ctx.gmailRedirectUri || "http://localhost"
  );

  oauth2Client.setCredentials({
    refresh_token: gmailRefreshToken,
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Search for unread emails sent to the configured email
  // Emails contain conversation transcripts as plain text
  const query = `to:${gmailEmail} is:unread`;
  const response = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 10,
  });

  if (!response.data.messages || response.data.messages.length === 0) {
    console.log(
      `[checkGmailForVoiceEmails] No unread mail for to:${gmailEmail} (query: ${query}).`
    );
    return null;
  }

  console.log(
    `[checkGmailForVoiceEmails] Found ${response.data.messages.length} unread message(s) for ${gmailEmail}`
  );

  // Process each email
  for (const message of response.data.messages) {
    if (!message.id) continue;

    try {
      // Get full message details
      const messageDetail = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full",
      });

      const messageData = messageDetail.data;
      const payload = messageData.payload;

      if (!payload) continue;

      const built = await buildTranscriptFromGmailMessage(
        gmail,
        message.id,
        payload
      );
      let { transcript, emailText } = built;

      if (transcript) {
        transcript = transcript
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      // Body and/or .txt / text-plain attachments (large files use attachmentId)
      if (transcript && transcript.trim().length > 30) {
            // Store email processing request
            const emailRequestData = {
              gmailMessageId: message.id,
              emailFrom: messageData.payload?.headers?.find(
                (h: any) => h.name === "From"
              )?.value,
              emailSubject: messageData.payload?.headers?.find(
                (h: any) => h.name === "Subject"
              )?.value,
              emailText: emailText,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              status: "processing",
            };

            // Create document reference first, then set the data
            const emailRequestRef = admin
              .firestore()
              .collection("emailRequests")
              .doc();
            
            const emailRequestId = emailRequestRef.id;
            
            // Set the document (this creates it)
            await emailRequestRef.set(emailRequestData);

            // Process the transcription and create schedule
            // We'll need to create a mock response object for the function
            const mockRes = {
              status: (code: number) => mockRes,
              json: (data: any) => {
                console.log("Processing result:", data);
                return mockRes;
              },
              send: (data: any) => {
                console.log("Processing result:", data);
                return mockRes;
              },
              set: () => mockRes,
            } as any;

            await processTranscriptionAndCreateSchedule(
              transcript,
              emailText,
              emailRequestId,
              mockRes,
              ctx.geminiApiKey
            );

            // Mark email as read
            await gmail.users.messages.modify({
              userId: "me",
              id: message.id,
              requestBody: {
                removeLabelIds: ["UNREAD"],
              },
            });

            console.log(`Processed email ${message.id} successfully`);
          } else {
            console.log(`No transcript found in email ${message.id} - email body is empty or too short`);
          }
        } catch (error) {
          console.error(`Error processing email ${message.id}:`, error);
        }
      }

  return null;
}

function buildGmailPollContext(): GmailPollContext {
  return {
    geminiApiKey: strGeminiApiKey.value(),
    gmailEmail: strGmailEmail.value(),
    gmailClientId: strGmailClientId.value(),
    gmailClientSecret: strGmailClientSecret.value(),
    gmailRefreshToken: strGmailRefreshToken.value(),
    gmailRedirectUri: strGmailRedirectUri.value(),
  };
}

export const checkGmailForVoiceEmails = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "UTC",
  },
  async () => {
    console.log(
      "[checkGmailForVoiceEmails] scheduled run started",
      new Date().toISOString()
    );
    await checkGmailForVoiceEmailsInternal(buildGmailPollContext());
    console.log("[checkGmailForVoiceEmails] scheduled run finished");
  }
);

export const checkGmailNow = onRequest(
  {
    invoker: "public",
  },
  async (req, res) => {
    try {
      const ctx = buildGmailPollContext();
      if (!ctx.gmailEmail || !ctx.gmailRefreshToken) {
        res.status(400).json({
          success: false,
          error:
            "Gmail not configured. Set GMAIL_EMAIL, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in functions/.env, then redeploy.",
        });
        return;
      }

      console.log("[checkGmailNow] manual run started", new Date().toISOString());
      await checkGmailForVoiceEmailsInternal(ctx);
      res.json({
        success: true,
        message:
          "Gmail check completed. Read Cloud logs for this function for details (unread count, processing errors).",
        inbox: ctx.gmailEmail,
      });
    } catch (error) {
      console.error("Error in checkGmailNow:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

