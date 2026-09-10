import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";

const CLIP_COLLECTION = "voiceTtsClips";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel, American female
const DEFAULT_MODEL = "eleven_flash_v2_5";
const POLLY_FALLBACK_VOICE = "Polly.Joanna-Neural";

const strElevenLabsApiKey = defineString("ELEVENLABS_API_KEY", { default: "" });
const strElevenLabsVoiceId = defineString("ELEVENLABS_VOICE_ID", {
  default: DEFAULT_VOICE_ID,
});
const strElevenLabsModel = defineString("ELEVENLABS_MODEL", {
  default: DEFAULT_MODEL,
});

type TwimlSpeaker = {
  play: (url: string) => unknown;
  // Twilio overloads say(text) and say(attributes, text).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  say: (arg1: any, arg2?: string) => unknown;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function voiceFunctionsBase(): string {
  const projectId =
    process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "nj-plumbing";
  return `https://us-central1-${projectId}.cloudfunctions.net`;
}

function clipIdFor(text: string, voiceId: string, model: string): string {
  return createHash("sha256")
    .update(`${voiceId}|${model}|${text}`)
    .digest("hex");
}

function asAudioBuffer(value: unknown): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "object" && value !== null && "toUint8Array" in value) {
    return Buffer.from(
      (value as { toUint8Array: () => Uint8Array }).toUint8Array()
    );
  }
  return null;
}

async function synthesizeElevenLabs(
  text: string,
  voiceId: string,
  model: string,
  apiKey: string
): Promise<Buffer> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
    `?output_format=mp3_22050_32`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: model,
      apply_text_normalization: "on",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 0.92,
      },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`ElevenLabs TTS ${response.status}: ${detail}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function ensureVoiceClipUrl(text: string): Promise<string | null> {
  const spoken = text.trim();
  const apiKey = strElevenLabsApiKey.value().trim();
  if (!spoken || !apiKey) return null;

  const voiceId = strElevenLabsVoiceId.value().trim() || DEFAULT_VOICE_ID;
  const model = strElevenLabsModel.value().trim() || DEFAULT_MODEL;
  const clipId = clipIdFor(spoken, voiceId, model);
  const ref = admin.firestore().collection(CLIP_COLLECTION).doc(clipId);
  const existing = await ref.get();
  if (asAudioBuffer(existing.data()?.audio)) {
    return `${voiceFunctionsBase()}/playVoiceClip?id=${clipId}`;
  }

  const audio = await synthesizeElevenLabs(spoken, voiceId, model, apiKey);
  await ref.set({
    text: spoken,
    voiceId,
    model,
    contentType: "audio/mpeg",
    audio,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return `${voiceFunctionsBase()}/playVoiceClip?id=${clipId}`;
}

export async function speakTwiml(
  node: TwimlSpeaker,
  text: string
): Promise<void> {
  const spoken = text.trim();
  if (!spoken) return;
  try {
    const url = await ensureVoiceClipUrl(spoken);
    if (url) {
      node.play(url);
      return;
    }
  } catch (error) {
    console.error("ElevenLabs TTS failed; using Twilio neural voice", error);
  }
  node.say({ voice: POLLY_FALLBACK_VOICE }, spoken);
}

export const playVoiceClip = onRequest(
  {
    invoker: "public",
    cors: false,
  },
  async (req: Request, res: Response) => {
    const clipId = asText(req.query.id);
    if (!/^[a-f0-9]{64}$/.test(clipId)) {
      res.status(404).send("Not found");
      return;
    }
    const doc = await admin
      .firestore()
      .collection(CLIP_COLLECTION)
      .doc(clipId)
      .get();
    const audio = asAudioBuffer(doc.data()?.audio);
    if (!audio) {
      res.status(404).send("Not found");
      return;
    }
    res.set({
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(audio.length),
    });
    res.status(200).send(audio);
  }
);
