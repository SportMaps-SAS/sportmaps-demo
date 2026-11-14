/**
 * Llamadas a las RPC de jugadas compartidas (migración 20261027112704). Las
 * RPC todavía no están en types.ts (se regeneran al aplicar el lote), por eso
 * el cast.
 */
import { supabase } from '@/integrations/supabase/client';
import { parseSharedPlay, sharedPlayErrorMessage, type SharedPlay, type SharedPlayPayload } from './tacticalSharedPlay';

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
const rpc = () => supabase as unknown as RpcClient;

/** Guarda la jugada y devuelve el token del enlace. Lanza Error con el mensaje en palabras. */
export async function createSharedPlay(args: { teamId: string; title: string; sport: string | null; payload: SharedPlayPayload }): Promise<string> {
  const { data, error } = await rpc().rpc('create_tactical_shared_play', {
    p_team_id: args.teamId, p_title: args.title, p_sport: args.sport, p_payload: args.payload,
  });
  if (error) throw new Error(sharedPlayErrorMessage(null));
  const r = (data ?? {}) as { ok?: boolean; token?: string; error?: string };
  if (!r.ok || !r.token) throw new Error(sharedPlayErrorMessage(r.error));
  return r.token;
}

/** Jugada pública por token (sin sesión). null = no existe o se apagó. */
export async function fetchSharedPlay(token: string): Promise<SharedPlay | null> {
  const { data, error } = await rpc().rpc('get_tactical_shared_play', { p_token: token });
  if (error) throw new Error('No se pudo abrir la jugada. Revisa tu conexión e inténtalo de nuevo.');
  return parseSharedPlay(data);
}
