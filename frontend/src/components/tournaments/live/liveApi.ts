/**
 * Cliente de las rutas de «vivo» (bff/src/routes/tournament-follow.route.ts), base `/api/v1/tournament-live`.
 */
import { BFF_URL, bffClient } from '@/lib/api/bffClient';

const BASE = '/api/v1/tournament-live';
const enc = encodeURIComponent;

export interface RosterEntry { id: string; team_id: string; side: 'home' | 'away'; name: string }
export interface PlayerStatLine { member_id: string; name: string; team_id: string; side?: 'home' | 'away'; ace: number; attack: number; block: number; points: number }
export interface SocialComment { id: string; author_name: string; body: string; created_at: string; verified: boolean; status?: 'visible' | 'hidden' }
export interface SocialMedia { id: string; kind: 'photo' | 'video' | 'news'; match_id: string | null; title: string | null; body: string | null; url: string | null; video_url: string | null; created_at: string }
export interface MvpSummary {
  available: boolean; reason?: 'sin_planilla'; voting_open: boolean;
  candidates: RosterEntry[]; votes: Record<string, number>; total: number;
  winner: { member_id: string; name: string; side: 'home' | 'away'; source: 'organizer' | 'public' } | null;
}
export interface MatchSocialDto { comments: SocialComment[]; media: SocialMedia[]; mvp: MvpSummary; player_stats: PlayerStatLine[] }
export interface TodayMatch {
  match_id: string; event_title: string; slug: string | null; live_enabled: boolean;
  home_name: string | null; away_name: string | null; court: string | null; scheduled_at: string | null; status: string;
  home_score: number | null; away_score: number | null;
  who: Array<{ first_name: string; relation: 'self' | 'hija' | 'hijo' | 'child' }>;
}

/** Identificador anónimo de este dispositivo (voto MVP, antispam). No es un dato personal. */
export function deviceId(): string {
  const KEY = 'sm_tlive_device';
  try {
    const v = localStorage.getItem(KEY);
    if (v && v.length >= 16) return v;
    const n = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(KEY, n);
    return n;
  } catch {
    return `sin-almacen-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }
}

/** Para ScorerEndpoints: el anotador del organizador o el del enlace con token. */
export type ScorerScope = { kind: 'school'; eventId: string } | { kind: 'scorer'; token: string };
const scopeBase = (s: ScorerScope) => (s.kind === 'school' ? `${BASE}/school/${enc(s.eventId)}` : `${BASE}/scorer/${enc(s.token)}`);
const scopeAuth = (s: ScorerScope) => (s.kind === 'school' ? 'required' as const : 'public' as const);

export const liveApi = {
  calendarUrl: (slug: string, teamId?: string | null) =>
    `${BFF_URL}${BASE}/public/${enc(slug)}/calendar.ics${teamId ? `?team=${enc(teamId)}` : ''}`,

  myFollows: (slug: string) => bffClient.get<{ follows: Array<{ id: string; team_id: string | null }> }>(`${BASE}/me/follows/${enc(slug)}`),
  follow: (slug: string, teamId: string | null) => bffClient.post<{ ok: true; already: boolean }>(`${BASE}/me/follows/${enc(slug)}`, { team_id: teamId }),
  unfollow: (slug: string, teamId: string | null) =>
    bffClient.delete<{ ok: true }>(`${BASE}/me/follows/${enc(slug)}${teamId ? `?team_id=${enc(teamId)}` : ''}`),

  today: () => bffClient.get<{ matches: TodayMatch[] }>(`${BASE}/me/today`),

  matchSocial: (slug: string, matchId: string) => bffClient.get<MatchSocialDto>(`${BASE}/public/${enc(slug)}/matches/${enc(matchId)}/social`, undefined, 'public'),
  eventSocial: (slug: string) => bffClient.get<{ comments: SocialComment[]; media: SocialMedia[] }>(`${BASE}/public/${enc(slug)}/social`, undefined, 'public'),
  playerStats: (slug: string) => bffClient.get<{ player_stats: PlayerStatLine[] }>(`${BASE}/public/${enc(slug)}/player-stats`, undefined, 'public'),
  challenge: (slug: string) => bffClient.get<{ question: string; token: string }>(`${BASE}/public/${enc(slug)}/challenge`, undefined, 'public'),
  comment: (slug: string, matchId: string | null, body: Record<string, unknown>) =>
    bffClient.post<{ ok: true; comment: SocialComment }>(
      matchId ? `${BASE}/public/${enc(slug)}/matches/${enc(matchId)}/comments` : `${BASE}/public/${enc(slug)}/comments`,
      { ...body, device_id: deviceId() }, undefined, 'optional'),
  voteMvp: (slug: string, matchId: string, memberId: string) =>
    bffClient.post<{ ok: true }>(`${BASE}/public/${enc(slug)}/matches/${enc(matchId)}/mvp-vote`, { member_id: memberId, device_id: deviceId() }, undefined, 'public'),

  // Organizador
  moderate: (eventId: string, commentId: string, action: 'hide' | 'show' | 'delete') =>
    bffClient.patch<{ ok: true }>(`${BASE}/school/${enc(eventId)}/comments/${enc(commentId)}`, { action }),
  chooseMvp: (eventId: string, matchId: string, memberId: string | null) =>
    bffClient.put<{ ok: true }>(`${BASE}/school/${enc(eventId)}/matches/${enc(matchId)}/mvp`, { member_id: memberId }),

  // Organizador o anotador con token
  roster: (s: ScorerScope, matchId: string) => bffClient.get<{ roster: RosterEntry[] }>(`${scopeBase(s)}/matches/${enc(matchId)}/roster`, undefined, scopeAuth(s)),
  tagPoint: (s: ScorerScope, matchId: string, body: { member_id: string; stat: 'ace' | 'attack' | 'block'; point_index: number }) =>
    bffClient.post<{ ok: true }>(`${scopeBase(s)}/matches/${enc(matchId)}/stats`, body, undefined, scopeAuth(s)),
  uploadUrl: (s: ScorerScope, mime: string) =>
    bffClient.post<{ path: string; signedUrl: string; token: string }>(`${scopeBase(s)}/media/upload-url`, { mime }, undefined, scopeAuth(s)),
  createPost: (s: ScorerScope, body: { kind: 'photo' | 'video' | 'news'; match_id?: string | null; title?: string; body?: string; media_path?: string; video_url?: string }) =>
    bffClient.post<{ ok: true; id: string }>(`${scopeBase(s)}/posts`, body, undefined, scopeAuth(s)),
};
