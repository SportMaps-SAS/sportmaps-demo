import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole } from '../middlewares/authMiddleware';
import { FACILITY_ADMIN_ROLES } from '../utils/facilityRoles';

const router = Router();

// ── Disponibilidad de la instalación (calcado de school-staff.ts :coachId/availability) ──

// GET /api/v1/facilities/:facilityId/availability
router.get('/:facilityId/availability', requireAuth, async (req: Request, res: Response) => {
  try {
    const { schoolId } = req;
    const { facilityId } = req.params;

    const { data, error } = await supabase
      .from('facility_availability')
      .select('*')
      .eq('facility_id', facilityId)
      .eq('school_id', schoolId)
      .order('day_of_week, start_time');

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    req.log?.error({ err }, 'facilities availability unhandled error');
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// POST /api/v1/facilities/:facilityId/availability
router.post('/:facilityId/availability', requireAuth, requireRole(...FACILITY_ADMIN_ROLES), async (req: Request, res: Response) => {
  try {
    const { schoolId } = req;
    const { facilityId } = req.params;
    const { day_of_week, start_time, end_time, max_group_capacity } = req.body;

    const { data, error } = await supabase
      .from('facility_availability')
      .upsert({
        school_id: schoolId,
        facility_id: facilityId,
        day_of_week, start_time, end_time,
        max_group_capacity: max_group_capacity ?? 10,
      }, { onConflict: 'facility_id,day_of_week,start_time,end_time' })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    req.log?.error({ err }, 'facilities availability unhandled error');
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/facilities/:facilityId/availability/:availId
router.delete('/:facilityId/availability/:availId', requireAuth, requireRole(...FACILITY_ADMIN_ROLES), async (req: Request, res: Response) => {
  try {
    const { schoolId } = req;
    const { facilityId, availId } = req.params;

    const { error } = await supabase
      .from('facility_availability')
      .delete()
      .eq('id', availId)
      .eq('facility_id', facilityId)
      .eq('school_id', schoolId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ err }, 'facilities availability unhandled error');
    res.status(500).json({ error: err.message });
  }
});

export default router;
