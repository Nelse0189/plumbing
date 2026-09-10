import { acquireToken, graphWriteScopes } from './auth';

async function graphFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown; scopes?: string[] }
): Promise<T> {
  const response = await graphRequest(path, init);
  return response.json() as Promise<T>;
}

function graphErrorMessage(path: string, status: number, statusText: string, body: string) {
  const blob = body.trim();
  if (status === 403 || /Authorization_RequestDenied|InsufficientPrivileges/i.test(blob)) {
    return 'Microsoft Graph denied this Teams write. Add delegated ChannelMessage.Send on the Azure app, have an admin grant consent, then sign out and back in.';
  }
  return `Graph request failed for ${path}: ${status} ${statusText}: ${blob}`;
}

async function graphRequest(
  path: string,
  init?: { method?: string; body?: unknown; scopes?: string[] }
): Promise<Response> {
  const token = await acquireToken(init?.scopes);
  const url = path.startsWith('https://')
    ? path
    : `https://graph.microsoft.com/v1.0${path}`;
  const response = await fetch(url, {
    method: init?.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(graphErrorMessage(path, response.status, response.statusText, body));
  }

  return response;
}

export interface GraphTeam {
  id: string;
  displayName: string;
  description?: string;
}

export interface GraphChannel {
  id: string;
  displayName: string;
  description?: string;
}

export interface GraphChat {
  id: string;
  topic?: string;
  chatType: string;
}

export interface GraphMessage {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  subject?: string;
  from?: {
    user?: {
      displayName?: string;
    };
  };
  body?: {
    content?: string;
  };
  attachments?: GraphAttachment[];
  replies?: GraphMessage[];
}

export interface GraphAttachment {
  id: string;
  contentType?: string;
  contentUrl?: string;
  name?: string;
}

interface ChannelFilesFolder {
  id: string;
  webUrl?: string;
  parentReference?: {
    driveId?: string;
  };
}

interface ListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export function getJoinedTeams() {
  return graphFetch<ListResponse<GraphTeam>>('/me/joinedTeams');
}

export function getTeamChannels(teamId: string) {
  return graphFetch<ListResponse<GraphChannel>>(
    `/teams/${teamId}/channels`
  );
}

async function addRepliesToMessages(
  teamId: string,
  channelId: string,
  posts: GraphMessage[]
) {
  // Channel posts and their replies are separate Graph resources. Fetch the
  // thread for each post so the UI and work-order notes match what Teams shows.
  const messages: GraphMessage[] = [];
  // Keep this deliberately sequential to avoid Graph throttling on busy channels.
  for (const message of posts) {
    try {
      const replies = await graphFetch<ListResponse<GraphMessage>>(
        `/teams/${teamId}/channels/${channelId}/messages/${message.id}/replies?$top=50`
      );
      messages.push({ ...message, replies: replies.value });
    } catch {
      // A missing/denied reply thread should not hide the channel post.
      messages.push({ ...message, replies: [] });
    }
  }
  return messages;
}

/**
 * Loads channel posts with any activity (new post OR new comment) in the last
 * `days`. Graph's plain message list is ordered by original post date, so an
 * old post with a comment this morning never shows in the top of that list.
 * Delta instead returns every message created or changed after the cutoff;
 * comments carry replyToId, which leads back to the root post.
 */
export async function getChannelMessages(
  teamId: string,
  channelId: string,
  days = 7
) {
  let roots: GraphMessage[];
  try {
    roots = await getActiveChannelRootsViaDelta(teamId, channelId, days);
  } catch {
    // Channel delta intermittently 400s on some channels; fall back to the
    // plain list so the panel still shows something.
    const response = await graphFetch<ListResponse<GraphMessage>>(
      `/teams/${teamId}/channels/${channelId}/messages?$top=25`
    );
    roots = response.value;
  }
  return { value: await addRepliesToMessages(teamId, channelId, roots) };
}

interface DeltaMessage extends GraphMessage {
  replyToId?: string;
  messageType?: string;
  deletedDateTime?: string;
}

async function getActiveChannelRootsViaDelta(
  teamId: string,
  channelId: string,
  days: number
): Promise<GraphMessage[]> {
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const filter = encodeURIComponent(`lastModifiedDateTime gt ${cutoffIso}`);
  let next:
    | string
    | undefined = `/teams/${teamId}/channels/${channelId}/messages/delta?$filter=${filter}`;
  const rootsById = new Map<string, GraphMessage | null>();
  let pages = 0;

  while (next && pages < 50) {
    const page: ListResponse<DeltaMessage> = await graphFetch<
      ListResponse<DeltaMessage>
    >(next);
    pages += 1;
    for (const message of page.value || []) {
      if (!message.id || message.deletedDateTime) continue;
      if (message.messageType && message.messageType !== 'message') continue;
      const rootId = message.replyToId?.trim();
      if (rootId) {
        // A comment: remember its parent post and fetch that post below.
        if (!rootsById.has(rootId)) rootsById.set(rootId, null);
      } else {
        rootsById.set(message.id, message);
      }
    }
    next = page['@odata.nextLink'];
  }

  for (const [id, post] of rootsById) {
    if (post) continue;
    try {
      const fetched = await graphFetch<DeltaMessage>(
        `/teams/${teamId}/channels/${channelId}/messages/${id}`
      );
      if (fetched.id && !fetched.deletedDateTime) rootsById.set(id, fetched);
    } catch {
      // Parent post may be deleted or inaccessible; skip it.
    }
  }

  const roots = [...rootsById.values()].filter((post): post is GraphMessage =>
    Boolean(post?.id)
  );
  // Newest activity first, matching how Teams orders the channel view.
  return roots.sort((a, b) => teamsThreadActivityMs(b) - teamsThreadActivityMs(a));
}

function teamsThreadActivityMs(message: {
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  replies?: Array<{ createdDateTime?: string; lastModifiedDateTime?: string }>;
}): number {
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

function getDriveRelativePath(contentUrl: string) {
  const pathname = decodeURIComponent(new URL(contentUrl).pathname);
  const documentLibrary = '/Shared Documents/';
  const index = pathname.toLowerCase().indexOf(documentLibrary.toLowerCase());

  if (index === -1) {
    throw new Error('The attachment is not in the team Shared Documents library.');
  }

  return pathname.slice(index + documentLibrary.length);
}

function getSharingToken(contentUrl: string) {
  const bytes = new TextEncoder().encode(contentUrl);
  let binary = '';

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return `u!${btoa(binary)
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')}`;
}

function encodeGraphPath(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function getPathRelativeToFolder(
  contentUrl: string,
  folderWebUrl: string | undefined,
  fallbackName: string | undefined
) {
  if (folderWebUrl) {
    const attachmentPath = decodeURIComponent(new URL(contentUrl).pathname);
    const folderPath = decodeURIComponent(new URL(folderWebUrl).pathname).replace(
      /\/$/,
      ''
    );
    if (attachmentPath.toLowerCase().startsWith(`${folderPath.toLowerCase()}/`)) {
      return attachmentPath.slice(folderPath.length + 1);
    }
  }

  if (fallbackName) return fallbackName;
  throw new Error('Could not determine the attachment path in the channel drive.');
}

export async function getChannelMessage(
  teamId: string,
  channelId: string,
  messageId: string
): Promise<GraphMessage> {
  return graphFetch<GraphMessage>(
    `/teams/${teamId}/channels/${channelId}/messages/${messageId}`
  );
}

export async function downloadTeamsWorkOrderPdf(input: {
  teamId: string;
  channelId: string;
  messageId: string;
  attachmentId?: string;
}): Promise<ArrayBuffer> {
  const post = await getChannelMessage(input.teamId, input.channelId, input.messageId);
  const attachments = post.attachments || [];
  const wanted =
    attachments.find((item) => item.id && item.id === input.attachmentId) ||
    attachments.find(
      (item) =>
        item.name?.toLowerCase().endsWith('.pdf') || item.contentType === 'application/pdf'
    );
  if (!wanted) {
    throw new Error('That Teams post does not have a work-order PDF.');
  }
  return downloadChannelAttachment(input.teamId, input.channelId, wanted);
}

export async function downloadChannelAttachment(
  teamId: string,
  channelId: string,
  attachment: GraphAttachment
) {
  if (!attachment.contentUrl) {
    throw new Error('This attachment does not include a download URL.');
  }

  const failures: Error[] = [];

  try {
    const folder = await graphFetch<ChannelFilesFolder>(
      `/teams/${teamId}/channels/${channelId}/filesFolder`
    );
    const driveId = folder.parentReference?.driveId;
    if (!driveId) {
      throw new Error('The channel files folder did not include a drive ID.');
    }

    const relativePath = getPathRelativeToFolder(
      attachment.contentUrl,
      folder.webUrl,
      attachment.name
    );
    const response = await graphRequest(
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(
        folder.id
      )}:/${encodeGraphPath(relativePath)}:/content`
    );
    return response.arrayBuffer();
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    const relativePath = getDriveRelativePath(attachment.contentUrl);
    const response = await graphRequest(
      `/groups/${teamId}/drive/root:/${encodeGraphPath(relativePath)}:/content`
    );
    return response.arrayBuffer();
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    const sharingToken = getSharingToken(attachment.contentUrl);
    const response = await graphRequest(
      `/shares/${sharingToken}/driveItem/content`
    );
    return response.arrayBuffer();
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }

  if (failures.some((failure) => failure.message.includes('403'))) {
    throw new Error(
      'Microsoft Graph denied access to this channel file (403). Confirm delegated Files.Read.All is granted by an administrator, then sign out and back in.'
    );
  }

  throw new Error(failures.map((failure) => failure.message).join('\n'));
}

export function getChats() {
  return graphFetch<ListResponse<GraphChat>>('/me/chats?$top=25');
}

export function getChatMessages(chatId: string) {
  return graphFetch<ListResponse<GraphMessage>>(
    `/me/chats/${chatId}/messages?$top=25`
  );
}

export function getMe() {
  return graphFetch<{ displayName?: string; mail?: string; userPrincipalName?: string }>(
    '/me'
  );
}

export async function postChannelMessage(input: {
  teamId: string;
  channelId: string;
  html: string;
  subject?: string;
}): Promise<GraphMessage> {
  return graphFetch<GraphMessage>(
    `/teams/${encodeURIComponent(input.teamId)}/channels/${encodeURIComponent(
      input.channelId
    )}/messages`,
    {
      method: 'POST',
      scopes: graphWriteScopes,
      body: {
        ...(input.subject ? { subject: input.subject } : {}),
        body: {
          contentType: 'html',
          content: input.html,
        },
      },
    }
  );
}

export async function replyToChannelMessage(input: {
  teamId: string;
  channelId: string;
  messageId: string;
  html: string;
  subject?: string;
}): Promise<GraphMessage> {
  return graphFetch<GraphMessage>(
    `/teams/${encodeURIComponent(input.teamId)}/channels/${encodeURIComponent(
      input.channelId
    )}/messages/${encodeURIComponent(input.messageId)}/replies`,
    {
      method: 'POST',
      scopes: graphWriteScopes,
      body: {
        ...(input.subject ? { subject: input.subject } : {}),
        body: {
          contentType: 'html',
          content: input.html,
        },
      },
    }
  );
}

function sharingTokens(sharingUrl: string): string[] {
  const trimmed = sharingUrl.trim();
  let withoutQuery = trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    withoutQuery = parsed.toString().replace(/\/$/, '');
  } catch {
    withoutQuery = trimmed.split('?')[0];
  }
  return [...new Set([trimmed, withoutQuery])].map(getSharingToken);
}

export async function downloadSharedWorkbook(sharingUrl: string) {
  const tokens = sharingTokens(sharingUrl);
  let lastError: unknown;
  for (const shareId of tokens) {
    try {
      const item = await graphFetch<{ name?: string }>(
        `/shares/${shareId}/driveItem?$select=name`
      );
      const response = await graphRequest(`/shares/${shareId}/driveItem/content`);
      return {
        name: item.name || 'workbook.xlsx',
        data: await response.arrayBuffer(),
      };
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (/403|accessDenied|404|itemNotFound/i.test(message)) {
    throw new Error(
      'Microsoft could not open this SharePoint file. In OneDrive click Share → the settings gear → Anyone (not “people in 1-800 Heaters”) → Can view, then paste the new link here. Sign in as an account that can open the link in a browser.'
    );
  }
  throw lastError instanceof Error ? lastError : new Error(message);
}
