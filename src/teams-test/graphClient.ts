import { acquireToken } from './auth';

async function graphFetch<T>(path: string): Promise<T> {
  const response = await graphRequest(path);
  return response.json() as Promise<T>;
}

async function graphRequest(path: string): Promise<Response> {
  const token = await acquireToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Graph request failed for ${path}: ${response.status} ${response.statusText}: ${body}`
    );
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
}

export function getJoinedTeams() {
  return graphFetch<ListResponse<GraphTeam>>('/me/joinedTeams');
}

export function getTeamChannels(teamId: string) {
  return graphFetch<ListResponse<GraphChannel>>(
    `/teams/${teamId}/channels`
  );
}

export async function getChannelMessages(teamId: string, channelId: string) {
  const response = await graphFetch<ListResponse<GraphMessage>>(
    `/teams/${teamId}/channels/${channelId}/messages?$top=25`
  );

  // Channel posts and their replies are separate Graph resources. Fetch the
  // thread for each post so the UI and work-order notes match what Teams shows.
  const messages = await Promise.all(
    response.value.map(async (message) => {
      try {
        const replies = await graphFetch<ListResponse<GraphMessage>>(
          `/teams/${teamId}/channels/${channelId}/messages/${message.id}/replies?$top=50`
        );
        return { ...message, replies: replies.value };
      } catch {
        // A missing/denied reply thread should not hide the channel post.
        return { ...message, replies: [] };
      }
    })
  );

  return { value: messages };
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
