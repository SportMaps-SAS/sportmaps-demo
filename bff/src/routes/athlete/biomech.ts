import { Router, Request, Response } from 'express';
import { supabase } from '../../config/supabase';
import { validarCapturaBiomecanica, validarGrantBiomecanico } from './biomechAlcance';

const router = Router();

// ── HELPERS ────────────────────────────────────────────────────────────────────

function computeFlags(
    metrics: Record<string, number>,
    thresholds: Record<string, number>
): Array<{ metric: string; value: number; threshold: number; severity: 'warning' | 'critical' }> {
    const flags: Array<{ metric: string; value: number; threshold: number; severity: 'warning' | 'critical' }> = [];

    if (metrics.knee_valgus_angle !== undefined && thresholds.knee_valgus_threshold_deg !== undefined) {
        if (metrics.knee_valgus_angle > thresholds.knee_valgus_threshold_deg) {
            flags.push({
                metric: 'knee_valgus_angle', value: metrics.knee_valgus_angle,
                threshold: thresholds.knee_valgus_threshold_deg,
                severity: metrics.knee_valgus_angle > thresholds.knee_valgus_threshold_deg * 1.5 ? 'critical' : 'warning',
            });
        }
    }
    if (metrics.squat_depth !== undefined && thresholds.min_squat_depth_ratio !== undefined) {
        if (metrics.squat_depth < thresholds.min_squat_depth_ratio) {
            flags.push({ metric: 'squat_depth', value: metrics.squat_depth, threshold: thresholds.min_squat_depth_ratio, severity: 'warning' });
        }
    }
    if (metrics.lumbar_hyperextension !== undefined && thresholds.max_lumbar_hyperextension_deg !== undefined) {
        if (metrics.lumbar_hyperextension > thresholds.max_lumbar_hyperextension_deg) {
            flags.push({ metric: 'lumbar_hyperextension', value: metrics.lumbar_hyperextension, threshold: thresholds.max_lumbar_hyperextension_deg, severity: 'critical' });
        }
    }
    if (metrics.shoulder_compensation !== undefined && thresholds.max_shoulder_elevation_deg !== undefined) {
        if (metrics.shoulder_compensation > thresholds.max_shoulder_elevation_deg) {
            flags.push({ metric: 'shoulder_compensation', value: metrics.shoulder_compensation, threshold: thresholds.max_shoulder_elevation_deg, severity: 'warning' });
        }
    }
    return flags;
}

async function upsertBaseline(athleteId: string, metrics: Record<string, number>, isAssessment: boolean): Promise<void> {
    const weight = isAssessment ? 5 : 1;
    const { data: existing } = await supabase
        .from('biomech_baselines').select('id, joint_rom, assessment_count').eq('athlete_id', athleteId).maybeSingle();

    if (!existing) {
        await supabase.from('biomech_baselines').insert({ athlete_id: athleteId, joint_rom: metrics, assessment_count: 1, last_updated_at: new Date().toISOString() });
        return;
    }

    const currentRom: Record<string, number> = existing.joint_rom ?? {};
    const currentCount: number = existing.assessment_count ?? 0;
    const updatedRom: Record<string, number> = { ...currentRom };

    for (const [key, value] of Object.entries(metrics)) {
        const prev = currentRom[key] ?? value;
        updatedRom[key] = (prev * currentCount + value * weight) / (currentCount + weight);
    }

    await supabase.from('biomech_baselines')
        .update({ joint_rom: updatedRom, assessment_count: currentCount + 1, last_updated_at: new Date().toISOString() })
        .eq('id', existing.id);
}

// ── CAPTURES ───────────────────────────────────────────────────────────────────

router.post('/biomech/captures', async (req: Request, res: Response) => {
    try {
        const { id: athleteId } = req.user;
        const { school_id, session_plan_id, enrollment_id, analyzer_code, block_index, source } = req.body;

        if (!school_id || !analyzer_code) return res.status(400).json({ error: 'school_id y analyzer_code son requeridos.' });

        // Service role salta RLS: misma regla que bc_athlete_insert (escuela del
        // atleta y, si trae sesión, una sesión suya de esa escuela).
        const fueraDeAlcance = await validarCapturaBiomecanica(supabase, athleteId, school_id, session_plan_id ?? null);
        if (fueraDeAlcance) return res.status(fueraDeAlcance.status).json({ error: fueraDeAlcance.error });

        const { data: analyzer } = await supabase.from('exercise_analyzers').select('code').eq('code', analyzer_code).maybeSingle();
        if (!analyzer) return res.status(400).json({ error: `Analyzer '${analyzer_code}' no existe.` });

        const { data, error } = await supabase
            .from('biomech_captures')
            .insert({ athlete_id: athleteId, school_id, session_plan_id: session_plan_id ?? null, enrollment_id: enrollment_id ?? null, analyzer_code, block_index: block_index ?? null, source: source ?? 'session', status: 'pending' })
            .select('id, athlete_id, analyzer_code, status, created_at').single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error creating biomech capture');
        res.status(500).json({ error: 'Error al iniciar captura biomecánica.' });
    }
});

router.get('/biomech/captures', async (req: Request, res: Response) => {
    try {
        const { id: athleteId } = req.user;
        const { session_plan_id, analyzer_code, status } = req.query;

        let query = supabase
            .from('biomech_captures')
            .select(`id, session_plan_id, analyzer_code, block_index, status, quality_score, duration_seconds, source, created_at,
                biomech_analyses ( id, rep_count, flags, summary, quality_rating )`)
            .eq('athlete_id', athleteId);

        if (session_plan_id) query = query.eq('session_plan_id', session_plan_id as string);
        if (analyzer_code)   query = query.eq('analyzer_code', analyzer_code as string);
        if (status)          query = query.eq('status', status as string);

        const { data, error } = await query.order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data ?? []);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error fetching athlete biomech captures');
        res.status(500).json({ error: 'Error al obtener capturas biomecánicas.' });
    }
});

router.get('/biomech/captures/:captureId', async (req: Request, res: Response) => {
    try {
        const { captureId } = req.params;
        const { id: athleteId } = req.user;

        const { data, error } = await supabase
            .from('biomech_captures')
            .select(`id, session_plan_id, analyzer_code, block_index, fps, duration_seconds, quality_score, source, status, created_at, updated_at,
                biomech_analyses ( id, rep_count, metrics, flags, summary, quality_rating, suggested_correctives, processed_at ),
                biomech_annotations ( id, timestamp_seconds, note, label, created_at )`)
            .eq('id', captureId).eq('athlete_id', athleteId).single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Captura no encontrada.' });
        res.json(data);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error fetching athlete biomech capture detail');
        res.status(500).json({ error: 'Error al obtener detalle de la captura.' });
    }
});

router.patch('/biomech/captures/:captureId/keypoints', async (req: Request, res: Response) => {
    try {
        const { captureId } = req.params;
        const { id: athleteId } = req.user;
        const { keypoints, fps, duration_seconds, quality_score } = req.body;

        if (!keypoints || !fps || !duration_seconds) return res.status(400).json({ error: 'keypoints, fps y duration_seconds son requeridos.' });

        const { data, error } = await supabase
            .from('biomech_captures')
            .update({ keypoints, fps, duration_seconds, quality_score: quality_score ?? null, status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', captureId).eq('athlete_id', athleteId)
            .select('id, status, updated_at').single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Captura no encontrada.' });
        res.json(data);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error saving biomech keypoints');
        res.status(500).json({ error: 'Error al guardar keypoints.' });
    }
});

router.post('/biomech/captures/:captureId/analyze', async (req: Request, res: Response) => {
    try {
        const { captureId } = req.params;
        const { id: athleteId } = req.user;
        const { metrics, rep_count, is_assessment } = req.body;

        if (!metrics || typeof metrics !== 'object') return res.status(400).json({ error: 'metrics es requerido (objeto con valores numéricos).' });

        const { data: capture } = await supabase
            .from('biomech_captures').select('id, analyzer_code, status')
            .eq('id', captureId).eq('athlete_id', athleteId).maybeSingle();

        if (!capture) return res.status(404).json({ error: 'Captura no encontrada.' });
        if ((capture as any).status === 'completed') return res.status(409).json({ error: 'Esta captura ya fue analizada.' });

        const { data: analyzer } = await supabase
            .from('exercise_analyzers').select('thresholds, name').eq('code', (capture as any).analyzer_code).maybeSingle();

        const thresholds: Record<string, number> = (analyzer as any)?.thresholds ?? {};
        const flags = computeFlags(metrics, thresholds);

        const criticalFlags = flags.filter(f => f.severity === 'critical').length;
        const quality_rating = criticalFlags >= 2 ? 'poor' : criticalFlags === 1 ? 'acceptable' : 'good';

        const analyzerName = (analyzer as any)?.name ?? (capture as any).analyzer_code;
        const summary = flags.length === 0
            ? `Ejecución de ${analyzerName} dentro de los parámetros esperados.`
            : `Se detectaron ${flags.length} aspecto(s) a mejorar en ${analyzerName}: ${flags.map(f => f.metric.replace(/_/g, ' ')).join(', ')}.`;

        const { data: analysis, error: analysisError } = await supabase
            .from('biomech_analyses')
            .insert({ capture_id: captureId, analyzer_code: (capture as any).analyzer_code, rep_count: rep_count ?? null, metrics, flags, summary, quality_rating, processed_at: new Date().toISOString() })
            .select().single();

        if (analysisError) throw analysisError;

        await supabase.from('biomech_captures')
            .update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', captureId);

        upsertBaseline(athleteId, metrics, is_assessment ?? false).catch((err) => {
            (req as any).log?.error({ err }, 'Error updating biomech baseline');
        });

        res.status(201).json(analysis);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error analyzing biomech capture');
        res.status(500).json({ error: 'Error al analizar la captura.' });
    }
});

// ── BASELINE ───────────────────────────────────────────────────────────────────

router.get('/biomech/baseline', async (req: Request, res: Response) => {
    try {
        const { id: athleteId } = req.user;

        const { data, error } = await supabase
            .from('biomech_baselines').select('*').eq('athlete_id', athleteId).maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Todavía no tienes un perfil biomecánico. Completa tu primera captura.' });
        res.json(data);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error fetching athlete biomech baseline');
        res.status(500).json({ error: 'Error al obtener baseline biomecánico.' });
    }
});

// ── ACCESS GRANTS ──────────────────────────────────────────────────────────────

router.get('/biomech/grants', async (req: Request, res: Response) => {
    try {
        const { id: athleteId } = req.user;

        const { data, error } = await supabase
            .from('biomech_access_grants')
            .select('id, coach_id, school_id, is_active, granted_at, expires_at')
            .eq('athlete_id', athleteId);

        if (error) throw error;
        res.json(data ?? []);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error fetching biomech grants (athlete)');
        res.status(500).json({ error: 'Error al obtener grants biomecánicos.' });
    }
});

router.post('/biomech/grants', async (req: Request, res: Response) => {
    try {
        const { id: athleteId } = req.user;
        const { coach_id, school_id, expires_at } = req.body;

        if (!coach_id || !school_id) return res.status(400).json({ error: 'coach_id y school_id son requeridos.' });

        // Service role salta RLS: misma regla que bag_athlete_insert (escuela del
        // atleta y coach que TRABAJA en ella). Antes se aceptaba cualquier perfil.
        const fueraDeAlcance = await validarGrantBiomecanico(supabase, athleteId, coach_id, school_id);
        if (fueraDeAlcance) return res.status(fueraDeAlcance.status).json({ error: fueraDeAlcance.error });

        const { data, error } = await supabase
            .from('biomech_access_grants')
            .upsert({ athlete_id: athleteId, coach_id, school_id, is_active: true, granted_at: new Date().toISOString(), expires_at: expires_at ?? null }, { onConflict: 'athlete_id,coach_id,school_id' })
            .select().single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        (req as any).log?.error({ err }, 'Error creating biomech grant');
        res.status(500).json({ error: 'Error al otorgar acceso biomecánico.' });
    }
});

router.delete('/biomech/grants/:grantId', async (req: Request, res: Response) => {
    try {
        const { grantId } = req.params;
        const { id: athleteId } = req.user;

        const { error } = await supabase
            .from('biomech_access_grants')
            .update({ is_active: false })
            .eq('id', grantId).eq('athlete_id', athleteId);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        (req as any).log?.error({ err }, 'Error revoking biomech grant');
        res.status(500).json({ error: 'Error al revocar acceso biomecánico.' });
    }
});

export default router;
