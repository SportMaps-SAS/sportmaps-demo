/**
 * Deporte del torneo para las piezas públicas (tarjeta de partido, tabla, programación).
 * Cada página pública lo provee una vez con `t.sport`; sin proveedor todo se ve como siempre (marcador crudo).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { publicScoreKind, publicSides, type PublicScoreKind } from './publicModel';

interface PublicSport { kind: PublicScoreKind; sides: { home: string; away: string } | null }

const Ctx = createContext<PublicSport>({ kind: 'default', sides: null });

export function PublicSportProvider({ sport, children }: { sport: string | null | undefined; children: ReactNode }) {
  const value = useMemo(() => ({ kind: publicScoreKind(sport), sides: publicSides(sport) }), [sport]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePublicSport = () => useContext(Ctx);
