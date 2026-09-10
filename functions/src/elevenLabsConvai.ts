import { IncomingMessage } from "node:http";
import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import type { Request, Response } from "express";
import WebSocket from "ws";
import { queueShopSms } from "./smsGateway";

const AGENT_NAME = "NJ Plumbing window confirmation";
const AGENT_PROMPT_VERSION = "tell-window-no-confirm-v1";
const DEFAULT_HEAD_PLUMBER_PHONE = "+18605439082";
const SETTINGS_DOC = "voiceSettings/elevenLabs";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_MODEL = "eleven_flash_v2";

type VoiceConfirmationResponse = "confirmed" | "declined" | "unknown";

type ConfirmationRecord = {
  dispatchDate?: string;
  truckId?: string;
  stopId?: string;
  workOrderId?: string;
  customerName?: string;
  customerPhoneNumber?: string;
  appointmentWindow?: string;
  address?: string;
  routedTo?: string;
  humanCallbackSmsId?: string;
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

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function apiKey(): string {
  return asText(process.env.ELEVENLABS_API_KEY);
}

function companyName(): string {
  return asText(process.env.COMPANY_NAME) || "NJ Plumbing";
}

function headPlumberPhone(): string {
  return asText(process.env.HEAD_PLUMBER_PHONE) || DEFAULT_HEAD_PLUMBER_PHONE;
}

function formatUsPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const ten =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) {
    return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  return value.trim();
}

function buildHeadPlumberSms(
  record: ConfirmationRecord,
  details: string
): string {
  const called =
    asText(record.routedTo) || asText(record.customerPhoneNumber);
  const customerPhone = asText(record.customerPhoneNumber);
  const lines = [
    `${companyName()}: a customer wants the head plumber to call them.`,
    `Called: ${formatUsPhone(called) || "unknown"}`,
  ];
  if (
    customerPhone &&
    called &&
    customerPhone.replace(/\D/g, "") !== called.replace(/\D/g, "")
  ) {
    lines.push(`Customer #: ${formatUsPhone(customerPhone)}`);
  }
  const name = asText(record.customerName);
  if (name) lines.push(`Name: ${name}`);
  const address = asText(record.address);
  if (address) lines.push(`Job: ${address}`);
  const date = record.dispatchDate
    ? formatSpokenDate(record.dispatchDate)
    : "";
  const window = asText(record.appointmentWindow);
  if (date || window) {
    lines.push(`Window: ${[date, window].filter(Boolean).join(", ")}`);
  }
  const workOrder = asText(record.workOrderId);
  if (workOrder) lines.push(`WO: ${workOrder}`);
  if (details) lines.push(`They said: ${details}`);
  return lines.join("\n").slice(0, 1600);
}

function voiceId(): string {
  return asText(process.env.ELEVENLABS_VOICE_ID) || DEFAULT_VOICE_ID;
}

function ttsModel(): string {
  const model = asText(process.env.ELEVENLABS_MODEL) || DEFAULT_MODEL;
  if (model === "eleven_flash_v2_5") return "eleven_flash_v2";
  if (model === "eleven_turbo_v2_5") return "eleven_turbo_v2";
  return model;
}

export function assertElevenLabsConfigured(): void {
  if (!apiKey()) {
    throw new Error(
      "ELEVENLABS_API_KEY is missing. Add it to functions/.env and redeploy functions."
    );
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function confirmationIdFromRequest(request: IncomingMessage): string {
  const fromReq = asText((request as IncomingMessage & { confirmationId?: string }).confirmationId);
  if (fromReq) return fromReq;
  try {
    return (
      new URL(request.url || "", "http://localhost").searchParams.get(
        "confirmationId"
      ) || ""
    );
  } catch {
    return "";
  }
}

async function elevenLabsJson(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    method,
    headers: {
      "xi-api-key": apiKey(),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { status: response.status, data };
}

function agentPrompt(): string {
  return [
    `You are a phone agent for ${companyName()}, a plumbing company.`,
    "You are on a live outbound call to tell the customer their arrival window.",
    "This is an automated AI call. Do not claim to be a specific plumber in person.",
    "Be warm and patient.",
    "Speak clearly. Finish each sentence. Do not trail off.",
    "ElevenLabs turn detection owns pauses: after you finish speaking, wait silently.",
    "Do not fill silence by repeating the window unless they ask you to.",
    "If they need more time, use skip_turn instead of talking over them.",
    "Customer name: {{customer_name}}.",
    "Job address: {{job_address}}.",
    "Appointment date: {{appointment_date}}.",
    "Arrival window: {{appointment_window}}.",
    "Start by greeting them, name the company, and state the date and arrival window as a fact.",
    "Do not ask them to confirm the window. Do not ask if it works. Do not ask yes or no about the time.",
    "After you have told them the window, call record_window_response with confirmed.",
    "Stay on the line. Listen. Answer briefly and kindly if they have questions or talk about the job.",
    "If they ask for plumbing advice or details you cannot know: acknowledge it and say the plumber can go over that on site.",
    "If they want to speak to a real person, the office, a plumber, or a human: say exactly, I will tell our head plumber to contact you as soon as possible. Then call request_human_callback with details covering what they asked for, any plumbing issue they mentioned, and urgency. Stay on the line. Do not hang up.",
    "Do not take payment or change the window yourself.",
    "If they volunteer that the window does not work or they need to reschedule: say the office will call back to reschedule, call record_window_response with declined, then wait.",
    "Do not bring the window up again after you have told them.",
    "Do not hang up after thanks, a question, a pause, or a request for a plumber.",
    "Only after they clearly say goodbye, that's all, nothing else, no thanks, or that they have to go: say a short thank you, then call end_call.",
  ].join(" ");
}

function agentCreatePayload(): Record<string, unknown> {
  return {
    name: AGENT_NAME,
    tags: ["dispatch", "window-confirmation"],
    conversation_config: {
      asr: {
        provider: "scribe_realtime",
        user_input_audio_format: "ulaw_8000",
        keywords: ["yes", "no", "confirm", "reschedule", "window"],
      },
      turn: {
        turn_timeout: 10,
        silence_end_call_timeout: 90,
        turn_eagerness: "patient",
        turn_model: "turn_v3",
        speculative_turn: false,
      },
      tts: {
        model_id: ttsModel(),
        voice_id: voiceId(),
        agent_output_audio_format: "ulaw_8000",
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 0.95,
      },
      conversation: {
        max_duration_seconds: 300,
      },
      agent: {
        first_message:
          "Hi, this is {{company_name}} calling about your plumbing appointment on {{appointment_date}}. We are scheduled to arrive between {{appointment_window}}.",
        language: "en",
        prompt: {
          prompt: agentPrompt(),
          llm: "gpt-4o-mini",
          timezone: "America/New_York",
          tools: [
            {
              type: "client",
              name: "record_window_response",
              description:
                "Call confirmed after you have told them the arrival window. Do not wait for them to say yes. Call declined only if they volunteer that the window does not work or they need to reschedule.",
              expects_response: true,
              parameters: {
                type: "object",
                required: ["response"],
                properties: {
                  response: {
                    type: "string",
                    description: "One of: confirmed, declined, unknown",
                  },
                  details: {
                    type: "string",
                    description: "Short note of what the customer said",
                  },
                },
              },
            },
            {
              type: "client",
              name: "request_human_callback",
              description:
                "Use this when the customer wants a real person, the office, or a plumber to call them. Put what they asked for in details so the head plumber can text-follow up. Do not hang up.",
              expects_response: true,
              parameters: {
                type: "object",
                properties: {
                  details: {
                    type: "string",
                    description:
                      "What they asked for, any plumbing issue they mentioned, and whether it sounded urgent",
                  },
                },
              },
            },
          ],
          built_in_tools: {
            end_call: {
              type: "system",
              name: "end_call",
              description:
                "Hang up only after a short goodbye, and only when the customer clearly said goodbye, that's all, nothing else, no thanks, or they have to go. Do not hang up because they said yes, no, thanks, hello, asked a question, asked for a plumber, paused, or because you already told them the window. Telling them the window is not the end of the call.",
              params: { system_tool_type: "end_call" },
            },
            skip_turn: {
              type: "system",
              name: "skip_turn",
              description:
                "Wait silently when the customer has not finished speaking.",
              params: { system_tool_type: "skip_turn" },
            },
          },
        },
      },
    },
  };
}

async function loadCachedAgentId(): Promise<string> {
  const fromEnv = asText(process.env.ELEVENLABS_AGENT_ID);
  if (fromEnv) return fromEnv;
  const snap = await admin.firestore().doc(SETTINGS_DOC).get();
  return asText(snap.data()?.agentId);
}

async function saveCachedAgentId(agentId: string): Promise<void> {
  await admin.firestore().doc(SETTINGS_DOC).set(
    {
      agentId,
      agentName: AGENT_NAME,
      promptVersion: AGENT_PROMPT_VERSION,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function cachedPromptVersion(): Promise<string> {
  const snap = await admin.firestore().doc(SETTINGS_DOC).get();
  return asText(snap.data()?.promptVersion);
}

async function updateConfirmationAgent(agentId: string): Promise<boolean> {
  const current = await elevenLabsJson(
    "GET",
    `/v1/convai/agents/${encodeURIComponent(agentId)}`
  );
  const branchId = asText(
    current.data.branch_id || current.data.main_branch_id
  );
  const payload = agentCreatePayload();
  const path = branchId
    ? `/v1/convai/agents/${encodeURIComponent(agentId)}?branch_id=${encodeURIComponent(
        branchId
      )}`
    : `/v1/convai/agents/${encodeURIComponent(agentId)}`;
  const { status, data } = await elevenLabsJson("PATCH", path, {
    name: AGENT_NAME,
    conversation_config: payload.conversation_config,
  });
  if (status >= 400) {
    console.error("Could not update ElevenLabs agent", {
      status,
      detail: JSON.stringify(data).slice(0, 400),
    });
    return false;
  }
  const check = await elevenLabsJson(
    "GET",
    `/v1/convai/agents/${encodeURIComponent(agentId)}`
  );
  const prompt = (
    (check.data.conversation_config as Record<string, unknown> | undefined)
      ?.agent as Record<string, unknown> | undefined
  )?.prompt as Record<string, unknown> | undefined;
  const listedTools = Array.isArray(prompt?.tools)
    ? (prompt?.tools as Array<Record<string, unknown>>)
    : [];
  const builtIn = (prompt?.built_in_tools || {}) as Record<string, unknown>;
  const toolNames = listedTools.map((tool) => asText(tool.name));
  console.log("ElevenLabs agent updated", {
    agentId,
    branchId: asText(check.data.branch_id),
    promptVersion: AGENT_PROMPT_VERSION,
    tools: toolNames,
    endCallEnabled: Boolean(builtIn.end_call),
    silence: (check.data.conversation_config as Record<string, unknown> | undefined)
      ? ((check.data.conversation_config as Record<string, unknown>).turn as
          | Record<string, unknown>
          | undefined)?.silence_end_call_timeout
      : undefined,
  });
  return true;
}

async function findExistingAgentId(): Promise<string> {
  const { status, data } = await elevenLabsJson(
    "GET",
    "/v1/convai/agents?page_size=50"
  );
  if (status >= 400) return "";
  const agents = Array.isArray(data.agents)
    ? (data.agents as Array<Record<string, unknown>>)
    : [];
  const match = agents.find((agent) => {
    const nested =
      agent.agent && typeof agent.agent === "object"
        ? (agent.agent as Record<string, unknown>)
        : {};
    const name = asText(agent.name) || asText(nested.name);
    return name === AGENT_NAME;
  });
  if (!match) return "";
  const nested =
    match.agent && typeof match.agent === "object"
      ? (match.agent as Record<string, unknown>)
      : {};
  return (
    asText(match.agent_id) ||
    asText(match.agentId) ||
    asText(nested.agent_id) ||
    asText(nested.agentId)
  );
}

export async function prepareElevenLabsVoice(): Promise<string> {
  assertElevenLabsConfigured();
  return ensureConfirmationAgent();
}

async function ensureConfirmationAgent(): Promise<string> {
  const cached = await loadCachedAgentId();
  const existing = cached || (await findExistingAgentId());
  if (existing) {
    const version = await cachedPromptVersion();
    if (version !== AGENT_PROMPT_VERSION) {
      const updated = await updateConfirmationAgent(existing);
      if (!updated) {
        throw new Error("Could not update the ElevenLabs agent prompt");
      }
      await saveCachedAgentId(existing);
    }
    return existing;
  }
  const { status, data } = await elevenLabsJson(
    "POST",
    "/v1/convai/agents/create",
    agentCreatePayload()
  );
  const agentId = asText(data.agent_id || data.agentId);
  if (status >= 400 || !agentId) {
    throw new Error(
      `Could not create ElevenLabs agent (${status}): ${JSON.stringify(data).slice(
        0,
        400
      )}`
    );
  }
  await saveCachedAgentId(agentId);
  return agentId;
}

async function signedConversationUrl(agentId: string): Promise<string> {
  const paths = [
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    `/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
  ];
  for (const path of paths) {
    const { status, data } = await elevenLabsJson("GET", path);
    const signed = asText(data.signed_url || data.signedUrl);
    if (status < 400 && signed) return signed;
  }
  return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
    agentId
  )}`;
}

async function loadConfirmation(
  confirmationId: string
): Promise<ConfirmationRecord | null> {
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
    voiceProvider: "elevenlabs",
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

async function recordHumanCallback(
  confirmationId: string,
  record: ConfirmationRecord,
  details: string
) {
  const note =
    details.trim() ||
    "Customer asked to speak with a real person. Head plumber should call back.";
  const alreadyTexted = Boolean(asText(record.humanCallbackSmsId));
  let smsId = asText(record.humanCallbackSmsId);
  let smsError = "";
  if (!alreadyTexted) {
    try {
      const queued = await queueShopSms(
        headPlumberPhone(),
        buildHeadPlumberSms(record, note),
        "voice-callback"
      );
      smsId = queued.id;
      record.humanCallbackSmsId = smsId;
    } catch (error) {
      smsError = error instanceof Error ? error.message : String(error);
      console.error("Could not queue head plumber callback SMS", error);
    }
  }
  await admin.firestore().collection("voiceConfirmations").doc(confirmationId).update({
    wantsHumanCallback: true,
    humanCallbackDetails: note,
    ...(smsId ? { humanCallbackSmsId: smsId } : {}),
    ...(smsError ? { humanCallbackSmsError: smsError } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const dispatchDate = asText(record.dispatchDate);
  const truckId = asText(record.truckId);
  const stopId = asText(record.stopId);
  if (!dispatchDate || !truckId || !stopId) return;
  await updateDispatchStopVoiceFields(dispatchDate, truckId, stopId, {
    voiceWantsHumanCallback: true,
    voiceHumanCallbackDetails: note,
  });
}

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendClientToolResult(
  socket: WebSocket | null,
  toolCallId: string,
  result: unknown,
  isError: boolean
) {
  if (!toolCallId || !socket) return;
  sendJson(socket, {
    type: "client_tool_result",
    tool_call_id: toolCallId,
    result: typeof result === "string" ? result : JSON.stringify(result),
    is_error: isError,
  });
}

function initiationPayload(
  record: ConfirmationRecord,
  confirmationId: string
): Record<string, unknown> {
  const spokenDate = record.dispatchDate
    ? formatSpokenDate(record.dispatchDate)
    : "the scheduled date";
  const window = asText(record.appointmentWindow) || "the scheduled window";
  const customer = asText(record.customerName) || "the customer";
  const address = asText(record.address) || "the job address";
  const company = companyName();
  return {
    type: "conversation_initiation_client_data",
    ...(confirmationId ? { user_id: confirmationId } : {}),
    dynamic_variables: {
      customer_name: customer,
      job_address: address,
      appointment_date: spokenDate,
      appointment_window: window,
      company_name: company,
    },
  };
}

function conversationIdFromEvent(event: Record<string, unknown>): string {
  const nested = event.conversation_initiation_metadata_event;
  if (nested && typeof nested === "object") {
    const fromNested = asText(
      (nested as Record<string, unknown>).conversation_id
    );
    if (fromNested) return fromNested;
  }
  return asText(event.conversation_id);
}

async function saveConversationId(
  confirmationId: string,
  record: ConfirmationRecord | null,
  conversationId: string
) {
  if (!confirmationId || !conversationId) return;
  await admin.firestore().collection("voiceConfirmations").doc(confirmationId).set(
    {
      conversationId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  const dispatchDate = asText(record?.dispatchDate);
  const truckId = asText(record?.truckId);
  const stopId = asText(record?.stopId);
  if (!dispatchDate || !truckId || !stopId) return;
  await updateDispatchStopVoiceFields(dispatchDate, truckId, stopId, {
    voiceConfirmationId: confirmationId,
    voiceConversationId: conversationId,
  });
}

async function conversationIdForUser(userId: string): Promise<string> {
  if (!userId) return "";
  const { status, data } = await elevenLabsJson(
    "GET",
    `/v1/convai/conversations?user_id=${encodeURIComponent(userId)}&page_size=10`
  );
  if (status >= 400) return "";
  const conversations = Array.isArray(data.conversations)
    ? (data.conversations as Array<Record<string, unknown>>)
    : [];
  const match = conversations.find((item) => asText(item.conversation_id));
  return match ? asText(match.conversation_id) : "";
}

async function resolveConversationId(
  confirmationId: string,
  storedConversationId: string
): Promise<string> {
  if (storedConversationId) return storedConversationId;
  return conversationIdForUser(confirmationId);
}

async function downloadConversationAudio(
  conversationId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const maxAttempts = 8;
  let lastDetail = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(
        conversationId
      )}/audio`,
      {
        headers: {
          "xi-api-key": apiKey(),
          Accept: "audio/mpeg",
        },
      }
    );
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 80) {
        lastDetail = "empty recording";
      } else {
        return {
          buffer,
          contentType: response.headers.get("content-type") || "audio/mpeg",
        };
      }
    } else {
      lastDetail = (await response.text()).slice(0, 240);
      if (response.status !== 404 && response.status !== 409 && response.status !== 425) {
        throw new Error(
          `Could not download the call recording (${response.status}): ${lastDetail}`
        );
      }
    }
    if (attempt < maxAttempts) {
      await sleep(1500 * attempt);
    }
  }
  throw new Error(
    lastDetail
      ? `The recording is still processing. Try Play call again in a few seconds. (${lastDetail})`
      : "The recording is still processing. Try Play call again in a few seconds."
  );
}

export const playVoiceConfirmationAudio = onRequest(
  {
    cors: true,
    invoker: "public",
    timeoutSeconds: 120,
    memory: "1GiB",
  },
  async (req: Request, res: Response) => {
    try {
      assertElevenLabsConfigured();
      const confirmationId = asText(req.query.confirmationId);
      if (
        !confirmationId ||
        confirmationId.length > 700 ||
        confirmationId.includes("/") ||
        confirmationId.includes("\\")
      ) {
        res.status(400).type("text/plain").send("A confirmation id is required");
        return;
      }
      const snap = await admin
        .firestore()
        .collection("voiceConfirmations")
        .doc(confirmationId)
        .get();
      if (!snap.exists) {
        res.status(404).type("text/plain").send("This confirmation call was not found");
        return;
      }
      const record = snap.data() as ConfirmationRecord & { conversationId?: string };
      const conversationId = await resolveConversationId(
        confirmationId,
        asText(record.conversationId)
      );
      if (!conversationId) {
        res
          .status(404)
          .type("text/plain")
          .send("No recording is available for this call yet. Try again after it finishes.");
        return;
      }
      if (conversationId !== asText(record.conversationId)) {
        await saveConversationId(confirmationId, record, conversationId);
      }
      const download = asText(req.query.download) === "1";
      const audio = await downloadConversationAudio(conversationId);
      const filename = `confirmation-${confirmationId}.mp3`.replace(/[^\w.-]+/g, "_");
      res.setHeader("Content-Type", audio.contentType);
      res.setHeader(
        "Content-Disposition",
        `${download ? "attachment" : "inline"}; filename="${filename}"`
      );
      res.setHeader("Cache-Control", "private, max-age=120");
      res.status(200).send(audio.buffer);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not load this call recording";
      const processing = message.toLowerCase().includes("still processing");
      console.error("playVoiceConfirmationAudio failed", error);
      res.status(processing ? 409 : 502).type("text/plain").send(message);
    }
  }
);

export async function handleElevenLabsTwilioConnection(
  twilioWs: WebSocket,
  request: IncomingMessage
) {
  let confirmationId = confirmationIdFromRequest(request);
  let streamSid = "";
  let callSid = "";
  let closed = false;
  let recordedAnswer = false;
  let record: ConfirmationRecord | null = null;
  let elevenWs: WebSocket | null = null;
  let initiationSent = false;
  let conversationId = "";
  const pendingAudio: string[] = [];

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try {
      if (elevenWs && elevenWs.readyState === WebSocket.OPEN) elevenWs.close();
    } catch {
      // ignore
    }
    try {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {
      // ignore
    }
  };

  const sendInitiation = () => {
    if (initiationSent || !elevenWs || !streamSid) return;
    if (elevenWs.readyState !== WebSocket.OPEN) return;
    initiationSent = true;
    sendJson(elevenWs, initiationPayload(record || {}, confirmationId));
    for (const chunk of pendingAudio) {
      sendJson(elevenWs, { user_audio_chunk: chunk });
    }
    pendingAudio.length = 0;
  };

  const handleClientTool = async (event: {
    client_tool_call?: {
      tool_name?: string;
      tool_call_id?: string;
      parameters?: Record<string, unknown>;
    };
  }) => {
    const call = event.client_tool_call || {};
    const toolName = asText(call.tool_name);
    const toolCallId = asText(call.tool_call_id);
    const params = call.parameters || {};
    let result: unknown = "ok";
    let isError = false;
    try {
      if (toolName === "record_window_response" && confirmationId && record) {
        const response = asText(params.response) as VoiceConfirmationResponse;
        const allowed: VoiceConfirmationResponse[] = [
          "confirmed",
          "declined",
          "unknown",
        ];
        const resolved = allowed.includes(response) ? response : "unknown";
        if (recordedAnswer && resolved !== "declined") {
          result =
            "Already recorded. Do not ask them to confirm the window. Stay on the line. Do not hang up.";
        } else {
          const details =
            asText(params.details) || `ElevenLabs agent recorded ${resolved}`;
          await recordWindowOutcome(confirmationId, record, resolved, details);
          recordedAnswer = true;
          result =
            resolved === "declined"
              ? "Saved. Say the office will call back to reschedule. Stay on the line. Do not hang up."
              : "Saved. Do not ask them to confirm the window. Stay on the line for questions. Do not hang up.";
        }
      } else if (toolName === "request_human_callback" && confirmationId && record) {
        await recordHumanCallback(confirmationId, record, asText(params.details));
        result =
          "Noted. Say exactly: I will tell our head plumber to contact you as soon as possible. Then stay on the line. Do not hang up.";
      }
    } catch (error) {
      console.error("ElevenLabs client tool failed", error);
      isError = true;
      result =
        error instanceof Error ? error.message : "Could not record the answer";
    }
    sendClientToolResult(elevenWs, toolCallId, result, isError);
  };

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
      console.log("Twilio stream started", { confirmationId, streamSid, callSid });
      void loadConfirmation(confirmationId).then((loaded) => {
        record = loaded;
        sendInitiation();
        if (conversationId) {
          void saveConversationId(confirmationId, record, conversationId);
        }
      });
      return;
    }
    if (
      message.event === "media" &&
      message.media?.payload &&
      (!message.media.track || message.media.track === "inbound")
    ) {
      if (elevenWs?.readyState === WebSocket.OPEN && initiationSent) {
        sendJson(elevenWs, { user_audio_chunk: message.media.payload });
      } else if (pendingAudio.length < 200) {
        pendingAudio.push(message.media.payload);
      }
    }
    if (message.event === "stop") {
      console.log("Twilio stream stopped by caller", { confirmationId, callSid });
      closeBoth();
    }
  });
  twilioWs.on("close", () => {
    console.log("Twilio stream socket closed", { confirmationId, callSid });
    closeBoth();
  });
  twilioWs.on("error", (error) => {
    console.error("Twilio media stream error", error);
    closeBoth();
  });

  try {
    const [loaded, agentId] = await Promise.all([
      confirmationId ? loadConfirmation(confirmationId) : Promise.resolve(null),
      prepareElevenLabsVoice(),
    ]);
    record = loaded || record;
    if (conversationId) {
      void saveConversationId(confirmationId, record, conversationId);
    }
    const signedUrl = await signedConversationUrl(agentId);
    elevenWs = new WebSocket(signedUrl);
  } catch (error) {
    console.error("ElevenLabs ConvAI could not start", error);
    closeBoth();
    return;
  }

  elevenWs.on("open", () => {
    console.log("ElevenLabs ConvAI connected", { confirmationId, streamSid });
    sendInitiation();
  });

  elevenWs.on("message", (raw) => {
    let event: Record<string, unknown> & {
      type?: string;
      ping_event?: { event_id?: number };
      audio_event?: { audio_base_64?: string };
      client_tool_call?: {
        tool_name?: string;
        tool_call_id?: string;
        parameters?: Record<string, unknown>;
      };
    };
    try {
      event = JSON.parse(raw.toString()) as typeof event;
    } catch {
      return;
    }
    if (event.type === "ping") {
      sendJson(elevenWs as WebSocket, {
        type: "pong",
        event_id: event.ping_event?.event_id,
      });
      return;
    }
    if (event.type === "audio") {
      const payload = event.audio_event?.audio_base_64;
      if (payload && streamSid) {
        sendJson(twilioWs, {
          event: "media",
          streamSid,
          media: { payload },
        });
      } else {
        console.warn("ElevenLabs audio dropped", {
          hasPayload: Boolean(payload),
          streamSid: streamSid || "(missing)",
        });
      }
      return;
    }
    if (event.type === "interruption" && streamSid) {
      sendJson(twilioWs, { event: "clear", streamSid });
      return;
    }
    if (event.type === "client_error") {
      console.error("ElevenLabs client error", event);
      return;
    }
    if (event.type === "client_tool_call") {
      void handleClientTool(event);
      return;
    }
    if (event.type === "conversation_initiation_metadata") {
      const nextId = conversationIdFromEvent(event);
      if (nextId && nextId !== conversationId) {
        conversationId = nextId;
        console.log("ElevenLabs conversation id", { confirmationId, conversationId });
        void saveConversationId(confirmationId, record, conversationId);
      }
      return;
    }
    if (
      event.type &&
      event.type !== "audio" &&
      event.type !== "ping" &&
      event.type !== "interruption"
    ) {
      console.log("ElevenLabs event", {
        confirmationId,
        type: event.type,
      });
    }
  });

  elevenWs.on("error", (error) => {
    console.error("ElevenLabs ConvAI socket error", error);
  });
  elevenWs.on("close", (code, reason) => {
    console.log("ElevenLabs ConvAI socket closed", {
      confirmationId,
      code,
      reason: reason?.toString(),
    });
    closeBoth();
  });
}
