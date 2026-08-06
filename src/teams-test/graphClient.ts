import { acquireToken } from './auth';

async function graphFetch<T>(path: string): Promise<T> {
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

  return response.json() as Promise<T>;
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
