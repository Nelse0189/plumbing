import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
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
import '../index.css';
import './teams-test.css';

interface PdfResult {
  loading?: boolean;
  text?: string;
  error?: string;
}

function stripHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent?.trim() ?? '';
}

function TeamsGraphTestApp() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [profileName, setProfileName] = useState('');

  const [teams, setTeams] = useState<GraphTeam[]>([]);
  const [channels, setChannels] = useState<GraphChannel[]>([]);
  const [messages, setMessages] = useState<GraphMessage[]>([]);
  const [pdfResults, setPdfResults] = useState<Record<string, PdfResult>>({});

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const [selectedTeamName, setSelectedTeamName] = useState('');
  const [selectedChannelName, setSelectedChannelName] = useState('');

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSignedIn(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    handleRedirectPromise()
      .then(() => loadSignedInState())
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [loadSignedInState]);

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

  const handleReadPdf = async (
    messageId: string,
    attachment: GraphAttachment
  ) => {
    if (!selectedTeamId) return;

    const key = `${messageId}:${attachment.id}`;
    setPdfResults((current) => ({
      ...current,
      [key]: { loading: true },
    }));

    try {
      const data = await downloadChannelAttachment(selectedTeamId, attachment);
      const text = await extractPdfText(data);
      setPdfResults((current) => ({
        ...current,
        [key]: { text: text || 'No readable text was found in this PDF.' },
      }));
    } catch (err) {
      setPdfResults((current) => ({
        ...current,
        [key]: {
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
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
                              <button
                                type="button"
                                disabled={result?.loading}
                                onClick={() => handleReadPdf(message.id, attachment)}
                              >
                                {result?.loading
                                  ? 'Reading…'
                                  : result?.text
                                    ? 'Read again'
                                    : 'Read PDF'}
                              </button>
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
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TeamsGraphTestApp />
  </StrictMode>
);
