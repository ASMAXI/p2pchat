import { getBootstrapOrigin, isLocalhostOrigin, type RoomState as ApiRoomState } from '@/lib/p2p-client';

export type ConnectivityState = 'connected' | 'checking' | 'offline';
export type ChannelType = 'text' | 'voice';
export type Server = {
  id: string;
  name: string;
  memberCount: number;
  role: string;
  connectivityState: ConnectivityState;
  hostName: string;
  roomId?: string;
  inviteToken?: string;
  invite?: string;
  peerId?: string;
  roomKey?: string;
};
export type Channel = { id: string; name: string; type: ChannelType; unreadCount: number; members: number };
export type Message = {
  id: string;
  author: string;
  authorId?: string;
  content: string;
  timestamp: string;
  timestampIso?: string;
  avatar: string;
  isCurrentUser: boolean;
  channelId?: string;
  delivery?: 'queued' | 'sent' | 'synced';
};
export type VoiceParticipant = { id: string; name: string };
export type VoiceRoom = {
  id: string;
  name: string;
  participantCount: number;
  state: 'ready' | 'live';
  participants: VoiceParticipant[];
};
export type StoredVoice = VoiceRoom & { muted?: boolean; deafened?: boolean };

export const SERVER_KEY = 'p2pchat-server';
export const CHANNELS_KEY = 'p2pchat-channels';
export const MESSAGES_KEY = 'p2pchat-messages';
export const VOICE_KEY = 'p2pchat-voice';
export const PROFILE_NAME_KEY = 'p2pchat-profile-name';
export const CONNECTION_KEY = 'p2pchat-connection-status';

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
export const readStore = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};
export const writeStore = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

export const inviteLooksLocal = (invite?: string): boolean => {
  const haystack = `${invite ?? ''} ${getBootstrapOrigin()}`;
  if (isLocalhostOrigin(haystack)) return true;
  return /192\.168\.|(^|[^\d])10\.|172\.(1[6-9]|2\d|3[01])\./.test(haystack);
};

export const mergeChannelUnread = (prev: Channel[], incoming: Channel[]): Channel[] => {
  const unreadById = new Map(prev.map((channel) => [channel.id, channel.unreadCount]));
  return incoming.map((channel) => ({
    ...channel,
    unreadCount: unreadById.get(channel.id) ?? channel.unreadCount ?? 0,
  }));
};

export const roomStateToClientState = (state: ApiRoomState, peerId: string, invite?: string) => {
  const onlineMembers = state.members.filter((member) => member.online);
  const server: Server = {
    id: state.id,
    roomId: state.id,
    name: state.name,
    memberCount: onlineMembers.length,
    role: state.ownerId === peerId ? 'Владелец' : 'Участник',
    connectivityState: 'connected',
    hostName: state.hostName,
    peerId,
    invite,
  };
  const voiceRooms: StoredVoice[] = state.channels
    .filter((channel) => channel.type === 'voice')
    .map((channel) => {
      const participants = state.voiceParticipants[channel.id] ?? [];
      return {
        id: channel.id,
        name: channel.name,
        participantCount: participants.length,
        state: participants.length > 0 ? 'live' : 'ready',
        participants: participants.map((participant) => ({
          id: participant.id,
          name: participant.name,
        })),
      };
    });
  return {
    server,
    channels: state.channels,
    voiceRooms,
  };
};

export const seedServer: Server = {
  id: 'server-orbit',
  name: 'Комната',
  memberCount: 0,
  role: 'Участник',
  connectivityState: 'offline',
  hostName: '—',
};
export const seedChannels: Channel[] = [
  { id: 'general', name: 'общий', type: 'text', unreadCount: 0, members: 0 },
  { id: 'lounge', name: 'голосовой', type: 'voice', unreadCount: 0, members: 0 },
];
export const seedMessages: Message[] = [];
export const seedVoice: StoredVoice[] = [
  { id: 'lounge', name: 'голосовой', participantCount: 0, state: 'ready', participants: [] },
];

