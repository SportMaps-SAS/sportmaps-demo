/**
 * Carga lo que pinta el carnet 3D (spec carnet-3d-club.md §4, §5.4, §7):
 *
 *   verify_athlete_id_card_public(p_qr_token)  → frente (pública)
 *   card_back_data(p_qr_token)                 → reverso (solo con sesión)
 *   ¿se le muestra la marca propia al club?    → colores y escudo (D3)
 *
 * Marca (D3): la regla vive en school_shows_own_brand() (addon pwa_branding),
 * que solo tiene EXECUTE para `authenticated`. Para que también funcione sin
 * sesión (/c/:token) se pregunta por get_school_by_slug(p_slug), que es
 * pública y solo devuelve ok=true si la escuela tiene la marca. Sin slug y sin
 * sesión → diseño base SportMaps.
 *
 * El mapeo de las respuestas a Carnet3DDatos es puro (mapearCarnet3D) y está
 * probado en useCarnet3D.test.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { CardData } from '@/components/cards/AthleteIdCard';
import { resolverIdentidad } from '@/lib/cards/clubIdentity';
import type { CardBackData, Carnet3DDatos } from '@/lib/cards/contratos';

/** Lo que devuelve verify_athlete_id_card_public desde F1 (CardData + carnet 3D). */
export type VerifyCarnet3D = CardData & {
  codigo?: string | null;
  numero?: number | string | null;
  posicion?: string | null;
};

function aNumero(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function aTexto(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Respuestas de las RPC → datos del carnet 3D. null si el carnet no existe o
 * no está vigente (revocado/vencido se pintan con la vista clásica de estado).
 * El reverso solo viaja si card_back_data dijo found.
 */
export function mapearCarnet3D(
  verify: VerifyCarnet3D | null | undefined,
  reverso: CardBackData | null | undefined,
  conMarca: boolean,
): Carnet3DDatos | null {
  if (!verify?.found || verify.status !== 'active') return null;
  const school = verify.school;
  const identidad = resolverIdentidad(
    { name: school?.name ?? 'Club', logo_url: school?.logo_url ?? null, branding_settings: school?.branding_settings ?? null },
    conMarca,
  );
  const back = reverso?.found ? reverso : null;
  return {
    nombre: aTexto(verify.athlete?.full_name) ?? 'Deportista',
    fotoUrl: aTexto(verify.athlete?.avatar_url),
    numero: aNumero(verify.numero) ?? aNumero(back?.zona_de_juego?.numero),
    posicion: aTexto(verify.posicion) ?? aTexto(back?.zona_de_juego?.posicion),
    categoria: aTexto(verify.team_name),
    codigo: aTexto(verify.codigo),
    qrToken: aTexto(verify.qr_token),
    identidad,
    reverso: back,
  };
}

/**
 * Filas de «Datos del deportista» para mostrar FUERA del carnet (D8, §4.1):
 * lo que la escuela encendió y la RPC mandó. Nunca pagos ni habilitación.
 * Al público solo sede y vigencia, aunque la respuesta trajera más.
 */
export function filasDatosDeportista(d: CardData | null | undefined): Array<{ etiqueta: string; valor: string }> {
  if (!d?.found || d.status !== 'active') return [];
  // El coach (F5) recibe RH/EPS/contacto/talla si la escuela los enciende; la RPC
  // ya no le manda documento (null → la fila se omite).
  const privado = d.viewer === 'staff' || d.viewer === 'coach' || d.viewer === 'guardian';
  const a = d.athlete ?? ({} as NonNullable<CardData['athlete']>);
  const filas: Array<{ etiqueta: string; valor: string | null | undefined }> = [];
  if (privado) {
    const doc = [a.doc_type, a.doc_number].filter(Boolean).join(' ');
    filas.push({ etiqueta: 'Documento', valor: a.doc_number ? doc : null });
    filas.push({ etiqueta: 'RH', valor: a.blood_type });
    filas.push({ etiqueta: 'EPS', valor: a.eps_name });
    filas.push({ etiqueta: 'Contacto de emergencia', valor: a.emergency_contact });
    filas.push({ etiqueta: 'Talla', valor: a.tshirt_size });
  }
  filas.push({ etiqueta: 'Sede', valor: d.branch_name });
  if (d.valid_until) {
    const f = new Date(d.valid_until.length <= 10 ? `${d.valid_until}T00:00:00` : d.valid_until);
    filas.push({
      etiqueta: 'Vigente hasta',
      valor: Number.isNaN(f.getTime()) ? d.valid_until : f.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }),
    });
  }
  return filas
    .filter((f) => f.valor != null && String(f.valor).trim() !== '')
    .map((f) => ({ etiqueta: f.etiqueta, valor: String(f.valor) }));
}

/** ¿Se pintan colores y escudo del club? (D3). Ante cualquier duda: no. */
export async function resolverConMarca(school: { id: string; slug?: string | null } | null | undefined): Promise<boolean> {
  if (!school?.id) return false;
  try {
    if (school.slug) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('get_school_by_slug' as any, { p_slug: school.slug });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = data as any;
      if (!error && r?.ok === true) return r.school?.id === school.id;
      if (!error) return false;
    }
    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase.rpc('school_shows_own_brand' as any, { p_school_id: school.id });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** card_back_data: sin sesión ni se llama (anon no tiene EXECUTE). */
async function cargarReverso(qrToken: string): Promise<CardBackData | null> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase.rpc('card_back_data' as any, { p_qr_token: qrToken });
    if (error) return null;
    return (data as CardBackData) ?? null;
  } catch {
    return null;
  }
}

/**
 * A partir de una respuesta de verify que la pantalla ya tiene, completa el
 * reverso y la marca. `datos` sale enseguida (diseño base, sin reverso) y se
 * actualiza cuando llegan los extras.
 */
export function useCarnet3DDesdeVerify(verify: VerifyCarnet3D | null | undefined) {
  const [extras, setExtras] = useState<{ token: string | null; reverso: CardBackData | null; conMarca: boolean }>({
    token: null, reverso: null, conMarca: false,
  });
  const [cargandoExtras, setCargandoExtras] = useState(false);

  const activo = !!verify?.found && verify.status === 'active';
  const token = activo ? verify?.qr_token ?? null : null;
  const schoolId = verify?.school?.id ?? null;
  const slug = verify?.school?.slug ?? null;

  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    setCargandoExtras(true);
    void Promise.all([cargarReverso(token), resolverConMarca(schoolId ? { id: schoolId, slug } : null)]).then(([reverso, conMarca]) => {
      if (cancelado) return;
      setExtras({ token, reverso, conMarca });
      setCargandoExtras(false);
    });
    return () => { cancelado = true; };
  }, [token, schoolId, slug]);

  const listo = !token || extras.token === token;
  const vigentes = listo ? extras : { reverso: null, conMarca: false };
  return {
    datos: mapearCarnet3D(verify, vigentes.reverso, vigentes.conMarca),
    /** true cuando ya se sabe la marca y el reverso (evita el salto de colores). */
    listo,
    cargandoExtras,
  };
}

/** Carga completa por token (verify + reverso + marca). */
export function useCarnet3D(qrToken: string | null | undefined) {
  const [verify, setVerify] = useState<VerifyCarnet3D | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');

  const cargar = useCallback(async () => {
    if (!qrToken) return;
    setEstado('cargando');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase.rpc('verify_athlete_id_card_public' as any, { p_qr_token: qrToken });
    if (error) {
      setVerify(null);
      setEstado('error');
      return;
    }
    setVerify((data as VerifyCarnet3D) ?? null);
    setEstado('listo');
  }, [qrToken]);

  useEffect(() => {
    setVerify(null);
    void cargar();
  }, [cargar]);

  const { datos, listo, cargandoExtras } = useCarnet3DDesdeVerify(verify);
  return { verify, datos, listo, estado, cargandoExtras, recargar: cargar };
}
