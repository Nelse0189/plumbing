import { useEffect, useMemo, useState } from 'react';
import {
  contactsForSmsPhone,
  formatSmsStatus,
  getPhoneSmsStatus,
  issuePhoneSmsToken,
  lookupSmsReplyContacts,
  queuePhoneSms,
  simulatePhoneSmsInbound,
  smsInboxMediaUrl,
  subscribePhoneSmsDevice,
  subscribePhoneSmsInbox,
  subscribePhoneSmsOutbox,
  type PhoneSmsInboxItem,
  type PhoneSmsOutboxItem,
  type PhoneSmsStatus,
  type SmsReplyContact,
} from '../services/phoneSmsService';
import { subscribeWorkOrders } from '../services/workOrderService';
import type { StoredWorkOrder } from '../types';
import './PhoneSms.css';

function formatSeen(value: string | null): { label: string; live: boolean } {
  if (!value) return { label: 'Phone has not checked in yet', live: false };
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return { label: 'Phone has not checked in yet', live: false };
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return { label: 'Phone is idle and checking in', live: true };
  if (seconds < 3600) return { label: `Last seen ${Math.max(1, Math.round(seconds / 60))} min ago`, live: false };
  return { label: `Last seen ${new Date(value).toLocaleString()}`, live: false };
}

function formatStamp(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
}

function formatJobDate(value: string) {
  if (!value) return 'Not scheduled';
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : value;
}

function formatJobStatus(status: string) {
  if (status === 'needs_review') return 'Needs review';
  if (status === 'unscheduled') return 'Unscheduled';
  if (status === 'scheduling') return 'Scheduling';
  if (status === 'scheduled') return 'Scheduled';
  if (status === 'closed') return 'Closed';
  return status || 'Unknown';
}

function InboxReplyWho({
  phone,
  recentOrders,
}: {
  phone: string;
  recentOrders: StoredWorkOrder[];
}) {
  const local = useMemo(
    () => contactsForSmsPhone(phone, recentOrders),
    [phone, recentOrders]
  );
  const [fetched, setFetched] = useState<SmsReplyContact[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (local.length > 0) {
      setFetched(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void lookupSmsReplyContacts(phone)
      .then((contacts) => {
        if (!cancelled) setFetched(contacts);
      })
      .catch((err) => {
        console.warn('SMS contact lookup:', err);
        if (!cancelled) setFetched([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phone, local.length]);

  const contacts = local.length > 0 ? local : fetched || [];
  if (loading && contacts.length === 0) {
    return <p className="phone-sms__who-empty">Looking up this number…</p>;
  }
  if (contacts.length === 0) {
    return (
      <p className="phone-sms__who-empty">No work order found for this number.</p>
    );
  }

  return (
    <div className="phone-sms__who">
      {contacts.map((contact) => (
        <dl key={contact.id} className="phone-sms__who-card">
          <div>
            <dt>Customer</dt>
            <dd>{contact.customerName || 'Unknown customer'}</dd>
          </div>
          <div>
            <dt>Work order</dt>
            <dd>{contact.workOrderNumber || 'No WO#'}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{contact.address || '—'}</dd>
          </div>
          <div>
            <dt>Job</dt>
            <dd>{contact.jobType || '—'}</dd>
          </div>
          <div>
            <dt>Scheduled</dt>
            <dd>
              {formatJobDate(contact.appointmentDate)}
              {contact.appointmentTime ? ` · ${contact.appointmentTime}` : ''}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{formatJobStatus(contact.status)}</dd>
          </div>
        </dl>
      ))}
    </div>
  );
}

export default function PhoneSms() {
  const [status, setStatus] = useState<PhoneSmsStatus | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<PhoneSmsOutboxItem[]>([]);
  const [inbox, setInbox] = useState<PhoneSmsInboxItem[]>([]);
  const [workOrders, setWorkOrders] = useState<StoredWorkOrder[]>([]);
  const [openWhoId, setOpenWhoId] = useState('');
  const [token, setToken] = useState('');
  const [to, setTo] = useState('+18609643025');
  const [body, setBody] = useState('NJ Plumbing test text from the Phone SMS tab.');
  const [from, setFrom] = useState('+18609643025');
  const [inboundBody, setInboundBody] = useState('10:00');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    void getPhoneSmsStatus()
      .then((next) => {
        setStatus(next);
        setLastSeenAt(next.lastSeenAt);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    const stopOutbox = subscribePhoneSmsOutbox(setOutbox, (err) =>
      console.warn('Phone SMS outbox:', err)
    );
    const stopInbox = subscribePhoneSmsInbox(setInbox, (err) =>
      console.warn('Phone SMS inbox:', err)
    );
    const stopDevice = subscribePhoneSmsDevice(setLastSeenAt, (err) =>
      console.warn('Phone SMS device:', err)
    );
    const stopOrders = subscribeWorkOrders(setWorkOrders, (err) =>
      console.warn('Phone SMS work orders:', err)
    );
    return () => {
      stopOutbox();
      stopInbox();
      stopDevice();
      stopOrders();
    };
  }, []);

  const seen = formatSeen(lastSeenAt);

  const handleIssueToken = async () => {
    setBusy('token');
    setError('');
    setNotice('');
    try {
      const next = await issuePhoneSmsToken();
      setStatus(next);
      setToken(next.token);
      setNotice('Save this token on the phone now. It is shown only once.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const handleQueue = async () => {
    setBusy('send');
    setError('');
    setNotice('');
    try {
      const result = await queuePhoneSms(to, body);
      setNotice(`Queued for the phone: ${result.to}`);
      setStatus(await getPhoneSmsStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const handleSimulateInbound = async () => {
    setBusy('inbound');
    setError('');
    setNotice('');
    try {
      await simulatePhoneSmsInbound(from, inboundBody);
      setNotice('Simulated inbound text. Use this until the Android phone is paired.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copied.');
    } catch {
      setError('Could not copy. Select the text instead.');
    }
  };

  return (
    <div className="phone-sms">
      <div className="phone-sms__toolbar">
        <h2>Phone SMS</h2>
        <p>
          Standalone Android texting. Incoming texts and pictures from the
          shop or plumber phone show in the inbox. Queue a message here; the
          Android helper sends it over the SIM unless that phone is in plumber
          listen-only mode.
        </p>
      </div>

      {error ? <div className="phone-sms__error">{error}</div> : null}
      {notice ? <div className="phone-sms__ok">{notice}</div> : null}

      <div className="phone-sms__grid">
        <section className="phone-sms__card">
          <h3>Phone</h3>
          <dl className="phone-sms__status">
            <dt>Pairing</dt>
            <dd>{status?.paired ? `Token ready (…${status.tokenHint || '****'})` : 'Not paired'}</dd>
            <dt>Idle check-in</dt>
            <dd className={seen.live ? 'phone-sms__online' : 'phone-sms__offline'}>
              {seen.label}
            </dd>
            <dt>Waiting to send</dt>
            <dd>{status?.queuedCount ?? outbox.filter((item) => item.status === 'queued' || item.status === 'sending').length}</dd>
          </dl>
          <div className="phone-sms__actions">
            <button
              type="button"
              className="phone-sms__primary"
              disabled={busy === 'token'}
              onClick={() => void handleIssueToken()}
            >
              {status?.paired ? 'Replace phone token' : 'Create phone token'}
            </button>
          </div>
          {token ? (
            <div className="phone-sms__token">
              <div>Phone token</div>
              <code>{token}</code>
              <div className="phone-sms__actions">
                <button type="button" onClick={() => void copy(token)}>
                  Copy token
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="phone-sms__card">
          <h3>Send a test text</h3>
          <div className="phone-sms__form">
            <label>
              To
              <input value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <label>
              Message
              <textarea value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            <div className="phone-sms__actions">
              <button
                type="button"
                className="phone-sms__primary"
                disabled={busy === 'send'}
                onClick={() => void handleQueue()}
              >
                {busy === 'send' ? 'Queuing…' : 'Queue for phone'}
              </button>
            </div>
            <p className="phone-sms__muted">
              Nothing is sent until the Android phone polls and transmits it.
            </p>
          </div>
        </section>

        <section className="phone-sms__card">
          <h3>Simulate a reply</h3>
          <div className="phone-sms__form">
            <label>
              From
              <input value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              Message
              <textarea
                value={inboundBody}
                onChange={(event) => setInboundBody(event.target.value)}
              />
            </label>
            <div className="phone-sms__actions">
              <button
                type="button"
                disabled={busy === 'inbound'}
                onClick={() => void handleSimulateInbound()}
              >
                {busy === 'inbound' ? 'Saving…' : 'Add to inbox'}
              </button>
            </div>
            <p className="phone-sms__muted">
              Use this while waiting for the phone. Replies show here and on the
              Dispatch job that has this number.
            </p>
          </div>
        </section>
      </div>

      <section className="phone-sms__card">
        <h3>Connect the Android phone</h3>
        <ol className="phone-sms__steps">
          <li>
            Preferred: install the <strong>NJ Shop SMS</strong> app from{' '}
            <code>shop-sms-android</code> (sideload the APK). Paste the token,
            allow SMS, disable battery optimization, and tap Start sending. On
            the plumber&apos;s Android, also check{' '}
            <strong>forward texts and pictures only</strong> so this SIM does
            not send the office queue. Pictures in MMS land in the inbox
            below. This cannot run on his iPhone.
          </li>
          <li>
            Create a phone token above. Wi-Fi or data is required so the phone
            can reach Firebase.
          </li>
          <li>
            Tasker or{' '}
            <a href="/phone-sms.html" target="_blank" rel="noreferrer">
              /phone-sms.html
            </a>{' '}
            are backups only. Poll:{' '}
            <code>{status?.pollUrl || 'https://us-central1-nj-plumbing.cloudfunctions.net/smsGatewayPoll'}</code>
          </li>
        </ol>
      </section>

      <div className="phone-sms__grid">
        <section className="phone-sms__card">
          <h3>Outbox</h3>
          {outbox.length === 0 ? (
            <p className="phone-sms__muted">No queued or sent texts yet.</p>
          ) : (
            <div className="phone-sms__list">
              {outbox.map((item) => (
                <article key={item.id} className="phone-sms__row">
                  <strong>
                    {formatSmsStatus(item.status)} · {item.to}
                  </strong>
                  <p>{item.body}</p>
                  <small>
                    {item.status === 'sent' && item.sentAt
                      ? `Sent ${formatStamp(item.sentAt)}`
                      : formatStamp(item.createdAt)}
                    {item.error ? ` · ${item.error}` : ''}
                  </small>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="phone-sms__card">
          <h3>Inbox</h3>
          {inbox.length === 0 ? (
            <p className="phone-sms__muted">No inbound texts yet.</p>
          ) : (
            <div className="phone-sms__list">
              {inbox.map((item) => (
                <article key={item.id} className="phone-sms__row">
                  <div className="phone-sms__row-head">
                    <strong>Reply from {item.from}</strong>
                    <button
                      type="button"
                      className="phone-sms__who-button"
                      aria-expanded={openWhoId === item.id}
                      onClick={() =>
                        setOpenWhoId((current) =>
                          current === item.id ? '' : item.id
                        )
                      }
                    >
                      {openWhoId === item.id ? 'Hide' : 'Who is this?'}
                    </button>
                  </div>
                  {openWhoId === item.id ? (
                    <InboxReplyWho phone={item.from} recentOrders={workOrders} />
                  ) : null}
                  {item.body && item.body !== '(picture)' ? <p>{item.body}</p> : null}
                  {item.attachments?.length ? (
                    <div className="phone-sms__pics">
                      {item.attachments.map((file, index) => (
                        <a
                          key={`${item.id}-${index}`}
                          href={smsInboxMediaUrl(item.id, index)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={smsInboxMediaUrl(item.id, index)}
                            alt={file.name || 'MMS picture'}
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <small>
                    {formatStamp(item.receivedAt)}
                    {item.source ? ` · ${item.source}` : ''}
                  </small>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
