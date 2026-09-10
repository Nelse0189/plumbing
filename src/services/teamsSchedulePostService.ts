import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import type { PlaudCall, StoredWorkOrder } from '../types';
import {
  postChannelMessage,
  replyToChannelMessage,
} from '../teams-test/graphClient';
import { parseJobAddress } from '../utils/heatersWorkOrder';
import { formatCustomerPhone, parseCustomerPhones } from '../utils/customerPhones';
import type { TeamsWatchTarget } from './teamsWatchService';

const PLAUD_CALLS_COLLECTION = 'plaudCalls';
const WORK_ORDERS_COLLECTION = 'workOrders';

export interface TeamsScheduleDestination {
  kind: 'reply' | 'channel';
  teamId: string;
  channelId: string;
  channelName: string;
  messageId?: string;
}

export interface TeamsScheduleDispatchContext {
  truckName?: string;
  windowLabel?: string;
}

export interface TeamsSchedulePostDraft {
  call: PlaudCall;
  workOrder: StoredWorkOrder | null;
  destination: TeamsScheduleDestination | null;
  destinationError?: string;
  jobLabel: string;
  subject: string;
  html: string;
  text: string;
  alreadyPostedAt?: string;
}

function asText(value?: string | null): string {
  return (value || '').trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === '&'
      ? '&amp;'
      : char === '<'
        ? '&lt;'
        : char === '>'
          ? '&gt;'
          : char === '"'
            ? '&quot;'
            : '&#39;'
  );
}

function formatLongDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function plumberWorkOrderNumber(value?: string | null): string {
  const text = asText(value);
  if (!text || /^plaud-/i.test(text) || !/\d{4,}/.test(text)) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  return text;
}

function plumberTown(address: string): string {
  const parsed = parseJobAddress(address);
  return asText(parsed.city);
}

function jobIdentityLabel(input: {
  workOrderNumber: string;
  customer: string;
  address: string;
  town: string;
}): string {
  const wo = input.workOrderNumber ? `WO ${input.workOrderNumber}` : '';
  const where = input.town || input.address;
  return [wo, input.customer, where].filter(Boolean).join(' — ') || 'Schedule note';
}

function factLine(label: string, value: string): string {
  const trimmed = asText(value);
  return trimmed ? `${label}: ${trimmed}` : '';
}

function htmlFact(label: string, value: string): string {
  const trimmed = asText(value);
  if (!trimmed) return '';
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(trimmed)}</p>`;
}

export function callHasScheduleForTeams(call: PlaudCall): boolean {
  if (call.status === 'in_plaud' || call.status === 'awaiting_transcript' || call.status === 'processing') {
    return false;
  }
  return Boolean(
    asText(call.appointmentDate) ||
      call.appointmentMade ||
      asText(call.summary) ||
      asText(call.plaudSummary)
  );
}

export function resolveTeamsScheduleDestination(
  workOrder: StoredWorkOrder | null,
  watch: TeamsWatchTarget | null
): TeamsScheduleDestination | null {
  const teamId = asText(workOrder?.teamsTeamId);
  const channelId = asText(workOrder?.teamsChannelId);
  const messageId = asText(workOrder?.teamsMessageId);
  if (teamId && channelId && messageId) {
    return {
      kind: 'reply',
      teamId,
      channelId,
      channelName: watch?.channelName || 'the work-order thread',
      messageId,
    };
  }
  if (watch?.teamId && watch.channelId) {
    return {
      kind: 'channel',
      teamId: watch.teamId,
      channelId: watch.channelId,
      channelName: watch.channelName || 'watched Teams channel',
    };
  }
  return null;
}

export function buildTeamsScheduleDraft(input: {
  call: PlaudCall;
  workOrder: StoredWorkOrder | null;
  appointmentDate?: string;
  watch: TeamsWatchTarget | null;
  dispatch?: TeamsScheduleDispatchContext | null;
}): TeamsSchedulePostDraft {
  const { call, workOrder, watch } = input;
  const destination = resolveTeamsScheduleDestination(workOrder, watch);
  const destinationError = destination
    ? undefined
    : 'Open the Teams tab and pick the channel that should receive schedule notes. If this work order already has a Teams PDF thread, import it first so the reply can land there.';
  const workOrderNumber =
    plumberWorkOrderNumber(workOrder?.workOrderNumber) ||
    plumberWorkOrderNumber(call.workOrderNumber);
  const customer =
    asText(workOrder?.customerName) || asText(call.customerName) || 'Unknown customer';
  const address = asText(workOrder?.address) || asText(call.address);
  const town = plumberTown(address);
  const phones = parseCustomerPhones(
    workOrder?.phones,
    workOrder?.phone,
    call.phone,
    call.callerPhone
  )
    .map(formatCustomerPhone)
    .join(' / ');
  const install =
    asText(workOrder?.installDescription) || asText(workOrder?.jobType);
  const date = asText(input.appointmentDate) || asText(call.appointmentDate);
  const time =
    asText(input.dispatch?.windowLabel) ||
    asText(workOrder?.appointmentTime) ||
    asText(workOrder?.selectedTime) ||
    asText(call.appointmentTime);
  const truck = asText(input.dispatch?.truckName);
  const summary = asText(call.summary) || asText(call.plaudSummary);
  const quote = asText(call.appointmentEvidence?.quote);
  const serviceDay = date
    ? `${formatLongDate(date)}${time ? ` · ${time}` : ''}`
    : 'Not a specific calendar day';
  const jobLabel = jobIdentityLabel({
    workOrderNumber,
    customer,
    address,
    town,
  });
  const subject = jobLabel.slice(0, 120);

  const textLines = [
    jobLabel,
    factLine('Work order', workOrderNumber),
    factLine('Customer', customer),
    factLine('Address', address),
    factLine('Town', town && town !== address ? town : ''),
    factLine('Phone', phones),
    factLine('Job', install),
    factLine('Service day', serviceDay),
    factLine('Truck', truck),
    summary ? `Call notes: ${summary}` : '',
    quote ? `Customer said: “${quote}”` : '',
  ].filter(Boolean);

  const html = [
    `<p><strong>${escapeHtml(jobLabel)}</strong></p>`,
    htmlFact('Work order', workOrderNumber),
    htmlFact('Customer', customer),
    htmlFact('Address', address),
    htmlFact('Town', town && town !== address ? town : ''),
    htmlFact('Phone', phones),
    htmlFact('Job', install),
    htmlFact('Service day', serviceDay),
    htmlFact('Truck', truck),
    summary
      ? `<p><strong>Call notes</strong><br/>${escapeHtml(summary).replace(/\n/g, '<br/>')}</p>`
      : '',
    quote ? `<p><strong>Customer said</strong><br/><em>${escapeHtml(quote)}</em></p>` : '',
  ]
    .filter(Boolean)
    .join('');

  return {
    call,
    workOrder,
    destination,
    destinationError,
    jobLabel,
    subject,
    html,
    text: textLines.join('\n'),
    alreadyPostedAt: asText(call.teamsPostedAt) || undefined,
  };
}

export async function postTeamsScheduleDraft(
  draft: TeamsSchedulePostDraft
): Promise<{ messageId: string; webUrl?: string }> {
  if (!draft.destination) {
    throw new Error(draft.destinationError || 'No Teams destination for this schedule note.');
  }
  const posted =
    draft.destination.kind === 'reply' && draft.destination.messageId
      ? await replyToChannelMessage({
          teamId: draft.destination.teamId,
          channelId: draft.destination.channelId,
          messageId: draft.destination.messageId,
          html: draft.html,
          subject: draft.subject,
        })
      : await postChannelMessage({
          teamId: draft.destination.teamId,
          channelId: draft.destination.channelId,
          html: draft.html,
          subject: draft.subject,
        });

  const postedAt = new Date().toISOString();
  const stamp = {
    teamsPostedAt: postedAt,
    teamsPostedMessageId: posted.id,
    teamsPostedTeamId: draft.destination.teamId,
    teamsPostedChannelId: draft.destination.channelId,
    teamsPostedWebUrl: asText(posted.webUrl) || undefined,
    teamsPostedAsReply: draft.destination.kind === 'reply',
  };

  await setDoc(doc(db, PLAUD_CALLS_COLLECTION, draft.call.id), stamp, { merge: true });
  if (draft.workOrder?.id) {
    await setDoc(
      doc(db, WORK_ORDERS_COLLECTION, draft.workOrder.id),
      {
        teamsSchedulePostedAt: postedAt,
        teamsSchedulePostedMessageId: posted.id,
        teamsSchedulePostedWebUrl: asText(posted.webUrl) || undefined,
      },
      { merge: true }
    );
  }

  return { messageId: posted.id, webUrl: asText(posted.webUrl) || undefined };
}

export function applyTeamsPostToCall(
  call: PlaudCall,
  result: { messageId: string; webUrl?: string; postedAt?: string },
  destination: TeamsScheduleDestination
): PlaudCall {
  return {
    ...call,
    teamsPostedAt: result.postedAt || new Date().toISOString(),
    teamsPostedMessageId: result.messageId,
    teamsPostedTeamId: destination.teamId,
    teamsPostedChannelId: destination.channelId,
    teamsPostedWebUrl: result.webUrl,
    teamsPostedAsReply: destination.kind === 'reply',
  };
}
