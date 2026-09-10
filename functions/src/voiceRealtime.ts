import { IncomingMessage } from "node:http";
import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import OpenAI, { InvalidWebhookSignatureError } from "openai";
import WebSocket, { WebSocketServer } from "ws";
import type { Request, Response } from "express";
import { handleElevenLabsTwilioConnection } from "./elevenLabsConvai";

const DEFAULT_REALTIME_MODEL = "gpt-realtime-mini";
const DEFAULT_REALTIME_VOICE = "marin";

type VoiceConfirmationResponse = "confirmed" | "declined" | "unknown";

type ConfirmationRecord = {
  dispatchDate?: string;
  truckId?: string;
  stopId?: string;
  customerName?: string;
  appointmentWindow?: string;
  address?: string;
};

type TwilioStreamMessage = {
  event?: string;
  streamSid?: string;
  start?: {
    streamSid?: string;
    callSid?: string;
    customParameters?: Record<string, string>;
  };
  media?: {
    payload?: string;
    track?: string;
  };
};

const streamServer = new WebSocketServer({ noServer: true });

streamServer.on("connection", (socket, request) => {
  // OpenAI Realtime Media Streams — kept for restore.
  // void handleTwilioMediaConnection(socket, request);
  void handleElevenLabsTwilioConnection(socket, request);
});

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const DEFAULT_STREAM_HOST = "handlevoicemediastream-xdoawm5boq-uc.a.run.app";

export function openaiRealtimeProjectId(): string {
  return asText(process.env.OPENAI_PROJECT_ID);
}

export function openaiRealtimeSipUri(_confirmationId?: string): string {
  const projectId = openaiRealtimeProjectId();
  return `sip:${projectId}@sip.api.openai.com;transport=tls`;
}

function openaiClient(): OpenAI {
  return new OpenAI({
    apiKey: asText(process.env.OPENAI_API_KEY),
    webhookSecret: asText(process.env.OPENAI_WEBHOOK_SECRET) || undefined,
  });
}

export function voiceRealtimeStreamUrl(confirmationId: string): string {
  const configured = asText(process.env.VOICE_MEDIA_STREAM_HOST)
    .replace(/^https?:\/\//, "")
    .replace(/^wss?:\/\//, "")
    .replace(/\/$/, "");
  const host = configured || DEFAULT_STREAM_HOST;
  const query = `confirmationId=${encodeURIComponent(confirmationId)}`;
  const path = host.includes("run.app") ? "" : "/handleVoiceMediaStream";
  return `wss://${host}${path}?${query}`;
}

function realtimeModel(): string {
  return asText(process.env.OPENAI_REALTIME_MODEL) || DEFAULT_REALTIME_MODEL;
}

function realtimeVoice(): string {
  return asText(process.env.OPENAI_REALTIME_VOICE) || DEFAULT_REALTIME_VOICE;
}

function companyName(): string {
  return asText(process.env.COMPANY_NAME) || "NJ Plumbing";
}

function formatSpokenDate(date: string): string {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function confirmationIdFromRequest(request: IncomingMessage): string {
  try {
    return new URL(request.url || "", "http://localhost").searchParams.get(
      "confirmationId"
    ) || "";
  } catch {
    return "";
  }
}

async function loadConfirmation(confirmationId: string): Promise<ConfirmationRecord | null> {
  if (!confirmationId) return null;
  const doc = await admin
    .firestore()
    .collection("voiceConfirmations")
    .doc(confirmationId)
    .get();
  return doc.exists ? (doc.data() as ConfirmationRecord) : null;
}

async function updateDispatchStopVoiceFields(
  dispatchDate: string,
  truckId: string,
  stopId: string,
  fields: Record<string, unknown>
) {
  const planRef = admin.firestore().collection("dispatchPlans").doc(dispatchDate);
  await admin.firestore().runTransaction(async (transaction) => {
    const planDoc = await transaction.get(planRef);
    if (!planDoc.exists) return;
    const plan = planDoc.data() as { trucks?: Array<Record<string, unknown>> };
    const trucks = Array.isArray(plan.trucks) ? plan.trucks : [];
    const nextTrucks = trucks.map((truck) => {
      if (asText(truck.id) !== truckId) return truck;
      const stops = Array.isArray(truck.stops)
        ? (truck.stops as Array<Record<string, unknown>>)
        : [];
      return {
        ...truck,
        stops: stops.map((stop) =>
          asText(stop.id) === stopId ? { ...stop, ...fields } : stop
        ),
      };
    });
    transaction.update(planRef, {
      trucks: nextTrucks,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function recordWindowOutcome(
  confirmationId: string,
  record: ConfirmationRecord,
  response: VoiceConfirmationResponse,
  details: string
) {
  await admin.firestore().collection("voiceConfirmations").doc(confirmationId).update({
    response,
    responseDetails: details,
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const dispatchDate = asText(record.dispatchDate);
  const truckId = asText(record.truckId);
  const stopId = asText(record.stopId);
  if (!dispatchDate || !truckId || !stopId) return;
  await updateDispatchStopVoiceFields(dispatchDate, truckId, stopId, {
    voiceConfirmationResponse: response,
    voiceConfirmationDetails: details,
    voiceConfirmationAt: new Date().toISOString(),
  });
}

function agentInstructions(record: ConfirmationRecord): string {
  const spokenDate = record.dispatchDate
    ? formatSpokenDate(record.dispatchDate)
    : "the scheduled date";
  const window = asText(record.appointmentWindow) || "the scheduled window";
  const customer = asText(record.customerName) || "the customer";
  const address = asText(record.address);
  return [
    `You are a phone agent for ${companyName()}, a plumbing company.`,
    "You are on a live outbound call to tell the customer their arrival window.",
    "This is an automated AI call. Do not claim to be a specific plumber in person.",
    "Speak clearly and slowly. Finish each sentence. Do not trail off.",
    "Say each sentence once. Never restart the greeting or repeat the window unless they ask you to.",
    "Do not hang up. Do not end the call yourself.",
    `Customer name: ${customer}.`,
    address ? `Job address: ${address}.` : "",
    `Appointment date: ${spokenDate}.`,
    `Arrival window: ${window}.`,
    "Start by greeting them, name the company, and state the date and arrival window as a fact.",
    "Do not ask them to confirm the window. Do not ask if it works. Do not ask yes or no about the time.",
    "After you have told them the window, call record_window_response with confirmed.",
    "If they volunteer that it does not work or they need to reschedule: say the office will call them back, then call record_window_response with declined.",
    "Stay on the line after you tell them. Answer questions briefly. Do not hang up.",
    "Never hang up. Never end the call. Wait until the customer hangs up.",
    "Do not take payment, change the window yourself, or give plumbing advice.",
  ]
    .filter(Boolean)
    .join(" ");
}

function voiceTurnDetection(createResponse: boolean) {
  return {
    type: "server_vad",
    threshold: 0.9,
    prefix_padding_ms: 300,
    silence_duration_ms: 800,
    create_response: createResponse,
    interrupt_response: false,
  };
}

function sessionUpdatePayload(record: ConfirmationRecord): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: realtimeModel(),
      output_modalities: ["audio"],
      instructions: agentInstructions(record),
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          noise_reduction: { type: "near_field" },
          turn_detection: voiceTurnDetection(false),
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: realtimeVoice(),
        },
      },
      tools: [
        {
          type: "function",
          name: "record_window_response",
          description:
            "Call confirmed after you have told them the arrival window. Do not wait for them to say yes. Call declined only if they volunteer that the window does not work.",
          parameters: {
            type: "object",
            properties: {
              response: {
                type: "string",
                enum: ["confirmed", "declined", "unknown"],
              },
              details: {
                type: "string",
                description: "Short note of what the customer said.",
              },
            },
            required: ["response"],
          },
        },
      ],
      tool_choice: "auto",
    },
  };
}

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export async function handleTwilioMediaConnection(
  twilioWs: WebSocket,
  request: IncomingMessage
) {
  const apiKey = asText(process.env.OPENAI_API_KEY);
  let confirmationId = confirmationIdFromRequest(request);
  let streamSid = "";
  let callSid = "";
  let closed = false;
  let greetingSent = false;
  let awaitingSession = false;
  let recordedAnswer = false;
  let agentSpeaking = false;
  let listeningEnabled = false;
  let listenTimer: ReturnType<typeof setTimeout> | null = null;
  let record: ConfirmationRecord | null = null;

  if (!apiKey) {
    console.error("OPENAI_API_KEY is missing; leaving stream open");
    return;
  }

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel())}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  const closeOpenAi = () => {
    if (closed) return;
    closed = true;
    if (listenTimer) clearTimeout(listenTimer);
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {
      // ignore
    }
  };

  const clearHeardAudio = () => {
    sendJson(openaiWs, { type: "input_audio_buffer.clear" });
  };

  const setListening = (enabled: boolean) => {
    if (listeningEnabled === enabled) return;
    listeningEnabled = enabled;
    sendJson(openaiWs, {
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            turn_detection: voiceTurnDetection(enabled),
          },
        },
      },
    });
  };

  const muteWhileSpeaking = () => {
    if (listenTimer) {
      clearTimeout(listenTimer);
      listenTimer = null;
    }
    setListening(false);
    if (agentSpeaking) return;
    agentSpeaking = true;
    clearHeardAudio();
  };

  const listenAfterEchoSettles = () => {
    if (listenTimer) clearTimeout(listenTimer);
    clearHeardAudio();
    listenTimer = setTimeout(() => {
      listenTimer = null;
      agentSpeaking = false;
      clearHeardAudio();
      setListening(true);
    }, 800);
  };

  const handleFunctionCall = async (item: {
    name?: string;
    call_id?: string;
    arguments?: string;
  }) => {
    const name = asText(item.name);
    const callId = asText(item.call_id);
    let output: { ok: boolean; message: string } = { ok: true, message: "done" };
    try {
      const args = item.arguments ? JSON.parse(item.arguments) : {};
      if (name === "record_window_response" && confirmationId && record) {
        if (recordedAnswer) {
          output = {
            ok: true,
            message: "Already recorded. Stay on the line. Do not hang up.",
          };
        } else {
          const response = asText(args.response) as VoiceConfirmationResponse;
          const allowed: VoiceConfirmationResponse[] = [
            "confirmed",
            "declined",
            "unknown",
          ];
          const resolved = allowed.includes(response) ? response : "unknown";
          const details =
            asText(args.details) || `Realtime agent recorded ${resolved}`;
          await recordWindowOutcome(confirmationId, record, resolved, details);
          recordedAnswer = true;
          output = {
            ok: true,
            message:
              "Recorded. Stay on the line. If they have more to say, keep listening. Do not hang up.",
          };
        }
      }
    } catch (error) {
      console.error("Realtime tool failed", error);
      output = { ok: true, message: "Could not complete that action" };
    }
    if (callId) {
      muteWhileSpeaking();
      sendJson(openaiWs, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      });
      sendJson(openaiWs, { type: "response.create" });
    }
  };

  openaiWs.on("open", () => {
    console.log("OpenAI Realtime connected", { confirmationId, model: realtimeModel() });
  });

  openaiWs.on("message", (raw) => {
    let event: {
      type?: string;
      delta?: string;
      response?: { output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }> };
    };
    try {
      event = JSON.parse(raw.toString()) as typeof event;
    } catch {
      return;
    }
    if (event.type === "session.updated" && awaitingSession && !greetingSent) {
      awaitingSession = false;
      greetingSent = true;
      muteWhileSpeaking();
      sendJson(openaiWs, {
        type: "response.create",
        response: { tool_choice: "none" },
      });
    }
    if (
      event.type === "response.created" ||
      event.type === "output_audio_buffer.started"
    ) {
      muteWhileSpeaking();
    }
    if (
      (event.type === "response.output_audio.delta" ||
        event.type === "response.audio.delta") &&
      event.delta &&
      streamSid
    ) {
      muteWhileSpeaking();
      sendJson(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: event.delta },
      });
    }
    if (event.type === "output_audio_buffer.stopped") {
      listenAfterEchoSettles();
    }
    if (event.type === "response.done") {
      const outputs = event.response?.output || [];
      for (const item of outputs) {
        if (item?.type === "function_call") {
          void handleFunctionCall(item);
        }
      }
      const hasTool = outputs.some((item) => item?.type === "function_call");
      if (!hasTool) {
        listenAfterEchoSettles();
      }
    }
    if (event.type === "error") {
      const code = (event as { error?: { code?: string } }).error?.code;
      if (code !== "response_cancel_not_active") {
        console.error("OpenAI Realtime error", event);
      }
    }
  });

  openaiWs.on("error", (error) => {
    console.error("OpenAI Realtime socket error", error);
  });
  openaiWs.on("close", (code, reason) => {
    console.error("OpenAI Realtime socket closed", {
      code,
      reason: reason?.toString(),
    });
  });

  twilioWs.on("message", (raw) => {
    let message: TwilioStreamMessage;
    try {
      message = JSON.parse(raw.toString()) as TwilioStreamMessage;
    } catch {
      return;
    }
    if (message.event === "start") {
      streamSid = asText(message.start?.streamSid || message.streamSid);
      callSid = asText(message.start?.callSid);
      confirmationId =
        asText(message.start?.customParameters?.confirmationId) || confirmationId;
      void loadConfirmation(confirmationId).then((loaded) => {
        record = loaded;
        const sendSession = () => {
          awaitingSession = true;
          sendJson(openaiWs, sessionUpdatePayload(loaded || {}));
        };
        if (openaiWs.readyState === WebSocket.OPEN) {
          sendSession();
        } else {
          openaiWs.once("open", sendSession);
        }
      });
      return;
    }
    if (
      message.event === "media" &&
      message.media?.payload &&
      openaiWs.readyState === WebSocket.OPEN &&
      listeningEnabled &&
      !agentSpeaking &&
      (!message.media.track || message.media.track === "inbound")
    ) {
      sendJson(openaiWs, {
        type: "input_audio_buffer.append",
        audio: message.media.payload,
      });
    }
    if (message.event === "stop") {
      console.log("Twilio stream stopped by caller", { confirmationId, callSid });
      closeOpenAi();
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio stream socket closed", { confirmationId, callSid });
    closeOpenAi();
  });
  twilioWs.on("error", (error) => {
    console.error("Twilio media stream error", error);
    closeOpenAi();
  });
}

export const handleVoiceMediaStream = onRequest(
  {
    invoker: "public",
    cors: false,
    timeoutSeconds: 3600,
    memory: "1GiB",
    concurrency: 1,
  },
  (req: Request, res: Response) => {
    console.log("handleVoiceMediaStream request", {
      upgrade: req.headers.upgrade || "",
      url: req.url,
      query: req.query,
    });
    if (String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
      res.status(426).type("text/plain").send("Expected WebSocket upgrade");
      return;
    }
    const confirmationId = asText(
      Array.isArray(req.query?.confirmationId)
        ? req.query.confirmationId[0]
        : req.query?.confirmationId
    );
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      streamServer.handleUpgrade(
        req as unknown as IncomingMessage,
        req.socket,
        Buffer.alloc(0),
        (socket) => {
          (req as IncomingMessage & { confirmationId?: string }).confirmationId =
            confirmationId;
          socket.once("close", finish);
          socket.once("error", finish);
          streamServer.emit("connection", socket, req);
        }
      );
    });
  }
);

function sipHeaderValue(
  headers: Array<{ name?: string; value?: string }>,
  headerName: string
): string {
  const wanted = headerName.toLowerCase();
  for (const header of headers) {
    if (asText(header.name).toLowerCase() === wanted) {
      return asText(header.value);
    }
  }
  return "";
}

function confirmationIdFromSipHeaders(
  headers: Array<{ name?: string; value?: string }>
): string {
  const direct =
    sipHeaderValue(headers, "x-confirmationid") ||
    sipHeaderValue(headers, "x-confirmation-id");
  if (direct) return direct;
  const toHeader = sipHeaderValue(headers, "to");
  const match = toHeader.match(/x-confirmationid=([^;&>\s]+)/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return "";
}

async function latestPendingConfirmation(): Promise<{
  id: string;
  record: ConfirmationRecord;
} | null> {
  const snap = await admin
    .firestore()
    .collection("voiceConfirmations")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const createdAt = doc.get("createdAt") as { toMillis?: () => number } | null;
  const createdMs = createdAt?.toMillis?.() || 0;
  if (createdMs && Date.now() - createdMs > 3 * 60 * 1000) return null;
  return { id: doc.id, record: doc.data() as ConfirmationRecord };
}

function sipAcceptPayload(record: ConfirmationRecord): Record<string, unknown> {
  return {
    type: "realtime",
    model: realtimeModel(),
    output_modalities: ["audio"],
    instructions: agentInstructions(record),
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        turn_detection: voiceTurnDetection(false),
      },
      output: {
        voice: realtimeVoice(),
      },
    },
    tools: [
      {
        type: "function",
        name: "record_window_response",
        description:
          "Call confirmed after you have told them the arrival window. Do not wait for them to say yes. Call declined only if they volunteer that the window does not work.",
        parameters: {
          type: "object",
          properties: {
            response: {
              type: "string",
              enum: ["confirmed", "declined", "unknown"],
            },
            details: {
              type: "string",
              description: "Short note of what the customer said.",
            },
          },
          required: ["response"],
        },
      },
    ],
    tool_choice: "auto",
  };
}

function requestPayload(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body || {});
}

async function attachSipSideband(
  client: OpenAI,
  callId: string,
  confirmationId: string,
  record: ConfirmationRecord
): Promise<void> {
  const apiKey = asText(process.env.OPENAI_API_KEY);
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  let recordedAnswer = false;
  let greetingSent = false;
  let listeningEnabled = false;
  let listenTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeardAudio = () => {
    sendJson(openaiWs, { type: "input_audio_buffer.clear" });
  };

  const setListening = (enabled: boolean) => {
    if (listeningEnabled === enabled) return;
    listeningEnabled = enabled;
    sendJson(openaiWs, {
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            turn_detection: voiceTurnDetection(enabled),
          },
        },
      },
    });
  };

  const muteWhileSpeaking = () => {
    if (listenTimer) {
      clearTimeout(listenTimer);
      listenTimer = null;
    }
    if (!listeningEnabled && !listenTimer) {
      clearHeardAudio();
      return;
    }
    clearHeardAudio();
    setListening(false);
  };

  const listenAfterEchoSettles = () => {
    if (listenTimer) clearTimeout(listenTimer);
    clearHeardAudio();
    listenTimer = setTimeout(() => {
      listenTimer = null;
      clearHeardAudio();
      setListening(true);
    }, 700);
  };

  const startGreeting = () => {
    if (greetingSent) return;
    greetingSent = true;
    muteWhileSpeaking();
    sendJson(openaiWs, { type: "response.create" });
  };

  const handleFunctionCall = async (item: {
    name?: string;
    call_id?: string;
    arguments?: string;
  }) => {
    const name = asText(item.name);
    const toolCallId = asText(item.call_id);
    let output = { ok: true as const, message: "done" };
    try {
      const args = item.arguments ? JSON.parse(item.arguments) : {};
      if (name === "record_window_response" && confirmationId && record) {
        if (recordedAnswer) {
          output = {
            ok: true,
            message: "Already recorded. Stay on the line. Do not hang up.",
          };
        } else {
        const response = asText(args.response) as VoiceConfirmationResponse;
        const allowed: VoiceConfirmationResponse[] = [
          "confirmed",
          "declined",
          "unknown",
        ];
        const resolved = allowed.includes(response) ? response : "unknown";
        const details =
          asText(args.details) || `Realtime agent recorded ${resolved}`;
        await recordWindowOutcome(confirmationId, record, resolved, details);
        recordedAnswer = true;
        output = {
          ok: true,
          message:
            "Recorded. Stay on the line. Do not hang up or say goodbye as if the call is over.",
        };
        }
      }
    } catch (error) {
      console.error("Realtime SIP tool failed", error);
      output = { ok: true, message: "Could not complete that action" };
    }
    if (toolCallId) {
      muteWhileSpeaking();
      setTimeout(() => {
        sendJson(openaiWs, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: toolCallId,
            output: JSON.stringify(output),
          },
        });
        sendJson(openaiWs, { type: "response.create" });
      }, 1200);
    }
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (listenTimer) clearTimeout(listenTimer);
      resolve();
    };
    const openTimer = setTimeout(() => {
      if (openaiWs.readyState !== WebSocket.OPEN) {
        console.error("OpenAI SIP sideband did not open", { callId });
        try {
          openaiWs.close();
        } catch {
          // ignore
        }
        finish();
      }
    }, 20000);
    openaiWs.on("open", () => {
      clearTimeout(openTimer);
      console.log("OpenAI SIP sideband connected", {
        callId,
        confirmationId,
        model: realtimeModel(),
      });
      setTimeout(startGreeting, 400);
    });
    openaiWs.on("message", (raw) => {
      let event: {
        type?: string;
        response?: {
          output?: Array<{
            type?: string;
            name?: string;
            call_id?: string;
            arguments?: string;
          }>;
        };
      };
      try {
        event = JSON.parse(raw.toString()) as typeof event;
      } catch {
        return;
      }
      if (event.type === "session.created") {
        startGreeting();
      }
      if (
        event.type === "response.created" ||
        event.type === "output_audio_buffer.started"
      ) {
        greetingSent = true;
        muteWhileSpeaking();
      }
      if (event.type === "output_audio_buffer.stopped") {
        listenAfterEchoSettles();
      }
      if (event.type === "response.done") {
        const outputs = event.response?.output || [];
        for (const item of outputs) {
          if (item?.type === "function_call") {
            void handleFunctionCall(item);
          }
        }
        const hasTool = outputs.some((item) => item?.type === "function_call");
        if (!hasTool) {
          listenAfterEchoSettles();
        }
      }
      if (event.type === "error") {
        const code = (event as { error?: { code?: string } }).error?.code;
        if (code !== "response_cancel_not_active") {
          console.error("OpenAI SIP realtime error", event);
        }
      }
    });
    openaiWs.on("error", (error) => {
      console.error("OpenAI SIP sideband error", error);
    });
    openaiWs.on("close", (code, reason) => {
      console.log("OpenAI SIP sideband closed", {
        callId,
        code,
        reason: reason?.toString(),
      });
      finish();
    });
  });
}

export const handleOpenAiRealtimeWebhook = onRequest(
  {
    invoker: "public",
    cors: false,
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (req: Request, res: Response) => {
    if (req.method === "GET") {
      res.status(200).type("text/plain").send("OpenAI Realtime SIP webhook");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).type("text/plain").send("Method not allowed");
      return;
    }

    const payload = requestPayload(req);
    let payloadType = "";
    try {
      payloadType = asText(JSON.parse(payload).type);
    } catch {
      payloadType = "";
    }
    console.log("OpenAI SIP webhook request", {
      method: req.method,
      hasSignature: Boolean(req.headers["webhook-signature"]),
      payloadType,
      payloadBytes: payload.length,
    });
    const client = openaiClient();
    const webhookSecret = asText(process.env.OPENAI_WEBHOOK_SECRET);
    let event: {
      type?: string;
      data?: {
        call_id?: string;
        sip_headers?: Array<{ name?: string; value?: string }>;
      };
    };
    try {
      if (webhookSecret) {
        event = (await client.webhooks.unwrap(
          payload,
          req.headers
        )) as typeof event;
      } else {
        console.warn("OPENAI_WEBHOOK_SECRET is missing; skipping signature check");
        event = JSON.parse(payload) as typeof event;
      }
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        console.error("OpenAI SIP webhook signature invalid");
        res.status(400).type("text/plain").send("Invalid signature");
        return;
      }
      console.error("OpenAI SIP webhook parse failed", error);
      res.status(400).type("text/plain").send("Invalid payload");
      return;
    }

    if (event.type !== "realtime.call.incoming") {
      res.status(200).type("text/plain").send("ignored");
      return;
    }

    const callId = asText(event.data?.call_id);
    if (!callId) {
      res.status(400).type("text/plain").send("Missing call_id");
      return;
    }

    const headers = event.data?.sip_headers || [];
    let confirmationId = confirmationIdFromSipHeaders(headers);
    let record = confirmationId ? await loadConfirmation(confirmationId) : null;
    if (!record) {
      const pending = await latestPendingConfirmation();
      if (pending) {
        confirmationId = pending.id;
        record = pending.record;
      }
    }

    if (!record || !confirmationId) {
      console.error("OpenAI SIP call had no matching confirmation", {
        callId,
        headers,
      });
      try {
        await client.realtime.calls.reject(callId, { status_code: 486 });
      } catch (error) {
        console.error("Could not reject unmatched SIP call", error);
      }
      res.status(200).type("text/plain").send("rejected");
      return;
    }

    try {
      await client.realtime.calls.accept(
        callId,
        sipAcceptPayload(record) as unknown as Parameters<
          OpenAI["realtime"]["calls"]["accept"]
        >[1]
      );
    } catch (error) {
      console.error("OpenAI SIP accept failed", error);
      try {
        await client.realtime.calls.reject(callId, { status_code: 500 });
      } catch {
        // ignore
      }
      res.status(500).type("text/plain").send("accept failed");
      return;
    }

    await admin
      .firestore()
      .collection("voiceConfirmations")
      .doc(confirmationId)
      .update({
        openaiCallId: callId,
        callStatus: "in-progress",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    await admin.firestore().collection("voiceSipSessions").doc(callId).set({
      confirmationId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("OpenAI SIP call accepted", { callId, confirmationId });
    res.status(200).type("text/plain").send("accepted");
  }
);

export const handleOpenAiSipSession = onDocumentCreated(
  {
    document: "voiceSipSessions/{callId}",
    timeoutSeconds: 540,
    memory: "1GiB",
    retry: false,
  },
  async (event) => {
    const callId = asText(event.params.callId);
    const confirmationId = asText(event.data?.data()?.confirmationId);
    if (!callId || !confirmationId) {
      console.error("OpenAI SIP session missing ids", { callId, confirmationId });
      return;
    }
    const record = (await loadConfirmation(confirmationId)) || {};
    const client = openaiClient();
    console.log("OpenAI SIP sideband starting", { callId, confirmationId });
    try {
      await attachSipSideband(client, callId, confirmationId, record);
    } catch (error) {
      console.error("OpenAI SIP sideband failed", error);
    }
  }
);
