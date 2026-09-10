import { useEffect, useRef, useState } from 'react';
import {
  createVoiceAgentSession,
  reindexVoiceKnowledge,
  runVoiceAgentTool,
  subscribeVoiceKnowledgeStatus,
  type VoiceKnowledgeStatus,
} from '../services/voiceAgentService';
import './VoiceAgent.css';

type AgentState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';
type TranscriptLine = { id: string; role: 'you' | 'agent' | 'tool'; text: string };

type RealtimeEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string } | string;
  response?: { output?: Array<Record<string, unknown>> };
  item?: { call_id?: string; name?: string; arguments?: string };
};

function lineId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function statusLabel(state: AgentState, live: boolean): string {
  if (!live) return 'Ready';
  if (state === 'connecting') return 'Connecting';
  if (state === 'speaking') return 'Speaking';
  if (state === 'listening') return 'Listening';
  if (state === 'thinking') return 'Looking up records';
  return 'Live';
}

function formatIndexTime(value?: string): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

type Spark = { angle: number; radius: number; life: number; spin: number; size: number };

const GOLD = { r: 226, g: 183, b: 20 };
const GOLD_HI = { r: 245, g: 215, b: 110 };
const LISTEN = { r: 126, g: 170, b: 146 };
const sparks: Spark[] = [];
let smoothedLevel = 0;
let smoothedWave: number[] = [];

function rgba(color: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function mixRgb(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number
) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function rmsFromAnalyser(analyser: AnalyserNode, buffer: Uint8Array): number {
  analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const centered = (buffer[i] - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / buffer.length);
}

function fillFrequency(analyser: AnalyserNode, buffer: Uint8Array): void {
  analyser.getByteFrequencyData(buffer as Uint8Array<ArrayBuffer>);
}

function drawOrb(
  canvas: HTMLCanvasElement,
  opts: {
    level: number;
    speaking: boolean;
    listening: boolean;
    thinking: boolean;
    connecting: boolean;
    live: boolean;
    waveform: Uint8Array;
    spectrum: Uint8Array;
  }
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = 320;
  if (canvas.width !== css * dpr) {
    canvas.width = css * dpr;
    canvas.height = css * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = css / 2;
  const cy = css / 2;
  const t = performance.now() / 1000;
  const breathe = 0.5 + Math.sin(t * 1.15) * 0.5;
  const target =
    opts.connecting ? 0.22 + breathe * 0.08
    : opts.live
      ? Math.max(opts.level, opts.speaking ? 0.18 : opts.listening ? 0.12 : 0.08)
      : 0.07 + breathe * 0.04;
  smoothedLevel += (target - smoothedLevel) * 0.16;
  const level = smoothedLevel;
  const accent = opts.listening ? mixRgb(GOLD, LISTEN, 0.55) : GOLD;
  const accentHi = opts.listening ? mixRgb(GOLD_HI, LISTEN, 0.35) : GOLD_HI;

  ctx.clearRect(0, 0, css, css);

  const halo = ctx.createRadialGradient(cx, cy, 18, cx, cy, 150);
  halo.addColorStop(0, rgba(accentHi, 0.16 + level * 0.28));
  halo.addColorStop(0.45, rgba(accent, 0.07 + level * 0.1));
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, 150, 0, Math.PI * 2);
  ctx.fill();

  const tickR = 128;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(opts.connecting ? t * 0.7 : t * 0.04);
  for (let i = 0; i < 72; i += 1) {
    const major = i % 6 === 0;
    const a = (i / 72) * Math.PI * 2;
    const inner = tickR - (major ? 9 : 4);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * tickR, Math.sin(a) * tickR);
    ctx.strokeStyle = rgba(accent, major ? 0.38 : 0.12);
    ctx.lineWidth = major ? 1.2 : 0.7;
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, tickR, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(accent, 0.22);
  ctx.lineWidth = 1;
  ctx.stroke();

  if (opts.connecting) {
    ctx.beginPath();
    ctx.arc(cx, cy, 118, t * 2.4, t * 2.4 + Math.PI * 0.55);
    ctx.strokeStyle = rgba(accentHi, 0.85);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 110, -t * 1.6, -t * 1.6 + Math.PI * 0.28);
    ctx.strokeStyle = rgba(accent, 0.4);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  if (opts.thinking && !opts.speaking) {
    for (let i = 0; i < 3; i += 1) {
      const a = t * (0.9 + i * 0.35) + i * 2.1;
      const r = 96 + i * 8;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = rgba(accentHi, 0.85 - i * 0.18);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r, a - 0.35, a + 0.08);
      ctx.strokeStyle = rgba(accent, 0.35);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  const spectrumBars = opts.speaking || opts.listening ? 48 : 0;
  if (spectrumBars > 0 && opts.spectrum.length > 0) {
    const inner = 78;
    const outer = 114;
    for (let i = 0; i < spectrumBars; i += 1) {
      const bin = opts.spectrum[Math.floor((i / spectrumBars) * Math.min(opts.spectrum.length * 0.45, 90))] || 0;
      const mag = (bin / 255) * (0.35 + level);
      const a = (i / spectrumBars) * Math.PI * 2 - Math.PI / 2;
      const r0 = inner;
      const r1 = inner + (outer - inner) * mag;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.strokeStyle = rgba(accent, 0.12 + mag * 0.55);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  const waveCount = 120;
  if (smoothedWave.length !== waveCount) {
    smoothedWave = Array.from({ length: waveCount }, () => 0);
  }
  const useWave = opts.live && (opts.speaking || opts.listening) && opts.waveform.length > 0;
  ctx.beginPath();
  for (let i = 0; i <= waveCount; i += 1) {
    const sampleIndex = Math.floor((i % waveCount) * (opts.waveform.length / waveCount));
    const raw = useWave ? (opts.waveform[sampleIndex] - 128) / 128 : Math.sin(t * 1.4 + i * 0.18) * 0.12;
    smoothedWave[i % waveCount] += (raw - smoothedWave[i % waveCount]) * 0.22;
    const a = (i / waveCount) * Math.PI * 2 - Math.PI / 2;
    const amp = (opts.speaking ? 22 : opts.listening ? 14 : 6) * (0.35 + level);
    const r = 86 + smoothedWave[i % waveCount] * amp;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = rgba(accent, opts.speaking ? 0.1 + level * 0.08 : 0.04);
  ctx.fill();
  ctx.strokeStyle = rgba(accentHi, 0.55 + level * 0.35);
  ctx.lineWidth = opts.speaking ? 1.8 : 1.15;
  ctx.stroke();

  if (opts.speaking && level > 0.12 && sparks.length < 28) {
    sparks.push({
      angle: Math.random() * Math.PI * 2,
      radius: 88 + Math.random() * 18,
      life: 1,
      spin: (Math.random() - 0.5) * 0.8,
      size: 0.8 + Math.random() * 1.4,
    });
  }
  for (let i = sparks.length - 1; i >= 0; i -= 1) {
    const spark = sparks[i];
    spark.life -= 0.018;
    spark.angle += spark.spin * 0.016;
    spark.radius += opts.speaking ? 0.35 : 0.12;
    if (spark.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(spark.angle) * spark.radius,
      cy + Math.sin(spark.angle) * spark.radius,
      spark.size,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = rgba(accentHi, spark.life * 0.85);
    ctx.fill();
  }

  const core = 36 + level * 10;
  const sphere = ctx.createRadialGradient(
    cx - core * 0.28,
    cy - core * 0.34,
    3,
    cx,
    cy,
    core * 1.2
  );
  sphere.addColorStop(0, '#fff6c8');
  sphere.addColorStop(0.18, rgba(accentHi, 1));
  sphere.addColorStop(0.55, rgba(accent, 0.95));
  sphere.addColorStop(1, opts.listening ? '#1f3d32' : '#2a2208');
  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.fillStyle = sphere;
  ctx.shadowColor = rgba(accent, 0.45 + level * 0.4);
  ctx.shadowBlur = 22 + level * 26;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  ctx.arc(cx, cy, core, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(accentHi, 0.55);
  ctx.lineWidth = 1.25;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx - core * 0.22, cy - core * 0.28, core * 0.34, core * 0.18, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fill();

  const pupil = 7 + level * 5;
  ctx.beginPath();
  ctx.arc(cx, cy, pupil, 0, Math.PI * 2);
  ctx.fillStyle = rgba(accentHi, 0.35 + breathe * 0.2);
  ctx.fill();
}

export default function VoiceAgent() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const pendingRef = useRef<Record<string, { name: string; args: string }>>({});
  const handledRef = useRef(new Set<string>());
  const agentLineRef = useRef<string | null>(null);
  const textsRef = useRef<Record<string, string>>({});
  const eventHandlerRef = useRef<(event: RealtimeEvent) => void>(() => undefined);

  const [live, setLive] = useState(false);
  const [state, setState] = useState<AgentState>('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [knowledge, setKnowledge] = useState<VoiceKnowledgeStatus | null>(null);

  useEffect(() => {
    return subscribeVoiceKnowledgeStatus(setKnowledge);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const remoteBuf = new Uint8Array(1024);
    const micBuf = new Uint8Array(1024);
    const remoteSpec = new Uint8Array(512);
    const micSpec = new Uint8Array(512);
    const tick = () => {
      const remote = remoteAnalyserRef.current
        ? rmsFromAnalyser(remoteAnalyserRef.current, remoteBuf)
        : 0;
      const mic = micAnalyserRef.current ? rmsFromAnalyser(micAnalyserRef.current, micBuf) : 0;
      const speaking = state === 'speaking';
      const listening = state === 'listening';
      const waveform = speaking
        ? remoteBuf
        : listening
          ? micBuf
          : remoteBuf;
      if (speaking && remoteAnalyserRef.current) {
        fillFrequency(remoteAnalyserRef.current, remoteSpec);
      } else if (listening && micAnalyserRef.current) {
        fillFrequency(micAnalyserRef.current, micSpec);
      }
      const level = speaking
        ? Math.min(1, remote * 4.2)
        : listening
          ? Math.min(1, mic * 3.4)
          : Math.min(1, remote * 2);
      drawOrb(canvas, {
        level,
        speaking,
        listening,
        thinking: state === 'thinking',
        connecting: state === 'connecting',
        live,
        waveform,
        spectrum: speaking ? remoteSpec : listening ? micSpec : remoteSpec,
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [live, state]);

  useEffect(() => {
    return () => {
      void stopSession();
    };
    // Hang up if this tab unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushLine = (role: TranscriptLine['role'], text: string, id?: string) => {
    const nextId = id || lineId();
    setLines((current) => {
      const existing = current.find((line) => line.id === nextId);
      if (existing) {
        return current.map((line) => (line.id === nextId ? { ...line, text } : line));
      }
      return [...current, { id: nextId, role, text }];
    });
    return nextId;
  };

  const sendEvent = (payload: Record<string, unknown>) => {
    const channel = dcRef.current;
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify(payload));
    }
  };

  const finishTool = async (callId: string, name: string, rawArgs: unknown) => {
    if (!callId || handledRef.current.has(callId)) return;
    handledRef.current.add(callId);
    setState('thinking');
    pushLine('tool', `Working on ${name.replace(/_/g, ' ')}…`, `tool-${callId}`);
    try {
      const output = await runVoiceAgentTool(name, parseArgs(rawArgs));
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      });
      sendEvent({ type: 'response.create' });
      const record = output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
      const summary =
        asText(record.speakThis) ||
        asText(record.error) ||
        asText(record.note) ||
        `Used ${name.replace(/_/g, ' ')}`;
      pushLine('tool', summary, `tool-${callId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lookup failed';
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ error: message }),
        },
      });
      sendEvent({ type: 'response.create' });
      pushLine('tool', message, `tool-${callId}`);
    }
  };

  const handleRealtimeEvent = (event: RealtimeEvent) => {
    const type = asText(event.type);
    if (type === 'input_audio_buffer.speech_started') {
      setState('listening');
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      setState((current) => (current === 'speaking' ? current : 'thinking'));
      return;
    }
    if (type === 'output_audio_buffer.started' || type === 'response.output_audio.delta') {
      setState('speaking');
      return;
    }
    if (type === 'output_audio_buffer.stopped') {
      setState('listening');
      agentLineRef.current = null;
      return;
    }
    if (type === 'response.output_audio_transcript.delta' && event.delta) {
      setState('speaking');
      const id = agentLineRef.current || lineId();
      agentLineRef.current = id;
      textsRef.current[id] = `${textsRef.current[id] || ''}${event.delta}`;
      pushLine('agent', textsRef.current[id], id);
      return;
    }
    if (type === 'response.function_call_arguments.delta' && event.call_id) {
      const current = pendingRef.current[event.call_id] || { name: event.name || '', args: '' };
      current.args += event.delta || '';
      if (event.name) current.name = event.name;
      pendingRef.current[event.call_id] = current;
      return;
    }
    if (type === 'response.function_call_arguments.done' && event.call_id) {
      const pending = pendingRef.current[event.call_id];
      void finishTool(
        event.call_id,
        event.name || pending?.name || '',
        event.arguments || pending?.args || '{}'
      );
      return;
    }
    if (type === 'response.done') {
      for (const item of event.response?.output || []) {
        if (asText(item.type) !== 'function_call') continue;
        void finishTool(
          asText(item.call_id),
          asText(item.name),
          item.arguments
        );
      }
      return;
    }
    if (type === 'error') {
      const message =
        typeof event.error === 'string'
          ? event.error
          : asText(event.error?.message) || 'Realtime error';
      setError(message);
    }
  };
  eventHandlerRef.current = handleRealtimeEvent;

  const attachAnalyser = (stream: MediaStream, remote: boolean) => {
    const ctx = audioCtxRef.current || new AudioContext();
    audioCtxRef.current = ctx;
    void ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    if (remote) remoteAnalyserRef.current = analyser;
    else micAnalyserRef.current = analyser;
  };

  const stopSession = async () => {
    cancelAnimationFrame(rafRef.current);
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    await audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    remoteAnalyserRef.current = null;
    micAnalyserRef.current = null;
    pendingRef.current = {};
    handledRef.current.clear();
    setLive(false);
    setState('idle');
    setBusy(false);
  };

  const startSession = async () => {
    setError('');
    setBusy(true);
    setState('connecting');
    try {
      const session = await createVoiceAgentSession();
      if (session.knowledge) setKnowledge(session.knowledge);
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      const audio = audioRef.current || new Audio();
      audio.autoplay = true;
      audioRef.current = audio;
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        remoteStreamRef.current = stream;
        audio.srcObject = stream;
        void audio.play().catch(() => undefined);
        attachAnalyser(stream, true);
      };
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStreamRef.current = mic;
      mic.getTracks().forEach((track) => pc.addTrack(track, mic));
      attachAnalyser(mic, false);
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;
      dc.addEventListener('open', () => {
        setLive(true);
        setState('listening');
        setBusy(false);
      });
      dc.addEventListener('message', (event) => {
        try {
          eventHandlerRef.current(JSON.parse(String(event.data)) as RealtimeEvent);
        } catch {
          // ignore malformed realtime frames
        }
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      let sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
      });
      if (sdpResponse.status === 404) {
        sdpResponse = await fetch(
          `https://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`,
          {
            method: 'POST',
            body: offer.sdp,
            headers: {
              Authorization: `Bearer ${session.clientSecret}`,
              'Content-Type': 'application/sdp',
            },
          }
        );
      }
      const answer = await sdpResponse.text();
      if (!sdpResponse.ok) {
        throw new Error(answer.slice(0, 240) || `Realtime connect failed (${sdpResponse.status})`);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (err) {
      await stopSession();
      setError(err instanceof Error ? err.message : 'Could not start the voice agent');
    }
  };

  const toggle = () => {
    if (live || busy) {
      void stopSession();
      return;
    }
    void startSession();
  };

  const reindex = async () => {
    setIndexBusy(true);
    setError('');
    try {
      setKnowledge(await reindexVoiceKnowledge());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Indexing failed');
    } finally {
      setIndexBusy(false);
    }
  };

  return (
    <div className="voice-agent">
      <section className="voice-agent__stage">
        <div className="voice-agent__copy">
          <h2>Voice Agent</h2>
          <p>
            Talk to the office assistant. It can look up the board, set up the trucks
            from Ready, put a job on a truck, text a plumber or customer from the shop
            phone, and cancel a job after you confirm.
          </p>
        </div>
        <div
          className={`voice-orb voice-orb--${state}${live ? ' is-live' : ''}`}
          aria-hidden="true"
        >
          <canvas ref={canvasRef} />
        </div>
        <div className={`voice-agent__status${error ? ' is-error' : ''}`}>
          <span className={`voice-agent__pip voice-agent__pip--${error ? 'error' : state}`} />
          {error || statusLabel(state, live || busy)}
        </div>
        <div className="voice-agent__actions">
          <button
            type="button"
            className={`voice-agent__talk${live ? ' is-live' : ''}`}
            onClick={toggle}
          >
            {live || busy ? 'Hang up' : 'Talk'}
          </button>
        </div>
        <audio ref={audioRef} autoPlay hidden />
      </section>
      <aside className="voice-agent__side">
        <div className="voice-agent__card">
          <h3>Company data</h3>
          <p>
            {knowledge?.status === 'running'
              ? 'Indexing Firebase into embeddings…'
              : `${knowledge?.documentCount ?? 0} records · ${knowledge?.chunkCount ?? 0} chunks`}
          </p>
          <small>Last full index: {formatIndexTime(knowledge?.lastIndexedAt)}</small>
          {knowledge?.error ? <p>{knowledge.error}</p> : null}
          <button type="button" onClick={() => void reindex()} disabled={indexBusy || knowledge?.status === 'running'}>
            {indexBusy || knowledge?.status === 'running' ? 'Indexing…' : 'Index company data'}
          </button>
        </div>
        <div className="voice-agent__card voice-agent__log">
          <h3>Transcript</h3>
          {lines.length === 0 ? (
            <p className="voice-agent__empty">Press Talk, then ask about today&apos;s board, say &ldquo;set up the trucks,&rdquo; text someone, or cancel a job. Only the agent&apos;s words are written here.</p>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={`voice-agent__line voice-agent__line--${line.role}`}>
                <span>{line.role === 'you' ? 'You' : line.role === 'tool' ? 'Records' : 'Agent'}</span>
                {line.text}
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
