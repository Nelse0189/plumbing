const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const BASES = ['https://api.plaud.ai', 'https://api-eu.plaud.ai', 'https://api-euc1.plaud.ai'];

function jwtFrom(value) {
  const match = String(value || '').match(JWT_RE);
  return match ? match[0] : '';
}

function jwtTyp(token) {
  try {
    const part = String(token || '').split('.')[1] || '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
    return String(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).typ || '').toUpperCase();
  } catch {
    return '';
  }
}

function cookiePairs(header) {
  const pairs = new Map();
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    pairs.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return pairs;
}

function tokenFromCookieHeader(header, preferred = ['pld_wt', 'pld-wt', 'pld_ut', 'pld-ut']) {
  const pairs = cookiePairs(header);
  for (const name of preferred) {
    const found = jwtFrom(pairs.get(name) || '');
    if (found) return found;
  }
  const all = String(header || '').match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
  return all.find((token) => jwtTyp(token) === 'WT') || all.find((token) => jwtTyp(token) === 'UT') || '';
}

function epochToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

function filesFromPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const raw =
    data.data_file_list ||
    payload?.data_file_list ||
    data.file_list ||
    data.files ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const id = String(item?.id || item?.file_id || item?.fileId || '');
      if (!id) return null;
      const started =
        epochToIso(item.start_time) ||
        String(item.start_at || item.startAt || item.created_at || item.createdAt || '');
      return {
        id,
        name: String(item.name || item.filename || item.file_name || item.fullname || '') || undefined,
        created_at: started || undefined,
        start_at: started || undefined,
        duration: typeof item.duration === 'number' ? item.duration : Number(item.duration) || undefined,
        serial_number: String(item.serial_number || item.serialNumber || '') || undefined,
      };
    })
    .filter(Boolean);
}

function libraryTotal(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const total = Number(payload?.data_file_total ?? data.data_file_total ?? payload?.total ?? data.total);
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

function isMismatch(payload) {
  const status = payload?.status;
  const msg = String(payload?.msg || '').toLowerCase();
  return status === -3901 || status === '-3901' || msg.includes('token type does not match');
}

function fileListPath(skip, limit) {
  return `/file/simple/web?skip=${skip}&limit=${limit}&is_trash=0&sort_by=start_time&is_desc=true`;
}

function callDate(startedAt) {
  const parsed = new Date(startedAt || '');
  const timeZone = 'America/New_York';
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toLocaleDateString('en-CA', { timeZone });
  }
  return parsed.toLocaleDateString('en-CA', { timeZone });
}

function plaudHeaders(token) {
  const headers = {
    Accept: 'application/json',
    'app-platform': 'web',
    'edit-from': 'web',
    Origin: 'https://web.plaud.ai',
    Referer: 'https://web.plaud.ai/',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    const typ = jwtTyp(token);
    headers.Cookie = typ === 'UT' ? `pld_ut=${token}` : `pld_wt=${token}`;
  }
  return headers;
}

async function sessionJson(ses, url, init = {}) {
  const response = await ses.fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload, url };
}

async function mintWorkspaceToken(ses, base, userToken) {
  const listed = await sessionJson(ses, `${base}/team-app/workspaces/list?need_personal_workspace=true`, {
    headers: plaudHeaders(userToken),
  });
  const workspaces = listed.payload?.data?.workspaces || [];
  const workspaceId = String(workspaces[0]?.workspace_id || workspaces[0]?.id || '');
  if (!workspaceId) return '';
  const minted = await sessionJson(ses, `${base}/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    headers: { ...plaudHeaders(userToken), 'Content-Type': 'application/json' },
    body: '{}',
  });
  return String(
    minted.payload?.data?.workspace_token ||
      minted.payload?.data?.workspaceToken ||
      minted.payload?.data?.token ||
      ''
  );
}

async function listWithToken(ses, base, token, maxPages, pageSize) {
  const files = [];
  let total;
  let currentBase = base;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await sessionJson(ses, `${currentBase}${fileListPath(page * pageSize, pageSize)}`, {
      headers: plaudHeaders(token),
    });
    const redirect = result.payload?.data?.domains?.api || result.payload?.data?.api;
    if (result.payload?.status === -302 && typeof redirect === 'string' && redirect.startsWith('https://')) {
      currentBase = redirect.replace(/\/$/, '');
      page -= 1;
      continue;
    }
    if (isMismatch(result.payload)) {
      return { mismatch: true, files: [], total: 0, apiBase: currentBase };
    }
    const batch = filesFromPayload(result.payload);
    if (total === undefined) total = libraryTotal(result.payload);
    files.push(...batch);
    if (!batch.length || batch.length < pageSize) break;
    if (total !== undefined && files.length >= total) break;
  }
  return { files, total: total ?? files.length, apiBase: currentBase, mismatch: false };
}

export async function listPlaudLibrary(ses, options = {}) {
  const cookieHeader = options.cookieHeader || '';
  const captured = jwtFrom(String(options.authorization || '').replace(/^(bearer|wt|ut|wrt)\s+/i, ''));
  const wt = tokenFromCookieHeader(cookieHeader, ['pld_wt', 'pld-wt']) || (jwtTyp(captured) === 'WT' ? captured : '');
  const ut =
    tokenFromCookieHeader(cookieHeader, ['pld_ut', 'pld-ut']) || (jwtTyp(captured) === 'UT' ? captured : '');
  const maxPages = options.allTime ? 20 : 6;
  const pageSize = options.allTime ? 100 : 50;
  let best = { files: [], token: '', total: 0, apiBase: BASES[0] };

  for (const base of BASES) {
    const tokens = [...new Set([wt, captured, ut].filter(Boolean)), ''];
    for (const token of tokens) {
      let listed = await listWithToken(ses, base, token, maxPages, pageSize);
      if (listed.mismatch && ut && jwtTyp(token) !== 'WT') {
        const minted = await mintWorkspaceToken(ses, listed.apiBase || base, ut);
        if (minted) listed = await listWithToken(ses, listed.apiBase || base, minted, maxPages, pageSize);
      }
      if (listed.files.length > best.files.length) {
        const used = jwtTyp(token) === 'WT' ? token : tokenFromCookieHeader(`pld_wt=${token}`) || wt || token;
        best = {
          files: listed.files,
          token: used && jwtTyp(used) === 'WT' ? `pld_wt=${used}` : used || '',
          total: listed.total,
          apiBase: listed.apiBase || base,
        };
      }
      if (listed.files.length) break;
    }
    if (best.files.length) break;
  }

  const date = String(options.date || '');
  const files = date
    ? best.files.filter((file) => callDate(file.start_at || file.created_at) === date)
    : best.files;
  if (best.files.length) {
    console.log(`Plaud: this PC listed ${best.files.length} recordings${date ? `, ${files.length} on ${date}` : ''}`);
  }
  return { ...best, files };
}

export function workspaceTokenFromResult(result) {
  return jwtFrom(result?.token || '');
}
