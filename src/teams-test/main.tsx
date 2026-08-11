import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  acquireToken,
  azureConfigError,
  getActiveAccount,
  handleRedirectPromise,
  signIn,
  signOut,
} from './auth';
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
} from './graphClient';
import { extractPdfText } from './pdf';
import WorkOrderReview from './WorkOrderReview';
import {
  importChannelPdfWorkOrder,
  initiateWorkOrderScheduling,
  listWorkOrders,
  saveWorkOrder,
  startTeamsChannelImport,
} from '../services/workOrderService';
import {
  cancelWorkOrderImport,
  subscribeLatestWorkOrderImportProgress,
  type WorkOrderImportProgress,
} from '../services/importProgressService';
import type { StoredWorkOrder, WorkOrder } from '../types';
import '../index.css';
import './teams-test.css';

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

function formatChannelNoteLine(
  message: GraphMessage,
  body: string,
  isReply = false
) {
  const from = message.from?.user?.displayName ?? 'Unknown';
  const stamp = new Date(message.createdDateTime).toLocaleString();
  return `${isReply ? 'Reply — ' : ''}[${stamp} · ${from}] ${body}`;
}

/** Only replies directly underneath the PDF work-order post become job notes. */
function collectChannelNotesForWorkOrder(
  channelMessages: GraphMessage[],
  sourceMessageId: string
): string {
  const post = channelMessages.find((message) => message.id === sourceMessageId);
  return (post?.replies || [])
    .map((reply) => {
      const body = stripHtml(reply.body?.content ?? '').trim();
      return body ? formatChannelNoteLine(reply, body, true) : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function mergeWorkOrderNotes(aiNotes: string, _channelNotes: string) {
  // The server summarizes actionable thread updates. Do not append the raw
  // thread here or generic customer-facing boilerplate returns to the job.
  return aiNotes.trim();
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
    const leftTime = new Date(a.createdDateTime).getTime();
    const rightTime = new Date(b.createdDateTime).getTime();
    return sort === 'oldest' ? leftTime - rightTime : rightTime - leftTime;
  });
  return sorted;
}

// This standalone entry intentionally declares and renders its only component.
// eslint-disable-next-line react-refresh/only-export-components
function TeamsGraphTestApp() {
  const [loading, setLoading] = useState(true);
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
  const [cancelingImport, setCancelingImport] = useState(false);
  const [importProgress, setImportProgress] =
    useState<WorkOrderImportProgress | null>(null);
  const [schedulingWorkOrderId, setSchedulingWorkOrderId] = useState<string | null>(
    null
  );
  const [notesWorkOrderId, setNotesWorkOrderId] = useState<string | null>(null);
  const channelImportGenerationRef = useRef(0);
  const notesWorkOrder = useMemo(
    () => storedWorkOrders.find((item) => item.id === notesWorkOrderId) || null,
    [notesWorkOrderId, storedWorkOrders]
  );

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const [selectedTeamName, setSelectedTeamName] = useState('');
  const [selectedChannelName, setSelectedChannelName] = useState('');
  const [messageSort, setMessageSort] = useState<MessageSort>('newest');

  const sortedMessages = useMemo(
    () => sortMessages(messages, messageSort),
    [messages, messageSort]
  );

  const refreshWorkOrders = useCallback(async (showLoading = false) => {
    if (!getActiveAccount()) return;
    if (showLoading) setQueueLoading(true);
    setQueueError(null);
    try {
      setStoredWorkOrders(await listWorkOrders(await acquireToken()));
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showLoading) setQueueLoading(false);
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
      await refreshWorkOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSignedIn(false);
    } finally {
      setLoading(false);
    }
  }, [refreshWorkOrders]);

  useEffect(() => {
    if (azureConfigError) {
      setError(azureConfigError);
      setLoading(false);
      return;
    }
    handleRedirectPromise()
      .then(() => loadSignedInState())
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [loadSignedInState]);

  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setInterval(() => {
      void refreshWorkOrders();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refreshWorkOrders, signedIn]);

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
    setProcessedWorkOrders({});
    setChannelImportStatus(null);
    clearPdfCache();
    channelImportGenerationRef.current += 1;

    try {
      const response = await getChannelMessages(selectedTeamId, channel.id);
      setMessages(response.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImportLastTwoWeeks = async () => {
    if (!selectedTeamId || !selectedChannelId || weeklyImportLoading) return;

    setWeeklyImportLoading(true);
    setError(null);
    try {
      const run = await startTeamsChannelImport({
        teamId: selectedTeamId,
        channelId: selectedChannelId,
        channelName: selectedChannelName || 'Teams channel',
        days: 14,
        microsoftAccessToken: await acquireToken(),
      });
      setChannelImportStatus(
        `Background import queued (${run.runId}). You can leave this page; Dispatch will show progress.`
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
      setQueueError(err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulingWorkOrderId(null);
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
              disabled={Boolean(azureConfigError)}
              onClick={() => signIn()}
            >
              Sign in with Microsoft
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
                  <button
                    type="button"
                    className="teams-test__weekly-import"
                    disabled={weeklyImportLoading || !selectedChannelId}
                    onClick={() => void handleImportLastTwoWeeks()}
                  >
                    {weeklyImportLoading
                      ? 'Importing last 14 days…'
                      : 'Import last 14 days'}
                  </button>
                </div>
              )}
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
            ) : (
              <ul className="teams-test__message-list">
                {sortedMessages.map((message) => (
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
                    <p>{stripHtml(message.body?.content ?? '')}</p>
                    {(message.replies?.length || 0) > 0 && (
                      <details className="teams-test__thread">
                        <summary>
                          View thread ({message.replies?.length} repl
                          {message.replies?.length === 1 ? 'y' : 'ies'})
                        </summary>
                        <ul>
                          {message.replies?.map((reply) => (
                            <li key={reply.id}>
                              <div className="teams-test__thread-meta">
                                <strong>
                                  {reply.from?.user?.displayName ?? 'Unknown'}
                                </strong>
                                <span>
                                  {new Date(reply.createdDateTime).toLocaleString()}
                                </span>
                              </div>
                              <p>{stripHtml(reply.body?.content ?? '')}</p>
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
                  </li>
                ))}
              </ul>
            )}
            </main>
          </div>

          <section className="teams-test__processed">
            <div className="teams-test__processed-header">
              <div>
                <h2>Scheduling database</h2>
                <p>
                  Scheduling texts are routed only to +1 860-964-3025 during
                  testing.
                </p>
              </div>
              <div className="teams-test__attachment-actions">
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

            {queueError && <div className="teams-test__error">{queueError}</div>}

            <div className="teams-test__job-columns">
              {(
                ['needs_review', 'unscheduled', 'scheduling', 'scheduled'] as const
              ).map((status) => {
                  const jobs = storedWorkOrders.filter(
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
                        <p className="teams-test__hint">No jobs</p>
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
                              {workOrder.appointmentDate}
                              {workOrder.appointmentTime
                                ? ` at ${workOrder.appointmentTime}`
                                : ''}
                            </span>
                            <span>{workOrder.address}</span>
                            <span>
                              Customer phone on file: {workOrder.phone}
                            </span>
                            <button
                              type="button"
                              className="teams-test__notes-button"
                              onClick={() => setNotesWorkOrderId(workOrder.id)}
                            >
                              {workOrder.notes?.trim()
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
                            {status === 'scheduling' && (
                              <span className="teams-test__job-status">
                                Waiting for a reply from the test phone
                              </span>
                            )}
                            {status === 'scheduled' && (
                              <span className="teams-test__job-status">
                                Confirmed for{' '}
                                {workOrder.selectedTime ||
                                  workOrder.appointmentTime}
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
                    <dd>{notesWorkOrder.phone || '—'}</dd>
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
                      {notesWorkOrder.appointmentDate || '—'}
                      {notesWorkOrder.appointmentTime
                        ? ` at ${notesWorkOrder.appointmentTime}`
                        : ''}
                    </dd>
                  </div>
                </dl>
                <section>
                  <h3>Notes</h3>
                  {notesWorkOrder.notes?.trim() ? (
                    <pre>{notesWorkOrder.notes}</pre>
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TeamsGraphTestApp />
  </StrictMode>
);
