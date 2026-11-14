/**
 * whatsapp-plataforma.routes — «Recibir avisos de SportMaps en mi WhatsApp».
 *
 *   GET    /api/v1/whatsapp/:schoolId/avisos-sportmaps                → estado + mi suscripción
 *   POST   /api/v1/whatsapp/:schoolId/avisos-sportmaps    { telefono } → pendiente + enlace wa.me con código
 *   PATCH  /api/v1/whatsapp/:schoolId/avisos-sportmaps    { avisar_*, urgentes_en_silencio } → preferencias
 *   DELETE /api/v1/whatsapp/:schoolId/avisos-sportmaps                → dejar de recibir
 *   PUT    /api/v1/whatsapp/:schoolId/avisos-sportmaps/escuela { habilitado } → SOLO platform_admins (piloto)
 *
 * Spec docs/specs/canal-whatsapp-plataforma.md. La app NO activa nada: deja la
 * suscripción `pendiente` y le da a la persona un enlace que abre WhatsApp con
 * «… ACTIVAR <código>». Solo cuando ese número lo envía (Meta autentica el
 * `from`) queda activa (D4).
 *
 * Autorización: la persona tiene que ser owner/admin REAL de la escuela
 * (schools.owner_id o school_members activo owner/admin/school_admin). Un
 * platform_admin no se suscribe a escuelas ajenas por acá.
 */

import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
    adminsDeEscuela, celularCo, COLUMNAS_PREFERENCIAS, COLUMNAS_SUSCRIPCION, escuelaHabilitada, esFaltaDeEsquema,
    leerCanal, nombreDeEscuela, numeroDelCanal, canalHabilitado, type Suscripcion,
} from '../services/plataforma-wa.service';
import { enlaceDeActivacion, nuevoCodigo } from '../services/plataforma-wa-entrante.service';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIGENCIA_CODIGO_MS = 7 * 24 * 3600_000;

async function esPlatformAdmin(userId: string): Promise<boolean> {
    const { data } = await supabase.from('platform_admins').select('profile_id')
        .eq('profile_id', userId).eq('is_active', true).limit(1);
    return ((data ?? []) as any[]).length > 0;
}

async function miSuscripcion(schoolId: string, userId: string): Promise<{ fila: Suscripcion | null; sinMigracion: boolean }> {
    const { data, error } = await supabase.from('platform_wa_suscripciones')
        .select(COLUMNAS_SUSCRIPCION)
        .eq('school_id', schoolId).eq('profile_id', userId).neq('estado', 'revocada')
        .order('updated_at', { ascending: false }).limit(1);
    if (error) return { fila: null, sinMigracion: esFaltaDeEsquema((error as any).code) };
    return { fila: (((data ?? []) as unknown) as Suscripcion[])[0] ?? null, sinMigracion: false };
}

function publica(s: Suscripcion | null, enlace: string | null) {
    if (!s) return null;
    const preferencias: Record<string, boolean> = {};
    for (const c of COLUMNAS_PREFERENCIAS) preferencias[c] = (s as any)[c] === true;
    return {
        id: s.id,
        estado: s.estado,
        telefono: `+${s.contact_wa_id}`,
        activada_at: s.activada_at,
        codigo_expira_at: s.estado === 'pendiente' ? s.codigo_expira_at : null,
        enlace_confirmar: s.estado === 'pendiente' ? enlace : null,
        preferencias,
        silencio: { desde: s.silencio_desde, hasta: s.silencio_hasta, urgentes: s.urgentes_en_silencio },
    };
}

async function guardia(req: AuthenticatedRequest, res: Response): Promise<string | null> {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) { res.status(400).json({ error: 'school_id inválido' }); return null; }
    if (!(await adminsDeEscuela(schoolId)).has(req.user.id)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return schoolId;
}

router.get('/:schoolId/avisos-sportmaps', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await guardia(req, res);
    if (!schoolId) return;
    try {
        const [canal, habilitada, mia, escuela] = await Promise.all([
            leerCanal(), escuelaHabilitada(schoolId), miSuscripcion(schoolId, req.user.id), nombreDeEscuela(schoolId),
        ]);
        const enlace = mia.fila?.estado === 'pendiente' && mia.fila.codigo
            ? enlaceDeActivacion(numeroDelCanal(canal), escuela, mia.fila.codigo) : null;
        return res.json({
            disponible: (await canalHabilitado()) && canal?.status === 'activo' && !mia.sinMigracion,
            escuela_habilitada: habilitada,
            numero_canal: `+${numeroDelCanal(canal)}`,
            suscripcion: publica(mia.fila, enlace),
        });
    } catch (e: any) {
        console.error('[avisos-sportmaps] GET falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo leer el ajuste' });
    }
});

router.post('/:schoolId/avisos-sportmaps', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await guardia(req, res);
    if (!schoolId) return;
    const numero = celularCo((req.body ?? {}).telefono);
    if (!numero) return res.status(400).json({ error: 'Escribe un celular de Colombia (10 dígitos, empieza por 3).' });
    try {
        if (!(await canalHabilitado())) return res.status(409).json({ error: 'Los avisos por WhatsApp de SportMaps todavía no están disponibles.' });
        if (!(await escuelaHabilitada(schoolId))) return res.status(409).json({ error: 'Tu escuela todavía no tiene este servicio. Escríbenos para activarlo.' });

        // El número ya lo tiene otra persona de la escuela.
        const { data: ajena } = await supabase.from('platform_wa_suscripciones')
            .select('profile_id, estado').eq('school_id', schoolId).eq('contact_wa_id', numero).maybeSingle();
        if (ajena && (ajena as any).profile_id !== req.user.id && (ajena as any).estado !== 'revocada') {
            return res.status(409).json({ error: 'Ese número ya recibe los avisos de esta escuela a nombre de otra persona.' });
        }
        // Cambiar de número: lo anterior de esta persona en esta escuela se revoca.
        await supabase.from('platform_wa_suscripciones').update({
            estado: 'revocada', revocada_at: new Date().toISOString(), motivo_revocacion: 'cambio_de_numero',
            codigo: null, codigo_expira_at: null,
        }).eq('school_id', schoolId).eq('profile_id', req.user.id).neq('contact_wa_id', numero).neq('estado', 'revocada');

        const yaActiva = ajena && (ajena as any).profile_id === req.user.id && (ajena as any).estado === 'activa';
        if (!yaActiva) {
            const codigo = nuevoCodigo();
            const { error } = await supabase.from('platform_wa_suscripciones').upsert({
                school_id: schoolId, profile_id: req.user.id, contact_wa_id: numero,
                estado: 'pendiente', origen: 'app', codigo,
                codigo_expira_at: new Date(Date.now() + VIGENCIA_CODIGO_MS).toISOString(),
                consentimiento_ref: null, activada_at: null, revocada_at: null, motivo_revocacion: null,
            }, { onConflict: 'school_id,contact_wa_id' });
            if (error) throw new Error(error.message);
        }
        const [canal, mia, escuela] = await Promise.all([leerCanal(), miSuscripcion(schoolId, req.user.id), nombreDeEscuela(schoolId)]);
        const enlace = mia.fila?.estado === 'pendiente' && mia.fila.codigo
            ? enlaceDeActivacion(numeroDelCanal(canal), escuela, mia.fila.codigo) : null;
        return res.json({ suscripcion: publica(mia.fila, enlace) });
    } catch (e: any) {
        console.error('[avisos-sportmaps] POST falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar el ajuste' });
    }
});

router.patch('/:schoolId/avisos-sportmaps', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await guardia(req, res);
    if (!schoolId) return;
    const cuerpo = req.body ?? {};
    const parche: Record<string, boolean> = {};
    for (const c of [...COLUMNAS_PREFERENCIAS, 'urgentes_en_silencio'] as string[]) {
        if (c in cuerpo) {
            if (typeof cuerpo[c] !== 'boolean') return res.status(400).json({ error: `${c} debe ser true o false` });
            parche[c] = cuerpo[c];
        }
    }
    if (!Object.keys(parche).length) return res.status(400).json({ error: 'Nada que cambiar' });
    try {
        const { data, error } = await supabase.from('platform_wa_suscripciones').update(parche)
            .eq('school_id', schoolId).eq('profile_id', req.user.id).neq('estado', 'revocada').select('id');
        if (error) throw new Error(error.message);
        if (!data?.length) return res.status(404).json({ error: 'No tienes avisos configurados en esta escuela' });
        const mia = await miSuscripcion(schoolId, req.user.id);
        return res.json({ suscripcion: publica(mia.fila, null) });
    } catch (e: any) {
        console.error('[avisos-sportmaps] PATCH falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar' });
    }
});

router.delete('/:schoolId/avisos-sportmaps', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await guardia(req, res);
    if (!schoolId) return;
    try {
        const { error } = await supabase.from('platform_wa_suscripciones').update({
            estado: 'revocada', revocada_at: new Date().toISOString(), motivo_revocacion: 'app', codigo: null, codigo_expira_at: null,
        }).eq('school_id', schoolId).eq('profile_id', req.user.id).neq('estado', 'revocada');
        if (error) throw new Error(error.message);
        return res.json({ ok: true });
    } catch (e: any) {
        console.error('[avisos-sportmaps] DELETE falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar' });
    }
});

router.put('/:schoolId/avisos-sportmaps/escuela', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'school_id inválido' });
    if (!(await esPlatformAdmin(req.user.id))) return res.status(403).json({ error: 'forbidden' });
    const habilitado = (req.body ?? {}).habilitado;
    if (typeof habilitado !== 'boolean') return res.status(400).json({ error: 'habilitado debe ser true o false' });
    try {
        const { error } = await supabase.from('platform_wa_escuelas').upsert({
            school_id: schoolId, habilitado, actualizado_por: req.user.id,
        }, { onConflict: 'school_id' });
        if (error) throw new Error(error.message);
        return res.json({ ok: true, habilitado });
    } catch (e: any) {
        console.error('[avisos-sportmaps] PUT escuela falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar' });
    }
});

export default router;
