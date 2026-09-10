import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  acquireToken,
  azureConfigError,
  getActiveAccount,
  handleRedirectPromise,
  signIn,
  signOut,
} from '../teams-test/auth';
import {
  downloadChannelAttachment,
  getChannelMessages,
  getJoinedTeams,
  getMe,
  getTeamChannels,
  type GraphAttachment,
  type GraphChannel,
  type GraphMessage,
  type GraphTeam,
} from '../teams-test/graphClient';
import { extractPdfText } from '../teams-test/pdf';
import { locateScheduleEvidenceQuote } from '../utils/teamsAppointmentDate';
import { omitSalesOrderBoilerplate } from '../utils/salesOrderBoilerplate';
import {
  formatWorkOrderError,
  importChannelPdfWorkOrder,
  importTeamsPostWorkOrder,
  initiateWorkOrderScheduling,
  manuallyScheduleWorkOrder,
  reinterpretWorkOrderSchedules,
  saveWorkOrder,
  SCHEDULE_LOOKBACK_DAYS,
  startTeamsChannelImport,
  subscribeWorkOrders,
} from '../services/workOrderService';
import {
  readLocalTeamsWatch,
  rememberTeamsWatchTarget,
  writeTeamsWatchSince,
} from '../services/teamsWatchService';
import {
  disconnectTeamsServerSync,
  runTeamsServerSyncNow,
  startTeamsServerConnect,
  subscribeTeamsServerSyncStatus,
  teamsServerSyncIsFresh,
  type TeamsServerSyncStatus,
} from '../services/teamsServerSyncService';
import {
  cancelWorkOrderImport,
  formatUsd,
  subscribeLatestWorkOrderImportProgress,
  type WorkOrderImportProgress,
} from '../services/importProgressService';
import type { StoredWorkOrder, WorkOrder } from '../types';
import { formatCustomerPhones } from '../utils/customerPhones';
import NotesWithScheduleHighlight from './NotesWithScheduleHighlight';
import WorkOrderReview from '../teams-test/WorkOrderReview';
import '../index.css';
import '../teams-test/teams-test.css';

interface PdfResult {
  loading?: boolean;
  text?: string;
  previewUrl?: string;
  showPreview?: boolean;
  error?: string;
}

interface ProcessedWorkOrder {
  workOrder: WorkOrder;
  workOrderId: string;
  cached: boolean;
  status: 'importing' | 'draft' | 'saving' | 'saved';
  error?: string;
}

function stripHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent?.trim() ?? '';
}

/** "just now", "3 min ago", "2 hr ago", or the local date/time when older. */
function describeRelativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function compactWorkOrderNumber(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^wo[\s#:_-]*/i, '').replace(/[\s\-_]/g, '');
}

function workOrderNumberMatches(workOrderNumber: string, query: string): boolean {
  const needle = compactWorkOrderNumber(query);
  if (!needle) return true;
  const haystack = compactWorkOrderNumber(workOrderNumber);
  return haystack.includes(needle) || workOrderNumber.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function localTodayIso(): string {
  return new Date().toLocaleDateString('en-CA');
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function formatServiceDate(isoDate: string, todayIso = localTodayIso()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  if (isoDate === todayIso) return 'today';
  if (isoDate === addDaysToIsoDate(todayIso, 1)) return 'tomorrow';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatConfirmedWhen(workOrder: {
  appointmentDate: string;
  appointmentTime?: string;
  selectedTime?: string;
}): string {
  const dateLabel = formatServiceDate(workOrder.appointmentDate);
  const time = (workOrder.selectedTime || workOrder.appointmentTime || '').trim();
  if (dateLabel && time) return `${dateLabel} at ${time}`;
  if (dateLabel) return dateLabel;
  if (time) return time;
  return 'a date still missing';
}

type MessageSort = 'newest' | 'oldest' | 'sender' | 'has-pdf';

function messageHasPdf(message: GraphMessage) {
  return Boolean(
    message.attachments?.some(
      (attachment) =>
        attachment.name?.toLowerCase().endsWith('.pdf') ||
        attachment.contentType === 'application/pdf'
    )
  );
}

function channelMessagePlainText(html: string): string {
  return omitSalesOrderBoilerplate(stripHtml(html));
}

function visibleThreadReplies(message: GraphMessage): GraphMessage[] {
  return (message.replies || []).filter((reply) =>
    Boolean(channelMessagePlainText(reply.body?.content ?? ''))
  );
}

function messageHasWorkOrderOrNotes(message: GraphMessage): boolean {
  if (messageHasPdf(message)) return true;
  if (channelMessagePlainText(message.body?.content ?? '')) return true;
  if (visibleThreadReplies(message).length > 0) return true;
  return false;
}

/**
 * Mirrors the server heuristic for a hand-typed order with no PDF, e.g.
 * "NEW ORDER Bonnie Bittman Stamford" posted while the PDF system was down.
 * Only decides whether to call the post out; any text post can still be
 * imported by hand.
 */
const TEXT_ORDER_PATTERN =
  /\b(?:new|repeat|rush|change|replacement|manual)[\s.:-]+(?:work[\s-]*)?order\b|\bwork\s*order\b|\bW\.?\s?O\.?\s*#?\s*\d{3,}\b|\border\s*#\s*\d{3,}\b/i;

function messageLooksLikeTextOrder(message: GraphMessage): boolean {
  if (messageHasPdf(message)) return false;
  const text = [
    message.subject,
    channelMessagePlainText(message.body?.content ?? ''),
    ...visibleThreadReplies(message).map((reply) =>
      channelMessagePlainText(reply.body?.content ?? '')
    ),
  ]
    .filter(Boolean)
    .join('\n');
  return text.trim().length >= 8 && TEXT_ORDER_PATTERN.test(text);
}

type TextPostImportState = {
  status: 'importing' | 'saved' | 'error';
  message?: string;
};

function messageSearchText(message: GraphMessage): string {
  return [
    message.subject,
    channelMessagePlainText(message.body?.content ?? ''),
    ...(message.attachments || []).map((attachment) => attachment.name),
    ...visibleThreadReplies(message).map((reply) =>
      channelMessagePlainText(reply.body?.content ?? '')
    ),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function formatChannelNoteLine(
  message: GraphMessage,
  body: string,
  isReply = false
) {
  const from = message.from?.user?.displayName ?? 'Unknown';
  const stamp = new Date(message.createdDateTime).toLocaleString();
  return `${isReply ? 'Reply — ' : ''}[${stamp} · ${from}] ${body}`;
}

/** The PDF post and replies directly under it become job notes. Skip the sales-order email. */
function collectChannelNotesForWorkOrder(
  channelMessages: GraphMessage[],
  sourceMessageId: string
): string {
  const post = channelMessages.find((message) => message.id === sourceMessageId);
  if (!post) return '';
  const postBody = channelMessagePlainText(post.body?.content ?? '');
  const postLine = postBody ? formatChannelNoteLine(post, postBody, false) : '';
  return [postLine, ...visibleThreadReplies(post).map((reply) => {
      const body = channelMessagePlainText(reply.body?.content ?? '');
      return body ? formatChannelNoteLine(reply, body, true) : '';
    })]
    .filter(Boolean)
    .join('\n\n');
}

function mergeWorkOrderNotes(aiNotes: string, _channelNotes: string) {
  // The server summarizes actionable thread updates. Do not append the raw
  // thread here or generic customer-facing boilerplate returns to the job.
  return aiNotes.trim();
}

/** Latest activity across the whole thread: the post or any comment on it. */
function messageActivityMs(message: GraphMessage): number {
  const times = [
    Date.parse(message.lastModifiedDateTime || ''),
    Date.parse(message.createdDateTime || ''),
    ...(message.replies || []).flatMap((reply) => [
      Date.parse(reply.lastModifiedDateTime || ''),
      Date.parse(reply.createdDateTime || ''),
    ]),
  ].filter((value) => Number.isFinite(value));
  return times.length ? Math.max(...times) : 0;
}

function sortMessages(messages: GraphMessage[], sort: MessageSort) {
  const sorted = [...messages];
  sorted.sort((a, b) => {
    if (sort === 'sender') {
      const left = (a.from?.user?.displayName ?? '').toLocaleLowerCase();
      const right = (b.from?.user?.displayName ?? '').toLocaleLowerCase();
      const byName = left.localeCompare(right);
      if (byName !== 0) return byName;
    }
    if (sort === 'has-pdf') {
      const byPdf = Number(messageHasPdf(b)) - Number(messageHasPdf(a));
      if (byPdf !== 0) return byPdf;
    }
    // Order threads by their latest activity (like Teams), so an old post
    // with a comment this morning shows at the top, not by original date.
    const leftTime = messageActivityMs(a);
    const rightTime = messageActivityMs(b);
    return sort === 'oldest' ? leftTime - rightTime : rightTime - leftTime;
  });
  return sorted;
}

export default function TeamsChannels() {
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [profileName, setProfileName] = useState('');

  const [teams, setTeams] = useState<GraphTeam[]>([]);
  const [channels, setChannels] = useState<GraphChannel[]>([]);
  const [messages, setMessages] = useState<GraphMessage[]>([]);
  const [pdfResults, setPdfResults] = useState<Record<string, PdfResult>>({});
  const pdfDataRef = useRef<Record<string, ArrayBuffer>>({});
  const pdfUrlsRef = useRef<Record<string, string>>({});
  const [processedWorkOrders, setProcessedWorkOrders] = useState<
    Record<string, ProcessedWorkOrder>
  >({});
  const [storedWorkOrders, setStoredWorkOrders] = useState<StoredWorkOrder[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [channelImportStatus, setChannelImportStatus] = useState<string | null>(null);
  const [weeklyImportLoading, setWeeklyImportLoading] = useState(false);
  const [serverSync, setServerSync] = useState<TeamsServerSyncStatus | null>(null);
  const [serverSyncBusy, setServerSyncBusy] = useState<'connect' | 'pull' | 'disconnect' | null>(
    null
  );
  const [serverSyncError, setServerSyncError] = useState<string | null>(null);
  const [cancelingImport, setCancelingImport] = useState(false);
  const [importProgress, setImportProgress] =
    useState<WorkOrderImportProgress | null>(null);
  const [schedulingWorkOrderId, setSchedulingWorkOrderId] = useState<string | null>(
    null
  );
  const [manualScheduleDrafts, setManualScheduleDrafts] = useState<
    Record<string, { date: string; time: string }>
  >({});
  const [manualSchedulingId, setManualSchedulingId] = useState<string | null>(null);
  const [notesWorkOrderId, setNotesWorkOrderId] = useState<string | null>(null);
  const [textPostImports, setTextPostImports] = useState<
    Record<string, TextPostImportState>
  >({});
  const channelImportGenerationRef = useRef(0);
  const notesWorkOrder = useMemo(() => {
    const selected =
      storedWorkOrders.find((item) => item.id === notesWorkOrderId) || null;
    if (!selected?.workOrderNumber) return selected;
    const siblings = storedWorkOrders.filter(
      (item) => item.workOrderNumber === selected.workOrderNumber
    );
    if (siblings.length <= 1) return selected;
    const withHighlight = siblings.find((item) =>
      locateScheduleEvidenceQuote(item.notes, item.scheduleEvidenceQuote)
    );
    if (withHighlight) return withHighlight;
    const withScheduleNotes = siblings.find((item) =>
      / · reply\]/i.test(item.notes || '') &&
      /\b(?:August|July|June|May|April|March|January|February|September|October|November|December|good to go|scheduler|scheduled)\b/i.test(
        item.notes || ''
      )
    );
    return withScheduleNotes || selected;
  }, [notesWorkOrderId, storedWorkOrders]);

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const [selectedTeamName, setSelectedTeamName] = useState('');
  const [selectedChannelName, setSelectedChannelName] = useState('');
  const [messageSort, setMessageSort] = useState<MessageSort>('newest');
  const [salesOrderSearch, setSalesOrderSearch] = useState('');
  const [workOrderSearch, setWorkOrderSearch] = useState('');

  const sortedMessages = useMemo(
    () => sortMessages(messages, messageSort),
    [messages, messageSort]
  );
  const visibleMessages = useMemo(() => {
    const useful = sortedMessages.filter(messageHasWorkOrderOrNotes);
    const query = salesOrderSearch.trim().toLocaleLowerCase();
    if (!query) return useful;

    const matchingMessageIds = new Set(
      storedWorkOrders
        .filter((workOrder) =>
          workOrder.workOrderNumber.toLocaleLowerCase().includes(query)
        )
        .map((workOrder) => workOrder.teamsMessageId)
        .filter((messageId): messageId is string => Boolean(messageId))
    );

    return useful.filter(
      (message) =>
        matchingMessageIds.has(message.id) || messageSearchText(message).includes(query)
    );
  }, [salesOrderSearch, sortedMessages, storedWorkOrders]);

  const visibleStoredWorkOrders = useMemo(() => {
    if (!workOrderSearch.trim()) return storedWorkOrders;
    return storedWorkOrders.filter((workOrder) =>
      workOrderNumberMatches(workOrder.workOrderNumber, workOrderSearch)
    );
  }, [storedWorkOrders, workOrderSearch]);

  const refreshWorkOrders = useCallback(async (showLoading = false) => {
    if (!showLoading || !getActiveAccount()) return;
    setQueueLoading(true);
    setQueueError(null);
    try {
      await reinterpretWorkOrderSchedules(await acquireToken());
    } catch (err) {
      setQueueError(formatWorkOrderError(err));
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const loadSignedInState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const account = getActiveAccount();
      if (!account) {
        setSignedIn(false);
        return;
      }

      setSignedIn(true);
      const me = await getMe();
      setProfileName(me.displayName ?? me.mail ?? me.userPrincipalName ?? 'Signed in');

      const teamsResponse = await getJoinedTeams();
      setTeams(teamsResponse.value);
      const watch = readLocalTeamsWatch();
      if (watch && teamsResponse.value.some((team) => team.id === watch.teamId)) {
        setSelectedTeamId(watch.teamId);
        const team = teamsResponse.value.find((item) => item.id === watch.teamId);
        setSelectedTeamName(team?.displayName || watch.channelName);
        try {
          const channelsResponse = await getTeamChannels(watch.teamId);
          setChannels(channelsResponse.value);
          const channel = channelsResponse.value.find((item) => item.id === watch.channelId);
          if (channel) {
            setSelectedChannelId(channel.id);
            setSelectedChannelName(channel.displayName);
            const messagesResponse = await getChannelMessages(watch.teamId, channel.id);
            setMessages(messagesResponse.value);
          }
        } catch (watchError) {
          console.warn('Could not restore the last Teams channel:', watchError);
        }
      }
      await refreshWorkOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSignedIn(false);
    } finally {
      setLoading(false);
    }
  }, [refreshWorkOrders]);

  const handleSignIn = useCallback(async () => {
    setSigningIn(true);
    setError(null);
    try {
      await signIn();
      if (getActiveAccount()) {
        await loadSignedInState();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  }, [loadSignedInState]);

  useEffect(() => {
    if (azureConfigError) {
      setError(azureConfigError);
      setLoading(false);
      return;
    }
    handleRedirectPromise()
      .then(() => loadSignedInState())
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (/no_token_request_cache_error|token request found in cache/i.test(message)) {
          void loadSignedInState();
          return;
        }
        setError(message);
        setLoading(false);
      });
  }, [loadSignedInState]);

  useEffect(() => {
    if (!signedIn) {
      setStoredWorkOrders([]);
      return;
    }
    return subscribeWorkOrders(
      (workOrders) => {
        setStoredWorkOrders(workOrders);
      },
      (err) => {
        console.warn('Could not listen for scheduling jobs:', err);
      }
    );
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) {
      setImportProgress(null);
      return;
    }
    return subscribeLatestWorkOrderImportProgress(
      setImportProgress,
      (err) => console.warn('Could not load Teams import progress:', err)
    );
  }, [signedIn]);

  useEffect(() => {
    return subscribeTeamsServerSyncStatus(setServerSync, (err) =>
      console.warn('Could not load the server Teams sync status:', err)
    );
  }, []);

  const handleServerSyncConnect = async () => {
    if (serverSyncBusy) return;
    setServerSyncBusy('connect');
    setServerSyncError(null);
    try {
      const { url } = await startTeamsServerConnect(await acquireToken());
      const popup = window.open(url, 'njplumbing-teams-server-connect', 'width=520,height=720');
      if (!popup) window.location.assign(url);
    } catch (err) {
      setServerSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerSyncBusy(null);
    }
  };

  const handleServerSyncPullNow = async () => {
    if (serverSyncBusy) return;
    setServerSyncBusy('pull');
    setServerSyncError(null);
    try {
      const result = await runTeamsServerSyncNow(await acquireToken());
      setChannelImportStatus(
        `Server pull: ${result.checked} PDF${result.checked === 1 ? '' : 's'} checked · ${
          result.imported + result.updated
        } changed · booked ${result.booked}.`
      );
    } catch (err) {
      setServerSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerSyncBusy(null);
    }
  };

  const handleServerSyncDisconnect = async () => {
    if (serverSyncBusy) return;
    const confirmed = window.confirm(
      'Stop syncing Teams while the app is closed? Dispatch will only pull new comments while this app is open.'
    );
    if (!confirmed) return;
    setServerSyncBusy('disconnect');
    setServerSyncError(null);
    try {
      await disconnectTeamsServerSync(await acquireToken());
    } catch (err) {
      setServerSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerSyncBusy(null);
    }
  };

  const clearPdfCache = useCallback(() => {
    for (const url of Object.values(pdfUrlsRef.current)) {
      URL.revokeObjectURL(url);
    }
    pdfUrlsRef.current = {};
    pdfDataRef.current = {};
    setPdfResults({});
  }, []);

  useEffect(() => {
    return () => {
      for (const url of Object.values(pdfUrlsRef.current)) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const handleSelectTeam = async (team: GraphTeam) => {
    setError(null);
    setSelectedTeamId(team.id);
    setSelectedTeamName(team.displayName);
    setSelectedChannelId(null);
    setSelectedChannelName('');
    setMessages([]);
    setProcessedWorkOrders({});
    setChannelImportStatus(null);
    clearPdfCache();
    channelImportGenerationRef.current += 1;

    try {
      const response = await getTeamChannels(team.id);
      setChannels(response.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const emptyWorkOrder = (sourceFileName: string): WorkOrder => ({
    workOrderNumber: '',
    customerName: '',
    phone: '',
    address: '',
    jobType: '',
    appointmentDate: '',
    appointmentTime: '',
    notes: '',
    sourceFileName,
    smsConsent: false,
  });

  const importPdfAttachment = useCallback(
    async (
      teamId: string,
      channelId: string,
      channelMessages: GraphMessage[],
      messageId: string,
      attachment: GraphAttachment,
      options?: { force?: boolean }
    ) => {
      const key = `${messageId}:${attachment.id}`;
      const force = options?.force === true;

      setProcessedWorkOrders((current) => ({
        ...current,
        [key]: {
          workOrder: current[key]?.workOrder || emptyWorkOrder(attachment.name ?? 'work-order.pdf'),
          workOrderId: current[key]?.workOrderId || '',
          cached: false,
          status: 'importing',
          error: undefined,
        },
      }));

      try {
        const data = await downloadChannelAttachment(teamId, channelId, attachment);
        const bytes = data.slice(0);
        pdfDataRef.current[key] = bytes;
        if (pdfUrlsRef.current[key]) URL.revokeObjectURL(pdfUrlsRef.current[key]);
        const previewUrl = URL.createObjectURL(
          new Blob([bytes], { type: 'application/pdf' })
        );
        pdfUrlsRef.current[key] = previewUrl;
        const text = await extractPdfText(bytes.slice(0));
        if (!text.trim()) {
          throw new Error(
            'This appears to be a scanned PDF. OCR is required before AI import.'
          );
        }
        setPdfResults((current) => ({
          ...current,
          [key]: {
            ...current[key],
            previewUrl,
            text: text || 'No readable text was found in this PDF.',
            loading: false,
          },
        }));

        const sourceChannelNotes = collectChannelNotesForWorkOrder(
          channelMessages,
          messageId
        );
        const imported = await importChannelPdfWorkOrder({
          text,
          channelNote: sourceChannelNotes,
          sourceFileName: attachment.name ?? 'work-order.pdf',
          teamId,
          channelId,
          messageId,
          attachmentId: attachment.id,
          force,
          microsoftAccessToken: await acquireToken(),
        });

        const relatedChannelNotes = collectChannelNotesForWorkOrder(
          channelMessages,
          messageId
        );
        const workOrder: WorkOrder = {
          ...imported.workOrder,
          notes: mergeWorkOrderNotes(imported.workOrder.notes, relatedChannelNotes),
          teamsTeamId: teamId,
          teamsChannelId: channelId,
          teamsMessageId: messageId,
          teamsAttachmentId: attachment.id,
        };

        setProcessedWorkOrders((current) => ({
          ...current,
          [key]: {
            workOrder,
            workOrderId: imported.workOrderId,
            cached: imported.cached,
            status: 'saved',
            error: undefined,
          },
        }));
        return imported;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProcessedWorkOrders((current) => ({
          ...current,
          [key]: {
            workOrder:
              current[key]?.workOrder ||
              emptyWorkOrder(attachment.name ?? 'work-order.pdf'),
            workOrderId: current[key]?.workOrderId || '',
            cached: false,
            status: 'draft',
            error: message,
          },
        }));
        setPdfResults((current) => ({
          ...current,
          [key]: { ...current[key], error: message, loading: false },
        }));
        return null;
      }
    },
    []
  );

  const handleSelectChannel = async (channel: GraphChannel) => {
    if (!selectedTeamId) return;
    setError(null);
    setSelectedChannelId(channel.id);
    setSelectedChannelName(channel.displayName);
    setMessages([]);
    setSalesOrderSearch('');
    setProcessedWorkOrders({});
    setChannelImportStatus(null);
    clearPdfCache();
    channelImportGenerationRef.current += 1;

    void rememberTeamsWatchTarget({
      teamId: selectedTeamId,
      channelId: channel.id,
      channelName: channel.displayName,
    }).catch((err) => {
      console.warn('Could not remember the Teams watch channel:', err);
    });
    try {
      const response = await getChannelMessages(selectedTeamId, channel.id);
      setMessages(response.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportLastWeek = async () => {
    if (!selectedTeamId || !selectedChannelId || weeklyImportLoading) return;

    setWeeklyImportLoading(true);
    setError(null);
    try {
      const token = await acquireToken();
      const loaded = await getChannelMessages(
        selectedTeamId,
        selectedChannelId,
        SCHEDULE_LOOKBACK_DAYS
      );
      setMessages(loaded.value);

      const run = await startTeamsChannelImport({
        teamId: selectedTeamId,
        channelId: selectedChannelId,
        channelName: selectedChannelName || 'Teams channel',
        days: SCHEDULE_LOOKBACK_DAYS,
        microsoftAccessToken: token,
      });
      writeTeamsWatchSince(selectedChannelId, new Date().toISOString());
      await rememberTeamsWatchTarget({
        teamId: selectedTeamId,
        channelId: selectedChannelId,
        channelName: selectedChannelName || 'Teams channel',
      });

      const textOrders = loaded.value.filter(messageLooksLikeTextOrder);
      let textImported = 0;
      let textFailed = 0;
      for (const message of textOrders) {
        try {
          await importTeamsPostWorkOrder({
            teamId: selectedTeamId,
            channelId: selectedChannelId,
            messageId: message.id,
            microsoftAccessToken: token,
          });
          textImported += 1;
        } catch {
          textFailed += 1;
        }
      }

      const textSummary =
        textOrders.length === 0
          ? ''
          : textImported
            ? ` Also imported ${textImported} typed order${
                textImported === 1 ? '' : 's'
              } with no PDF${textFailed ? ` (${textFailed} failed)` : ''}.`
            : ' Typed orders with no PDF need the latest import function deployed.';
      setChannelImportStatus(
        `Background PDF import queued (${run.runId}).${textSummary} While the app is open, new comments pull every 2 minutes.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWeeklyImportLoading(false);
    }
  };

  const loadPdfAttachment = async (
    messageId: string,
    attachment: GraphAttachment,
    options?: { extractText?: boolean; showPreview?: boolean }
  ): Promise<{ data: ArrayBuffer; previewUrl: string; text?: string }> => {
    if (!selectedTeamId || !selectedChannelId) {
      throw new Error('Select a team and channel first.');
    }

    const key = `${messageId}:${attachment.id}`;
    const extractText = options?.extractText === true;
    const showPreview = options?.showPreview !== false;

    setPdfResults((current) => ({
      ...current,
      [key]: {
        ...current[key],
        loading: true,
        error: undefined,
        showPreview: showPreview || current[key]?.showPreview,
      },
    }));

    try {
      let data = pdfDataRef.current[key];
      let previewUrl = pdfUrlsRef.current[key];

      if (!data || !previewUrl) {
        data = await downloadChannelAttachment(
          selectedTeamId,
          selectedChannelId,
          attachment
        );
        // Clone so pdf.js and the blob URL do not share the same detached buffer.
        const bytes = data.slice(0);
        pdfDataRef.current[key] = bytes;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(
          new Blob([bytes], { type: 'application/pdf' })
        );
        pdfUrlsRef.current[key] = previewUrl;
        data = bytes;
      }

      let text = pdfResults[key]?.text;
      if (extractText) {
        const extracted = await extractPdfText(data.slice(0));
        text = extracted || 'No readable text was found in this PDF.';
      }

      setPdfResults((current) => ({
        ...current,
        [key]: {
          ...current[key],
          loading: false,
          previewUrl,
          showPreview: showPreview || current[key]?.showPreview,
          text: text ?? current[key]?.text,
          error: undefined,
        },
      }));

      return { data, previewUrl, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPdfResults((current) => ({
        ...current,
        [key]: {
          ...current[key],
          loading: false,
          error: message,
        },
      }));
      throw new Error(message);
    }
  };

  const viewPdf = async (messageId: string, attachment: GraphAttachment) => {
    await loadPdfAttachment(messageId, attachment, {
      extractText: false,
      showPreview: true,
    });
  };

  const viewExtractedText = async (
    messageId: string,
    attachment: GraphAttachment
  ) => {
    await loadPdfAttachment(messageId, attachment, {
      extractText: true,
      showPreview: false,
    });
  };

  const handleSaveWorkOrder = async (key: string) => {
    const processed = processedWorkOrders[key];
    if (!processed) return;

    setProcessedWorkOrders((current) => ({
      ...current,
      [key]: { ...processed, status: 'saving', error: undefined },
    }));

    try {
      const result = await saveWorkOrder(
        processed.workOrder,
        await acquireToken(),
        processed.workOrderId || undefined
      );
      setProcessedWorkOrders((current) => ({
        ...current,
        [key]: {
          ...current[key],
          workOrderId: result.workOrderId,
          cached: true,
          status: 'saved',
          error: undefined,
        },
      }));
      await refreshWorkOrders();
    } catch (err) {
      setProcessedWorkOrders((current) => ({
        ...current,
        [key]: {
          ...current[key],
          status: 'draft',
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  const handleReimportWorkOrder = async (
    messageId: string,
    attachment: GraphAttachment
  ) => {
    if (!selectedTeamId || !selectedChannelId) return;
    await importPdfAttachment(
      selectedTeamId,
      selectedChannelId,
      messages,
      messageId,
      attachment,
      { force: true }
    );
    await refreshWorkOrders();
  };

  /** Text-only order post (no PDF): the post body is the work order. */
  const handleImportTextPost = async (messageId: string, force: boolean) => {
    if (!selectedTeamId || !selectedChannelId) return;
    setTextPostImports((current) => ({
      ...current,
      [messageId]: { status: 'importing' },
    }));
    try {
      const result = await importTeamsPostWorkOrder({
        teamId: selectedTeamId,
        channelId: selectedChannelId,
        messageId,
        force,
        microsoftAccessToken: await acquireToken(),
      });
      const who = result.workOrder.customerName || 'work order';
      const when = result.workOrder.appointmentDate
        ? ` · on schedule ${formatServiceDate(result.workOrder.appointmentDate)}`
        : ' · no service day found in the thread yet';
      setTextPostImports((current) => ({
        ...current,
        [messageId]: {
          status: 'saved',
          message: `${result.cached ? 'Refreshed' : 'Imported'} ${who}${when}`,
        },
      }));
    } catch (err) {
      setTextPostImports((current) => ({
        ...current,
        [messageId]: { status: 'error', message: formatWorkOrderError(err) },
      }));
    }
  };

  const handleScheduleWorkOrder = async (workOrderId: string) => {
    setSchedulingWorkOrderId(workOrderId);
    setQueueError(null);
    try {
      const result = await initiateWorkOrderScheduling(
        workOrderId,
        await acquireToken()
      );
      await refreshWorkOrders();
      if (result.alreadyPending) {
        setQueueError(
          `A test scheduling conversation is already waiting for a reply at ${result.testRecipient}.`
        );
      }
    } catch (err) {
      setQueueError(formatWorkOrderError(err));
    } finally {
      setSchedulingWorkOrderId(null);
    }
  };

  const handleManualSchedule = async (workOrderId: string) => {
    const draft = manualScheduleDrafts[workOrderId];
    if (!draft?.date || manualSchedulingId) return;
    setManualSchedulingId(workOrderId);
    setQueueError(null);
    try {
      await manuallyScheduleWorkOrder(workOrderId, draft.date, draft.time);
      setManualScheduleDrafts((current) => {
        const next = { ...current };
        delete next[workOrderId];
        return next;
      });
    } catch (err) {
      setQueueError(formatWorkOrderError(err));
    } finally {
      setManualSchedulingId(null);
    }
  };

  const exportWorkOrdersCsv = () => {
    const records =
      storedWorkOrders.length > 0
        ? storedWorkOrders
        : Object.values(processedWorkOrders).map(
            (processed) => processed.workOrder
          );
    const columns: Array<keyof WorkOrder> = [
      'workOrderNumber',
      'customerName',
      'phone',
      'address',
      'jobType',
      'appointmentDate',
      'appointmentTime',
      'notes',
      'sourceFileName',
      'smsConsent',
    ];
    const escape = (value: unknown) => {
      const text = String(value ?? '');
      const spreadsheetSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
    };
    const csv = [
      columns.join(','),
      ...records.map((record) =>
        columns.map((column) => escape(record[column])).join(',')
      ),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `work-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="teams-test">
      <header className="teams-test__header">
        <div>
          <h1>Teams Graph Test</h1>
          <p className="teams-test__subtitle">
            Tests the same Azure app + Graph permissions as your Cursor MCP setup
          </p>
        </div>
        <div className="teams-test__header-actions">
          <a className="teams-test__nav-link" href="/">
            Dispatch
          </a>
          {signedIn && <span className="teams-test__profile">{profileName}</span>}
          {signedIn ? (
            <button type="button" onClick={() => signOut()}>
              Sign out
            </button>
          ) : (
            <button
              type="button"
              disabled={Boolean(azureConfigError) || signingIn}
              onClick={() => void handleSignIn()}
            >
              {signingIn ? 'Signing in…' : 'Sign in with Microsoft'}
            </button>
          )}
        </div>
      </header>

      {error && <div className="teams-test__error">{error}</div>}

      {loading && <div className="teams-test__loading">Loading…</div>}

      {!loading && !signedIn && (
        <section className="teams-test__empty">
          <p>Sign in with your work Microsoft account to load Teams and messages.</p>
          <p className="teams-test__hint">
            Redirect URI for Azure: <code>{window.location.origin}{window.location.pathname}</code>
          </p>
        </section>
      )}

      {!loading && signedIn && (
        <>
          <div className="teams-test__layout">
            <aside className="teams-test__panel">
            <h2>Teams</h2>
            <ul>
              {teams.map((team) => (
                <li key={team.id}>
                  <button
                    type="button"
                    className={selectedTeamId === team.id ? 'selected' : ''}
                    onClick={() => handleSelectTeam(team)}
                  >
                    {team.displayName}
                  </button>
                </li>
              ))}
            </ul>
            </aside>

            <aside className="teams-test__panel">
            <h2>Channels</h2>
            {selectedTeamId ? (
              <ul>
                {channels.map((channel) => (
                  <li key={channel.id}>
                    <button
                      type="button"
                      className={selectedChannelId === channel.id ? 'selected' : ''}
                      onClick={() => handleSelectChannel(channel)}
                    >
                      {channel.displayName}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="teams-test__hint">Select a team</p>
            )}
            </aside>

            <main className="teams-test__messages">
            <div className="teams-test__messages-header">
              <h2>
                Messages
                {selectedChannelName
                  ? ` — ${selectedTeamName} / ${selectedChannelName}`
                  : ''}
              </h2>
              {selectedChannelId && (
                <div className="teams-test__message-tools">
                  <label className="teams-test__sort">
                    Sort
                    <select
                      value={messageSort}
                      onChange={(event) =>
                        setMessageSort(event.target.value as MessageSort)
                      }
                    >
                      <option value="newest">Newest first</option>
                      <option value="oldest">Oldest first</option>
                      <option value="sender">Sender A–Z</option>
                      <option value="has-pdf">PDFs first</option>
                    </select>
                  </label>
                  <label className="teams-test__sales-search">
                    <span>Sales order</span>
                    <input
                      type="search"
                      value={salesOrderSearch}
                      onChange={(event) => setSalesOrderSearch(event.target.value)}
                      placeholder="Search order #"
                      aria-label="Search sales order number"
                    />
                  </label>
                  <button
                    type="button"
                    className="teams-test__weekly-import"
                    disabled={weeklyImportLoading || !selectedChannelId}
                    onClick={() => void handleImportLastWeek()}
                  >
                    {weeklyImportLoading
                      ? `Importing last ${SCHEDULE_LOOKBACK_DAYS} days…`
                      : `Import last ${SCHEDULE_LOOKBACK_DAYS} days (incl. older PDFs with new notes)`}
                  </button>
                </div>
              )}
            </div>
            {selectedChannelId && !serverSync?.connected && (
              <p className="teams-test__hint">
                While this app is open and you are signed in, new comments on this
                channel pull every 2 minutes. Only the PDF that changed is processed.
              </p>
            )}
            <div
              className={`teams-test__server-sync${
                serverSync?.needsReconnect || serverSync?.lastError
                  ? ' teams-test__server-sync--warn'
                  : serverSync?.connected
                    ? ' teams-test__server-sync--on'
                    : ''
              }`}
            >
              <strong>
                {serverSync?.connected
                  ? teamsServerSyncIsFresh(serverSync)
                    ? 'Syncing on the server, even when this app is closed'
                    : 'Server sync connected'
                  : serverSync?.needsReconnect
                    ? 'Server sync needs a new sign-in'
                    : 'Sync while this app is closed'}
              </strong>
              <span>
                {serverSync?.connected
                  ? `Signed in as ${serverSync.account || 'Microsoft account'}.${
                      serverSync.lastCheckedAt
                        ? ` Last pull ${describeRelativeTime(serverSync.lastCheckedAt)}${
                            serverSync.lastResult
                              ? ` · ${serverSync.lastResult.checked} PDF${
                                  serverSync.lastResult.checked === 1 ? '' : 's'
                                } checked, ${
                                  serverSync.lastResult.imported + serverSync.lastResult.updated
                                } changed`
                              : ''
                          }.`
                        : ' Waiting for the first pull.'
                    }`
                  : 'Right now Teams comments only reach Dispatch while this app is open. Sign in once and the server keeps pulling the watched channel every 2 minutes overnight and on weekends.'}
              </span>
              {serverSync?.lastError && <small>{serverSync.lastError}</small>}
              {serverSyncError && <small>{serverSyncError}</small>}
              <div className="teams-test__server-sync-actions">
                <button
                  type="button"
                  disabled={serverSyncBusy !== null || !signedIn}
                  onClick={() => void handleServerSyncConnect()}
                >
                  {serverSyncBusy === 'connect'
                    ? 'Opening Microsoft sign-in…'
                    : serverSync?.connected
                      ? 'Sign in again'
                      : 'Keep syncing when the app is closed'}
                </button>
                {serverSync?.connected && (
                  <>
                    <button
                      type="button"
                      disabled={serverSyncBusy !== null || !signedIn}
                      onClick={() => void handleServerSyncPullNow()}
                    >
                      {serverSyncBusy === 'pull' ? 'Pulling…' : 'Pull now'}
                    </button>
                    <button
                      type="button"
                      className="teams-test__server-sync-disconnect"
                      disabled={serverSyncBusy !== null || !signedIn}
                      onClick={() => void handleServerSyncDisconnect()}
                    >
                      {serverSyncBusy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  </>
                )}
              </div>
            </div>
            {channelImportStatus && (
              <p className="teams-test__hint">{channelImportStatus}</p>
            )}
            {importProgress &&
              (!selectedChannelId ||
                importProgress.channelId === selectedChannelId) && (
                <div className="teams-test__import-progress">
                  <strong>
                    {importProgress.status === 'queued'
                      ? 'Background import queued'
                      : importProgress.status === 'processing'
                        ? 'Background import in progress'
                        : importProgress.status === 'failed'
                          ? 'Background import needs attention'
                          : importProgress.status === 'canceled'
                            ? 'Background import canceled'
                          : 'Latest background import'}
                  </strong>
                  <span>
                    {importProgress.processed}/{importProgress.total} PDFs processed ·{' '}
                    {importProgress.imported} imported · {importProgress.cached} cached
                    {importProgress.failed
                      ? ` · ${importProgress.failed} failed`
                      : ''}
                  </span>
                  {(importProgress.pdfCostUsd != null ||
                    importProgress.scheduleCostUsd != null ||
                    importProgress.openaiCostUsd != null) && (
                    <span>
                      OpenAI: PDFs {formatUsd(importProgress.pdfCostUsd)} · schedule{' '}
                      {formatUsd(importProgress.scheduleCostUsd)} · total{' '}
                      {formatUsd(importProgress.openaiCostUsd)}
                    </span>
                  )}
                  {importProgress.message && <small>{importProgress.message}</small>}
                  {(importProgress.status === 'queued' ||
                    importProgress.status === 'processing') && (
                    <button
                      type="button"
                      disabled={cancelingImport}
                      onClick={async () => {
                        setCancelingImport(true);
                        try {
                          await cancelWorkOrderImport(importProgress.id);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setCancelingImport(false);
                        }
                      }}
                    >
                      {cancelingImport ? 'Canceling…' : 'Cancel import'}
                    </button>
                  )}
                </div>
              )}

            {messages.length === 0 ? (
              <p className="teams-test__hint">
                Select a team and channel to load messages
              </p>
            ) : visibleMessages.length === 0 ? (
              <p className="teams-test__hint">
                No loaded messages match sales order “{salesOrderSearch}”.
              </p>
            ) : (
              <ul className="teams-test__message-list">
                {visibleMessages.map((message) => {
                  const body = channelMessagePlainText(message.body?.content ?? '');
                  const replies = visibleThreadReplies(message);
                  return (
                  <li key={message.id} className="teams-test__message">
                    <div className="teams-test__message-meta">
                      <strong>{message.from?.user?.displayName ?? 'Unknown'}</strong>
                      <span>{new Date(message.createdDateTime).toLocaleString()}</span>
                    </div>
                    {message.subject?.trim() && (
                      <h3 className="teams-test__message-title">
                        {message.subject.trim()}
                      </h3>
                    )}
                    {body ? <p>{body}</p> : null}
                    {replies.length > 0 && (
                      <details className="teams-test__thread">
                        <summary>
                          View notes ({replies.length}{' '}
                          {replies.length === 1 ? 'reply' : 'replies'})
                        </summary>
                        <ul>
                          {replies.map((reply) => (
                            <li key={reply.id}>
                              <div className="teams-test__thread-meta">
                                <strong>
                                  {reply.from?.user?.displayName ?? 'Unknown'}
                                </strong>
                                <span>
                                  {new Date(reply.createdDateTime).toLocaleString()}
                                </span>
                              </div>
                              <p>{channelMessagePlainText(reply.body?.content ?? '')}</p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {message.attachments
                      ?.filter(
                        (attachment) =>
                          attachment.name?.toLowerCase().endsWith('.pdf') ||
                          attachment.contentType === 'application/pdf'
                      )
                      .map((attachment) => {
                        const key = `${message.id}:${attachment.id}`;
                        const result = pdfResults[key];
                        const processed = processedWorkOrders[key];
                        const importLabel =
                          processed?.status === 'importing'
                            ? 'Importing into Firebase…'
                            : processed?.error
                              ? 'Import failed'
                              : processed?.cached
                                ? 'Loaded from Firebase'
                                : processed?.status === 'saved'
                                  ? 'Saved in Firebase'
                                  : 'Waiting for auto-import';

                        return (
                          <div key={attachment.id} className="teams-test__attachment">
                            <div className="teams-test__attachment-header">
                              <span>PDF: {attachment.name ?? 'Attachment'}</span>
                              <div className="teams-test__attachment-actions">
                                <span className="teams-test__import-status">
                                  {importLabel}
                                </span>
                                <button
                                  type="button"
                                  disabled={result?.loading}
                                  onClick={() => {
                                    void viewPdf(message.id, attachment).catch(
                                      () => undefined
                                    );
                                  }}
                                >
                                  {result?.loading && !result?.previewUrl
                                    ? 'Loading…'
                                    : result?.showPreview && result?.previewUrl
                                      ? 'Reload PDF'
                                      : 'View PDF'}
                                </button>
                                <button
                                  type="button"
                                  disabled={result?.loading}
                                  onClick={() => {
                                    void viewExtractedText(
                                      message.id,
                                      attachment
                                    ).catch(() => undefined);
                                  }}
                                >
                                  {result?.loading
                                    ? 'Reading…'
                                    : result?.text
                                      ? 'Show extracted text'
                                      : 'View extracted text'}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    result?.loading ||
                                    processed?.status === 'importing'
                                  }
                                  onClick={() => {
                                    void handleReimportWorkOrder(
                                      message.id,
                                      attachment
                                    ).catch(() => undefined);
                                  }}
                                >
                                  Re-import
                                </button>
                              </div>
                            </div>
                            <div className="teams-test__attachment-links">
                              {result?.previewUrl && (
                                <a
                                  href={result.previewUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open PDF in new tab
                                </a>
                              )}
                              {attachment.contentUrl && (
                                <a
                                  href={attachment.contentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open in Teams / SharePoint
                                </a>
                              )}
                            </div>
                            {result?.error && (
                              <p className="teams-test__attachment-error">
                                {result.error}
                              </p>
                            )}
                            {result?.showPreview && result.previewUrl && (
                              <iframe
                                className="teams-test__pdf-viewer"
                                title={attachment.name ?? 'PDF preview'}
                                src={result.previewUrl}
                              />
                            )}
                            {result?.text && (
                              <details
                                className="teams-test__pdf-text-details"
                                open
                              >
                                <summary>Extracted PDF text</summary>
                                <pre className="teams-test__pdf-text">{result.text}</pre>
                              </details>
                            )}
                          </div>
                        );
                      })}
                    {!messageHasPdf(message) && (body || message.subject?.trim()) && (() => {
                      const stored = storedWorkOrders.find(
                        (workOrder) =>
                          workOrder.teamsMessageId === message.id &&
                          !workOrder.teamsAttachmentId
                      );
                      const local = textPostImports[message.id];
                      const looksLikeOrder = messageLooksLikeTextOrder(message);
                      // Ordinary chatter is not called out; only order-like posts
                      // and posts already imported get the import controls.
                      if (!looksLikeOrder && !stored && !local) return null;
                      const statusLabel =
                        local?.status === 'importing'
                          ? 'Importing into Firebase…'
                          : local?.status === 'error'
                            ? 'Import failed'
                            : local?.message ||
                              (stored
                                ? stored.appointmentDate
                                  ? `Saved in Firebase · on schedule ${formatServiceDate(
                                      stored.appointmentDate
                                    )}`
                                  : 'Saved in Firebase · no service day yet'
                                : 'No PDF — waiting for auto-import');
                      return (
                        <div className="teams-test__attachment teams-test__attachment--text-order">
                          <div className="teams-test__attachment-header">
                            <span>
                              No PDF attached — order typed in Teams
                              {stored?.customerName ? `: ${stored.customerName}` : ''}
                            </span>
                            <div className="teams-test__attachment-actions">
                              <span className="teams-test__import-status">{statusLabel}</span>
                              <button
                                type="button"
                                disabled={local?.status === 'importing'}
                                onClick={() => {
                                  void handleImportTextPost(message.id, Boolean(stored));
                                }}
                              >
                                {stored ? 'Re-import' : 'Import as work order'}
                              </button>
                            </div>
                          </div>
                          {local?.status === 'error' && local.message && (
                            <p className="teams-test__attachment-error">{local.message}</p>
                          )}
                        </div>
                      );
                    })()}
                  </li>
                  );
                })}
              </ul>
            )}
            </main>
          </div>

          <section className="teams-test__processed">
            <div className="teams-test__processed-header">
              <div>
                <h2>Scheduling database</h2>
                <p>
                  Jobs imported or updated in the past week. Refresh jobs
                  re-reads those notes with AI to update the service day.
                </p>
              </div>
              <div className="teams-test__attachment-actions">
                <label className="teams-test__sales-search">
                  <span>Work order</span>
                  <input
                    type="search"
                    value={workOrderSearch}
                    onChange={(event) => setWorkOrderSearch(event.target.value)}
                    placeholder="Search WO #"
                    aria-label="Search scheduling database by work order number"
                  />
                </label>
                <button
                  type="button"
                  disabled={queueLoading}
                  onClick={() => refreshWorkOrders(true)}
                >
                  {queueLoading ? 'Refreshing…' : 'Refresh jobs'}
                </button>
                {storedWorkOrders.length > 0 && (
                  <button type="button" onClick={exportWorkOrdersCsv}>
                    Export CSV
                  </button>
                )}
              </div>
            </div>

            {queueError && (
              <div className="teams-test__error teams-test__error--banner">
                <span>{queueError}</span>
                <button
                  type="button"
                  className="teams-test__error-dismiss"
                  onClick={() => setQueueError(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="teams-test__job-columns">
              {(
                ['needs_review', 'unscheduled', 'scheduling', 'scheduled'] as const
              ).map((status) => {
                  const jobs = visibleStoredWorkOrders.filter(
                    (workOrder) => workOrder.status === status
                  );
                  return (
                    <div key={status} className="teams-test__job-column">
                      <h3>
                        {status === 'needs_review'
                          ? 'Needs review'
                          : status === 'unscheduled'
                          ? 'Unscheduled'
                          : status === 'scheduling'
                            ? 'Awaiting text reply'
                            : 'Scheduled'}{' '}
                        ({jobs.length})
                      </h3>
                      {jobs.length === 0 ? (
                        <p className="teams-test__hint">
                          {workOrderSearch.trim() ? 'No matching jobs' : 'No jobs'}
                        </p>
                      ) : (
                        jobs.map((workOrder) => (
                          <article
                            key={workOrder.id}
                            className="teams-test__job-card"
                          >
                            <strong>WO {workOrder.workOrderNumber}</strong>
                            <span>{workOrder.customerName}</span>
                            <span>{workOrder.jobType}</span>
                            <span>
                              {workOrder.appointmentDate
                                ? formatServiceDate(workOrder.appointmentDate)
                                : 'No service date'}
                              {workOrder.appointmentTime
                                ? ` at ${workOrder.appointmentTime}`
                                : ''}
                            </span>
                            <span>{workOrder.address}</span>
                            <span>
                              Customer phone on file: {formatCustomerPhones(workOrder) || workOrder.phone || '—'}
                            </span>
                            <button
                              type="button"
                              className="teams-test__notes-button"
                              onClick={() => setNotesWorkOrderId(workOrder.id)}
                            >
                              {omitSalesOrderBoilerplate(workOrder.notes || '')
                                ? 'View notes'
                                : 'No notes'}
                            </button>
                            {status === 'unscheduled' && (
                              <button
                                type="button"
                                disabled={
                                  schedulingWorkOrderId === workOrder.id
                                }
                                onClick={() =>
                                  handleScheduleWorkOrder(workOrder.id)
                                }
                              >
                                {schedulingWorkOrderId === workOrder.id
                                  ? 'Sending test text…'
                                  : 'Schedule by text'}
                              </button>
                            )}
                            {(status === 'unscheduled' ||
                              status === 'needs_review') && (
                              <div className="teams-test__manual-schedule">
                                <input
                                  type="date"
                                  value={
                                    manualScheduleDrafts[workOrder.id]?.date ?? ''
                                  }
                                  onChange={(event) =>
                                    setManualScheduleDrafts((current) => ({
                                      ...current,
                                      [workOrder.id]: {
                                        time: current[workOrder.id]?.time ?? '',
                                        date: event.target.value,
                                      },
                                    }))
                                  }
                                  aria-label={`Service date for work order ${workOrder.workOrderNumber || workOrder.id}`}
                                />
                                <input
                                  type="time"
                                  value={
                                    manualScheduleDrafts[workOrder.id]?.time ?? ''
                                  }
                                  onChange={(event) =>
                                    setManualScheduleDrafts((current) => ({
                                      ...current,
                                      [workOrder.id]: {
                                        date: current[workOrder.id]?.date ?? '',
                                        time: event.target.value,
                                      },
                                    }))
                                  }
                                  aria-label={`Arrival time (optional) for work order ${workOrder.workOrderNumber || workOrder.id}`}
                                />
                                <button
                                  type="button"
                                  disabled={
                                    !manualScheduleDrafts[workOrder.id]?.date ||
                                    manualSchedulingId === workOrder.id
                                  }
                                  onClick={() =>
                                    handleManualSchedule(workOrder.id)
                                  }
                                >
                                  {manualSchedulingId === workOrder.id
                                    ? 'Adding…'
                                    : 'Add to dispatch'}
                                </button>
                              </div>
                            )}
                            {status === 'scheduling' && (
                              <span className="teams-test__job-status">
                                Waiting for a reply from the test phone
                              </span>
                            )}
                            {status === 'scheduled' && (
                              <span className="teams-test__job-status">
                                Confirmed for {formatConfirmedWhen(workOrder)}
                              </span>
                            )}
                          </article>
                        ))
                      )}
                    </div>
                  );
                }
              )}
            </div>
          </section>

          {notesWorkOrder && (
            <div
              className="teams-test__notes-modal"
              role="dialog"
              aria-modal="true"
              aria-label={`Notes for ${notesWorkOrder.workOrderNumber || 'job'}`}
            >
              <div
                className="teams-test__notes-modal-backdrop"
                onClick={() => setNotesWorkOrderId(null)}
              />
              <div className="teams-test__notes-modal-panel">
                <header className="teams-test__notes-modal-header">
                  <div>
                    <strong>WO {notesWorkOrder.workOrderNumber || '—'}</strong>
                    <p>{notesWorkOrder.customerName || 'Unknown customer'}</p>
                  </div>
                  <button type="button" onClick={() => setNotesWorkOrderId(null)}>
                    Close
                  </button>
                </header>
                <dl className="teams-test__notes-modal-facts">
                  <div>
                    <dt>Phone</dt>
                    <dd>{formatCustomerPhones(notesWorkOrder) || notesWorkOrder.phone || '—'}</dd>
                  </div>
                  <div>
                    <dt>Address</dt>
                    <dd>{notesWorkOrder.address || '—'}</dd>
                  </div>
                  <div>
                    <dt>Job type</dt>
                    <dd>{notesWorkOrder.jobType || '—'}</dd>
                  </div>
                  <div>
                    <dt>Requested</dt>
                    <dd>
                      {notesWorkOrder.appointmentDate
                        ? formatServiceDate(notesWorkOrder.appointmentDate)
                        : '—'}
                      {notesWorkOrder.appointmentTime
                        ? ` at ${notesWorkOrder.appointmentTime}`
                        : ''}
                    </dd>
                  </div>
                </dl>
                <section>
                  <h3>Notes</h3>
                  {omitSalesOrderBoilerplate(notesWorkOrder.notes || '') ? (
                    <NotesWithScheduleHighlight
                      notes={omitSalesOrderBoilerplate(notesWorkOrder.notes || '')}
                      scheduleDate={notesWorkOrder.appointmentDate}
                      evidenceQuote={notesWorkOrder.scheduleEvidenceQuote}
                    />
                  ) : (
                    <p className="teams-test__hint">No notes on this work order.</p>
                  )}
                </section>
              </div>
            </div>
          )}

          {Object.keys(processedWorkOrders).length > 0 && (
            <section className="teams-test__processed">
              <div className="teams-test__processed-header">
                <div>
                  <h2>Channel work orders</h2>
                  <p>
                    PDFs in this channel are imported automatically into Firebase.
                    Edit here only if something needs correction.
                  </p>
                </div>
                <button type="button" onClick={exportWorkOrdersCsv}>
                  Export CSV for Google Sheets
                </button>
              </div>

              {Object.entries(processedWorkOrders).map(([key, processed]) => (
                <WorkOrderReview
                  key={key}
                  workOrder={processed.workOrder}
                  status={processed.status}
                  cached={processed.cached}
                  error={processed.error}
                  onChange={(workOrder) =>
                    setProcessedWorkOrders((current) => ({
                      ...current,
                      [key]: {
                        ...current[key],
                        workOrder,
                        status: 'draft',
                        error: undefined,
                      },
                    }))
                  }
                  onSave={() => handleSaveWorkOrder(key)}
                />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
