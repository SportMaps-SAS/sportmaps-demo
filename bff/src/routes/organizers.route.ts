import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';

const router = Router();

// Zod schemas for validation
const OrganizerProfileSchema = z.object({
    organization_name: z.string().min(1, 'El nombre de la organización es requerido').max(200),
    nit: z.string().min(1, 'El NIT es requerido').max(50),
    city: z.string().min(1, 'La ciudad es requerida').max(100),
    sports: z.array(z.string()).min(1, 'Selecciona al menos un deporte'),
    bio: z.string().max(1000).optional(),
    logo_url: z.string().url().optional().or(z.literal('')),
    payment_methods: z.array(z.string()).optional(),
    bank_data: z.record(z.string(), z.any()).optional(),
    // El wizard los recoge desde antes, pero al no estar acá zod los descartaba
    // en silencio (strip de claves desconocidas): se le pedían al organizador y
    // se tiraban sin error. Columnas agregadas en 20260817131907.
    nequi_number: z.string().max(30).nullable().optional(),
    whatsapp_number: z.string().max(30).nullable().optional(),
    verification_doc_url: z.string().url().optional().or(z.literal('')),
    qr_smart_enabled: z.boolean().optional()
});

// POST /api/v1/organizer/profile - Create organizer profile
router.post('/profile', requireAuth, requireRole('organizer'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const parsed = OrganizerProfileSchema.safeParse(req.body);
        
        if (!parsed.success) {
            return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        }

        const orgData = {
            ...parsed.data,
            profile_id: userId,
            // is_verified NO va aquí: la columna nace en false (default) y en un
            // re-envío del onboarding el upsert des-verificaba al organizador.
            // Solo la cambia la plataforma (RPC verificar_organizador).
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('event_organizers')
            .upsert(orgData, { onConflict: 'profile_id' })
            .select()
            .single();

        if (error) {
            req.log?.error({ err: error }, 'Error creando perfil de organizador');
            return res.status(500).json({ error: 'Error al guardar el perfil del organizador' });
        }

        return res.status(201).json(data);
    } catch (err: any) {
        req.log?.error({ err }, 'Error inesperado creando perfil de organizador');
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /api/v1/organizer/profile - Update organizer profile
router.put('/profile', requireAuth, requireRole('organizer'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        // Allows partial updates
        const parsed = OrganizerProfileSchema.partial().safeParse(req.body);
        
        if (!parsed.success) {
            return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        }

        const orgData = {
            ...parsed.data,
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('event_organizers')
            .update(orgData)
            .eq('profile_id', userId)
            .select()
            .single();

        if (error) {
            req.log?.error({ err: error }, 'Error actualizando perfil de organizador');
            return res.status(500).json({ error: 'Error al actualizar el perfil del organizador' });
        }

        return res.status(200).json(data);
    } catch (err: any) {
        req.log?.error({ err }, 'Error inesperado actualizando perfil de organizador');
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/v1/organizer/stats - Get global stats for the organizer dashboard
router.get('/stats', requireAuth, requireRole('organizer'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        // Verify organizer exists
        const { data: org, error: orgError } = await supabase
            .from('event_organizers')
            .select('id')
            .eq('profile_id', userId)
            .single();

        if (orgError || !org) {
            return res.status(404).json({ error: 'Organizador no encontrado' });
        }

        const orgId = org.id;

        // Contar eventos activos
        const { count: activeEventsCount } = await supabase
            .from('events')
            .select('*', { count: 'exact', head: true })
            .eq('organizer_id', orgId)
            .eq('status', 'published');

        // Contar inscripciones pendientes de aprobar (delegation status pending_payment)
        // Note: For now we'll do a simple query on delegations linked to this organizer's events
        const { data: pendingDelegations } = await supabase
            .from('event_delegations')
            .select('id, event_id, events!inner(organizer_id)')
            .eq('status', 'pending_payment')
            .eq('events.organizer_id', orgId);

        // Fetch pagado histórico
        const { data: payments } = await supabase
            .from('event_delegation_payments')
            .select('amount, event_delegations!inner(events!inner(organizer_id))')
            .eq('status', 'approved')
            .eq('event_delegations.events.organizer_id', orgId);

        const totalEarned = (payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

        return res.status(200).json({
            active_events: activeEventsCount || 0,
            pending_registrations: pendingDelegations?.length || 0,
            total_earned: totalEarned,
            alerts: [
                ...(pendingDelegations?.length ? [{
                    type: 'action',
                    title: `${pendingDelegations.length} abonos por aprobar`,
                    description: 'Hay pagos pendientes que requieren revisión.',
                    // We just route them to the events list or a general payments page
                    href: '/organizer/home' 
                }] : []),
            ]
        });

    } catch (err: any) {
        req.log?.error({ err }, 'Error inesperado obteniendo estadísticas del organizador');
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/v1/organizer/finances - Financial summary across all events
router.get('/finances', requireAuth, requireRole('organizer'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        const { data: org } = await supabase.from('event_organizers').select('id').eq('profile_id', userId).single();
        if (!org) return res.status(404).json({ error: 'Organizador no encontrado' });

        const { data: events } = await supabase
            .from('events')
            .select('id, title, event_date, status, city, sport')
            .eq('organizer_id', org.id)
            .order('event_date', { ascending: false });

        const eventsWithFinances = await Promise.all((events || []).map(async (event: any) => {
            const { data: delegations } = await supabase
                .from('event_delegations')
                .select('total_amount, paid_amount, status')
                .eq('event_id', event.id);

            const totalExpected = (delegations || []).reduce((sum: number, d: any) => sum + Number(d.total_amount || 0), 0);
            const totalPaid = (delegations || []).reduce((sum: number, d: any) => sum + Number(d.paid_amount || 0), 0);
            const pendingCount = (delegations || []).filter((d: any) => d.status === 'pending_payment').length;

            return {
                ...event,
                total_expected: totalExpected,
                total_paid: totalPaid,
                pending_delegations: pendingCount,
                delegation_count: delegations?.length || 0
            };
        }));

        const summary = {
            total_expected: eventsWithFinances.reduce((s, e) => s + e.total_expected, 0),
            total_paid: eventsWithFinances.reduce((s, e) => s + e.total_paid, 0),
            total_pending: eventsWithFinances.reduce((s, e) => s + (e.total_expected - e.total_paid), 0),
            total_events: events?.length || 0
        };

        return res.status(200).json({ summary, events: eventsWithFinances });
    } catch (err: any) {
        req.log?.error({ err }, 'Error obteniendo finanzas del organizador');
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

export default router;
