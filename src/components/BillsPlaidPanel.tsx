import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { formatUsd } from '../services/billWorkbookService';
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  formatPlaidCallableError,
  getPlaidConnection,
  listPlaidTransactions,
  syncPlaidTransactions,
  type PlaidItemSummary,
  type PlaidTransaction,
} from '../services/plaidService';

const PLAID_LINK_TOKEN_KEY = 'njplumbing.plaid.linkToken';

function PlaidLinkOpener({
  token,
  receivedRedirectUri,
  onSuccess,
  onExit,
}: {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string; institution_id?: string } | null }) => void;
  onExit: () => void;
}) {
  const opened = useRef(false);
  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri,
    onSuccess: (publicToken, metadata) => {
      if (!publicToken) return;
      sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY);
      onSuccess(publicToken, metadata);
    },
    onExit: () => {
      sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY);
      onExit();
    },
  });

  useEffect(() => {
    if (!ready || opened.current) return;
    opened.current = true;
    open();
  }, [open, ready]);

  return null;
}

export default function BillsPlaidPanel() {
  const oauthReturn = typeof window !== 'undefined' && /oauth_state_id=/i.test(window.location.search);
  const [items, setItems] = useState<PlaidItemSummary[]>([]);
  const [transactions, setTransactions] = useState<PlaidTransaction[]>([]);
  const [environment, setEnvironment] = useState('production');
  const [configured, setConfigured] = useState(true);
  const [linkToken, setLinkToken] = useState(() =>
    oauthReturn ? sessionStorage.getItem(PLAID_LINK_TOKEN_KEY) || '' : ''
  );
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(Boolean(linkToken));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    const [connection, txs] = await Promise.all([getPlaidConnection(), listPlaidTransactions()]);
    setItems(connection.items);
    setEnvironment(connection.environment);
    setConfigured(connection.configured);
    setTransactions(txs);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        setError(formatPlaidCallableError(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const connectBank = async () => {
    setError('');
    setStatus('');
    setWorking(true);
    try {
      const created = await createPlaidLinkToken();
      setEnvironment(created.environment);
      sessionStorage.setItem(PLAID_LINK_TOKEN_KEY, created.linkToken);
      setLinkToken(created.linkToken);
    } catch (err) {
      setError(formatPlaidCallableError(err));
      setWorking(false);
    }
  };

  const onLinkSuccess = async (
    publicToken: string,
    metadata: { institution?: { name?: string; institution_id?: string } | null }
  ) => {
    setLinkToken('');
    try {
      const exchanged = await exchangePlaidPublicToken({
        publicToken,
        institution: metadata.institution
          ? {
              name: metadata.institution.name,
              institution_id: metadata.institution.institution_id,
            }
          : undefined,
      });
      const synced = await syncPlaidTransactions();
      await refresh();
      setStatus(
        `Connected ${exchanged.institutionName || 'bank'} (${exchanged.environment}). Synced ${synced.added} transactions.`
      );
    } catch (err) {
      setError(formatPlaidCallableError(err));
    } finally {
      setWorking(false);
    }
  };

  const onSync = async () => {
    setError('');
    setStatus('');
    setWorking(true);
    try {
      const synced = await syncPlaidTransactions();
      await refresh();
      setStatus(
        `Synced transactions: ${synced.added} added, ${synced.modified} updated, ${synced.removed} removed.`
      );
    } catch (err) {
      setError(formatPlaidCallableError(err));
    } finally {
      setWorking(false);
    }
  };

  const connectedLabel = items
    .map((item) => item.institutionName || item.itemId)
    .filter(Boolean)
    .join(', ');

  return (
    <section className="bills__card bills__card--wide bills__plaid">
      <div className="bills__plaid-head">
        <div>
          <h3>Bank transactions</h3>
          <p>
            Live Plaid feed for Bills. Environment: <code>{environment}</code>
            {connectedLabel ? ` · ${connectedLabel}` : ''}. Click Connect bank, then sign in with
            your real bank credentials. For Chase and other OAuth banks, add{' '}
            <code>http://localhost:5173</code> and <code>https://nj-plumbing.web.app</code> as
            Allowed redirect URIs in the Plaid Dashboard.
          </p>
        </div>
        <div className="bills__plaid-actions">
          <button type="button" disabled={working || !configured} onClick={() => void connectBank()}>
            {working && linkToken ? 'Opening Link…' : items.length ? 'Connect another bank' : 'Connect bank'}
          </button>
          <button type="button" disabled={working || items.length === 0} onClick={() => void onSync()}>
            {working && !linkToken ? 'Syncing…' : 'Sync transactions'}
          </button>
        </div>
      </div>

      {linkToken ? (
        <PlaidLinkOpener
          token={linkToken}
          receivedRedirectUri={oauthReturn ? window.location.href : undefined}
          onSuccess={(publicToken, metadata) => void onLinkSuccess(publicToken, metadata)}
          onExit={() => {
            setLinkToken('');
            setWorking(false);
          }}
        />
      ) : null}

      {!configured ? (
        <p className="bills__muted">
          Plaid keys are not live yet. Set <code>PLAID_ENV=production</code> and the Production
          secret in <code>functions/.env.nj-plumbing</code>, then run <code>npm run deploy:functions</code>.
        </p>
      ) : null}
      {error ? <div className="bills__error">{error}</div> : null}
      {status ? <div className="bills__status">{status}</div> : null}
      {loading ? <p className="bills__muted">Checking Plaid connection…</p> : null}

      {!loading && transactions.length === 0 && items.length === 0 ? (
        <p className="bills__muted">No bank connected yet.</p>
      ) : null}

      {transactions.length > 0 ? (
        <div className="bills__table-wrap">
          <table className="bills__table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Name</th>
                <th>Category</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.transactionId}>
                  <td>{tx.date}</td>
                  <td>
                    {tx.merchantName || tx.name}
                    {tx.pending ? <span className="bills__muted"> · pending</span> : null}
                  </td>
                  <td>{tx.category || '—'}</td>
                  <td>{formatUsd(tx.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
