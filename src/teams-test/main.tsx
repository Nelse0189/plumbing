import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  acquireToken,
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
  extractWorkOrder as extractStructuredWorkOrder,
  initiateWorkOrderScheduling,
  listWorkOrders,
  saveWorkOrder,
} from '../services/workOrderService';
import type { StoredWorkOrder, WorkOrder } from '../types';
import '../index.css';
import './teams-test.css';

interface PdfResult {
  loading?: boolean;
  text?: string;
  error?: string;
}

interface ProcessedWorkOrder {
  workOrder: WorkOrder;
  status: 'draft' | 'saving' | 'saved';
  error?: string;
}

function stripHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent?.trim() ?? '';
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
  const [processingKeys, setProcessingKeys] = useState<Record<string, boolean>>({});
  const [processedWorkOrders, setProcessedWorkOrders] = useState<
    Record<string, ProcessedWorkOrder>
  >({});
  const [storedWorkOrders, setStoredWorkOrders] = useState<StoredWorkOrder[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [schedulingWorkOrderId, setSchedulingWorkOrderId] = useState<string | null>(
    null
  );

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const [selectedTeamName, setSelectedTeamName] = useState('');
  const [selectedChannelName, setSelectedChannelName] = useState('');

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

  const handleSelectTeam = async (team: GraphTeam) => {
    setError(null);
    setSelectedTeamId(team.id);
    setSelectedTeamName(team.displayName);
    setSelectedChannelId(null);
    setSelectedChannelName('');
    setMessages([]);

    try {
      const response = await getTeamChannels(team.id);
      setChannels(response.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectChannel = async (channel: GraphChannel) => {
    if (!selectedTeamId) return;
    setError(null);
    setSelectedChannelId(channel.id);
    setSelectedChannelName(channel.displayName);
    setMessages([]);

    try {
      const response = await getChannelMessages(selectedTeamId, channel.id);
      setMessages(response.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const readPdfText = async (
    messageId: string,
    attachment: GraphAttachment
  ): Promise<string> => {
    if (!selectedTeamId || !selectedChannelId) {
      throw new Error('Select a team and channel first.');
    }

    const key = `${messageId}:${attachment.id}`;
    setPdfResults((current) => ({
      ...current,
      [key]: { ...current[key], loading: true, error: undefined },
    }));

    try {
      const data = await downloadChannelAttachment(
        selectedTeamId,
        selectedChannelId,
        attachment
      );
      const text = await extractPdfText(data);
      const readableText = text || 'No readable text was found in this PDF.';
      setPdfResults((current) => ({
        ...current,
        [key]: { text: readableText },
      }));
      return readableText;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPdfResults((current) => ({
        ...current,
        [key]: {
          error: message,
        },
      }));
      throw new Error(message);
    }
  };

  const handleProcessWorkOrder = async (
    messageId: string,
    attachment: GraphAttachment
  ) => {
    const key = `${messageId}:${attachment.id}`;
    setProcessingKeys((current) => ({ ...current, [key]: true }));

    try {
      const text = pdfResults[key]?.text ?? (await readPdfText(messageId, attachment));
      if (text === 'No readable text was found in this PDF.') {
        throw new Error(
          'This appears to be a scanned PDF. OCR is required before AI extraction.'
        );
      }

      const workOrder = await extractStructuredWorkOrder(
        text,
        attachment.name ?? 'work-order.pdf',
        await acquireToken()
      );
      setProcessedWorkOrders((current) => ({
        ...current,
        [key]: { workOrder, status: 'draft' },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPdfResults((current) => ({
        ...current,
        [key]: { ...current[key], error: message },
      }));
    } finally {
      setProcessingKeys((current) => ({ ...current, [key]: false }));
    }
  };

  const handleSaveWorkOrder = async (key: string) => {
    const processed = processedWorkOrders[key];
    if (!processed) return;

    setProcessedWorkOrders((current) => ({
      ...current,
      [key]: { ...processed, status: 'saving', error: undefined },
    }));

    try {
      await saveWorkOrder(processed.workOrder, await acquireToken());
      setProcessedWorkOrders((current) => ({
        ...current,
        [key]: {
          ...current[key],
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
          {signedIn && <span className="teams-test__profile">{profileName}</span>}
          {signedIn ? (
            <button type="button" onClick={() => signOut()}>
              Sign out
            </button>
          ) : (
            <button type="button" onClick={() => signIn()}>
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
            <h2>
              Messages
              {selectedChannelName
                ? ` — ${selectedTeamName} / ${selectedChannelName}`
                : ''}
            </h2>

            {messages.length === 0 ? (
              <p className="teams-test__hint">
                Select a team and channel to load messages
              </p>
            ) : (
              <ul className="teams-test__message-list">
                {messages.map((message) => (
                  <li key={message.id} className="teams-test__message">
                    <div className="teams-test__message-meta">
                      <strong>{message.from?.user?.displayName ?? 'Unknown'}</strong>
                      <span>{new Date(message.createdDateTime).toLocaleString()}</span>
                    </div>
                    <p>{stripHtml(message.body?.content ?? '')}</p>
                    {message.attachments
                      ?.filter(
                        (attachment) =>
                          attachment.name?.toLowerCase().endsWith('.pdf') ||
                          attachment.contentType === 'application/pdf'
                      )
                      .map((attachment) => {
                        const key = `${message.id}:${attachment.id}`;
                        const result = pdfResults[key];

                        return (
                          <div key={attachment.id} className="teams-test__attachment">
                            <div className="teams-test__attachment-header">
                              <span>PDF: {attachment.name ?? 'Attachment'}</span>
                              <div className="teams-test__attachment-actions">
                                <button
                                  type="button"
                                  disabled={result?.loading}
                                  onClick={() => {
                                    void readPdfText(message.id, attachment).catch(
                                      () => undefined
                                    );
                                  }}
                                >
                                  {result?.loading
                                    ? 'Reading…'
                                    : result?.text
                                      ? 'Read again'
                                      : 'Read PDF'}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    result?.loading ||
                                    processingKeys[key] ||
                                    Boolean(processedWorkOrders[key])
                                  }
                                  onClick={() =>
                                    handleProcessWorkOrder(message.id, attachment)
                                  }
                                >
                                  {processingKeys[key]
                                    ? 'Processing…'
                                    : processedWorkOrders[key]
                                      ? 'Processed'
                                      : 'Process work order'}
                                </button>
                              </div>
                            </div>
                            {attachment.contentUrl && (
                              <a
                                href={attachment.contentUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open in Teams / SharePoint
                              </a>
                            )}
                            {result?.error && (
                              <p className="teams-test__attachment-error">
                                {result.error}
                              </p>
                            )}
                            {result?.text && (
                              <pre className="teams-test__pdf-text">{result.text}</pre>
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
              {(['unscheduled', 'scheduling', 'scheduled'] as const).map(
                (status) => {
                  const jobs = storedWorkOrders.filter(
                    (workOrder) => workOrder.status === status
                  );
                  return (
                    <div key={status} className="teams-test__job-column">
                      <h3>
                        {status === 'unscheduled'
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

          {Object.keys(processedWorkOrders).length > 0 && (
            <section className="teams-test__processed">
              <div className="teams-test__processed-header">
                <div>
                  <h2>Processed work orders</h2>
                  <p>
                    Review each record before scheduling customer communication.
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
