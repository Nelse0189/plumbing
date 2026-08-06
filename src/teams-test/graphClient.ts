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
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
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
  from?: {
    user?: {
      displayName?: string;
    };
  };
  body?: {
    content?: string;
  };
  attachments?: GraphAttachment[];
}

export interface GraphAttachment {
  id: string;
  contentType?: string;
  contentUrl?: string;
  name?: string;
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

export function getChannelMessages(teamId: string, channelId: string) {
  return graphFetch<ListResponse<GraphMessage>>(
    `/teams/${teamId}/channels/${channelId}/messages?$top=25`
  );
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

export async function downloadChannelAttachment(
  teamId: string,
  attachment: GraphAttachment
) {
  if (!attachment.contentUrl) {
    throw new Error('This attachment does not include a download URL.');
  }

  try {
    const relativePath = getDriveRelativePath(attachment.contentUrl);
    const encodedPath = relativePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const response = await graphRequest(
      `/groups/${teamId}/drive/root:/${encodedPath}:/content`
    );
    return response.arrayBuffer();
  } catch (driveError) {
    try {
      const sharingToken = getSharingToken(attachment.contentUrl);
      const response = await graphRequest(
        `/shares/${sharingToken}/driveItem/content`
      );
      return response.arrayBuffer();
    } catch {
      throw driveError;
    }
  }
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
