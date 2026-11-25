import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole } from '../middlewares/authMiddleware';
import { esAdminDePlataforma } from '../middlewares/requirePlatformAdmin';
import { resolveSchoolBranding } from '../utils/schoolBrandingResolver';
import {
    buildVars,
    descargarImagen,
    etiquetaVariable,
    fechaLarga,
    generarPdfConstancia,
    plantillaTraeFecha,
    renderTemplate,
    snapshotDeEjemplo,
} from '../services/constancias';

const router = Router();

const ROLES_ESCUELA = ['admin', 'owner', 'school_admin', 'school'] as const;

/** Origen público del frontend para el link/QR de verificación. */
function origenPublico(req: Request): string {
    return (process.env.FRONTEND_URL || req.headers.origin || 'https://app.sportmaps.co')
        .toString()
        .replace(/\/$/, '');
}

/** Lo común al PDF real y a la vista previa: branding, logo y firma. */
async function armarPdf(opts: {
    schoolId: string;
    schoolName: string;
    snapshot: any;
    template: any;
    folio: string;
    titulo: string;
    fechaEmision: unknown;
    verifyUrl: string;
    vistaPrevia?: boolean;
}) {
    const branding = await resolveSchoolBranding(opts.schoolId);
    const vars = buildVars(opts.snapshot, opts.folio, opts.fechaEmision, opts.schoolName);
    const { texto, vacias } = renderTemplate(opts.template.body_template ?? '', vars);
    const [logo, firma] = await Promise.all([
        descargarImagen(branding.logoUrl),
        descargarImagen(opts.template.signature_image_url),
    ]);

    const pdf = await generarPdfConstancia({
        folio: opts.folio,
        titulo: opts.titulo,
        cuerpo: texto,
        fechaEmision: vars.fecha_emision,
        ciudad: vars.escuela.ciudad,
        escuela: opts.schoolName,
        color: branding.primaryColor,
        logo,
        firma,
        firmaNombre: opts.template.signature_name,
        firmaCargo: opts.template.signature_title,
        pie: opts.template.footer_text,
        verifyUrl: opts.verifyUrl,
        marcaSportMaps: branding.showWatermark,
        vistaPrevia: opts.vistaPrevia,
        incluirLineaFecha: !plantillaTraeFecha(opts.template.body_template),
    });

    return {
        pdf,
        faltantes: vacias.map((clave) => ({ clave, etiqueta: etiquetaVariable(clave) })),
        // La firma estaba configurada pero no se pudo poner (no es PNG/JPEG o no baja).
        firma_omitida: !!opts.template.signature_image_url && !firma,
    };
}

// ============================================================================
// POST /api/v1/certificates/:id/generate-pdf  (admin escuela)
//   body: { actualizar_datos?: boolean } — vuelve a tomar los datos de la ficha
//   (documento, equipo…) antes de generar; sirve para regenerar después de
//   corregir la ficha.
// ============================================================================
const ParamId = z.object({ id: z.string().uuid() });
const GenerarBody = z.object({ actualizar_datos: z.boolean().optional() }).passthrough();

router.post(
    '/:id/generate-pdf',
    requireAuth,
    requireRole(...ROLES_ESCUELA),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parse = ParamId.safeParse(req.params);
            if (!parse.success) {
                return res.status(400).json({ error: 'invalid_id', issues: parse.error.issues });
            }
            const certificateId = parse.data.id;
            const body = GenerarBody.safeParse(req.body ?? {});
            const actualizar = body.success && body.data.actualizar_datos === true;

            // 1) La constancia (service role: el alcance se valida a mano abajo)
            const { data: cert, error: certErr } = await supabase
                .from('athlete_certificates')
                .select('*')
                .eq('id', certificateId)
                .single();

            if (certErr || !cert) {
                req.log?.warn({ err: certErr, certificateId }, 'Certificate not found');
                return res.status(404).json({ error: 'certificate_not_found' });
            }

            // Cross-tenant: solo la escuela activa del usuario
            if (cert.school_id !== req.schoolId) {
                return res.status(403).json({ error: 'forbidden_other_school' });
            }

            if (cert.status !== 'issued') {
                return res.status(409).json({
                    error: 'certificate_not_issued',
                    detail: `Current status: ${cert.status}. Must be 'issued' to generate PDF.`,
                });
            }

            // 2) Datos al día si la escuela lo pide (corrigió la ficha)
            let snapshot = cert.content_snapshot;
            if (actualizar) {
                const { data: fresh, error: snapErr } = await supabase.rpc('_build_certificate_snapshot' as any, {
                    p_school_id: cert.school_id,
                    p_template_id: cert.template_id,
                    p_child_id: cert.child_id,
                    p_profile_id: cert.profile_id,
                });
                if (!snapErr && fresh) {
                    snapshot = fresh;
                    await supabase.from('athlete_certificates').update({ content_snapshot: fresh }).eq('id', certificateId);
                } else {
                    req.log?.warn({ err: snapErr, certificateId }, 'No se pudo refrescar la foto de datos');
                }
            }

            // 3) Plantilla + escuela
            const [{ data: template }, { data: school }] = await Promise.all([
                supabase.from('school_certificate_templates').select('*').eq('id', cert.template_id).single(),
                supabase.from('schools').select('id, name').eq('id', cert.school_id).single(),
            ]);
            if (!template) return res.status(500).json({ error: 'template_missing' });

            // 4) El QR apunta al TOKEN (no adivinable). Por folio, la página
            //    pública solo muestra el nombre enmascarado.
            const verifyUrl = `${origenPublico(req)}/cert/${cert.qr_verify_token}`;

            const { pdf, faltantes, firma_omitida } = await armarPdf({
                schoolId: cert.school_id,
                schoolName: school?.name ?? snapshot?.school?.name ?? 'Constancia',
                snapshot,
                template,
                folio: cert.folio,
                titulo: cert.title || template.title || 'CONSTANCIA',
                fechaEmision: cert.issued_at,
                verifyUrl,
            });

            // 5) Storage: schoolId/folio.pdf
            const objectPath = `${cert.school_id}/${cert.folio}.pdf`;
            const { error: upErr } = await supabase.storage
                .from('certificates')
                .upload(objectPath, pdf, { contentType: 'application/pdf', upsert: true });

            if (upErr) {
                req.log?.error({ err: upErr, objectPath }, 'PDF upload failed');
                return res.status(500).json({ error: 'pdf_upload_failed', detail: upErr.message });
            }

            const { error: updErr } = await supabase
                .from('athlete_certificates')
                .update({ pdf_url: objectPath })
                .eq('id', certificateId);

            if (updErr) {
                req.log?.error({ err: updErr }, 'Failed to set pdf_url');
                return res.status(500).json({ error: 'pdf_url_update_failed' });
            }

            return res.json({
                ok: true,
                certificate_id: certificateId,
                folio: cert.folio,
                pdf_path: objectPath,
                verify_url: verifyUrl,
                faltantes,
                firma_omitida,
            });
        } catch (err) {
            next(err);
        }
    }
);

// ============================================================================
// POST /api/v1/certificates/preview  (admin escuela)
//   Vista previa de una plantilla (guardada o no) con datos de ejemplo.
//   Devuelve el PDF en base64: el cliente lo muestra sin subir nada.
// ============================================================================
const PreviewBody = z.object({
    title: z.string().max(200).optional().nullable(),
    body_template: z.string().max(8000),
    signature_name: z.string().max(200).optional().nullable(),
    signature_title: z.string().max(200).optional().nullable(),
    signature_image_url: z.string().url().max(1000).optional().nullable(),
    footer_text: z.string().max(500).optional().nullable(),
});

router.post(
    '/preview',
    requireAuth,
    requireRole(...ROLES_ESCUELA),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parse = PreviewBody.safeParse(req.body ?? {});
            if (!parse.success) {
                return res.status(400).json({ error: 'invalid_body', issues: parse.error.issues });
            }
            if (!req.schoolId) return res.status(403).json({ error: 'no_school' });

            const { data: school } = await supabase
                .from('schools')
                .select('id, name, city, address, phone')
                .eq('id', req.schoolId)
                .single();

            const tpl = parse.data;
            const { pdf, faltantes, firma_omitida } = await armarPdf({
                schoolId: req.schoolId,
                schoolName: school?.name ?? 'Tu escuela',
                snapshot: snapshotDeEjemplo(school ?? {}),
                template: tpl,
                folio: 'EJEMPLO-2026-00001',
                titulo: tpl.title || 'CONSTANCIA',
                fechaEmision: new Date(),
                verifyUrl: `${origenPublico(req)}/cert/ejemplo`,
                vistaPrevia: true,
            });

            return res.json({
                ok: true,
                pdf_base64: pdf.toString('base64'),
                // En la vista previa todo tiene ejemplo; si algo sale vacío es
                // una variable mal escrita (p. ej. {{atleta.nombres}}).
                variables_desconocidas: faltantes,
                firma_omitida,
                fecha_ejemplo: fechaLarga(new Date()),
            });
        } catch (err) {
            next(err);
        }
    }
);

// ============================================================================
// GET /api/v1/certificates/:id/signed-url  (autenticado: dueño/admin)
//   URL firmada de Storage (10 min) para descargar el PDF.
// ============================================================================
router.get(
    '/:id/signed-url',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const parse = ParamId.safeParse(req.params);
            if (!parse.success) {
                return res.status(400).json({ error: 'invalid_id' });
            }
            const certificateId = parse.data.id;

            const { data: cert, error: certErr } = await supabase
                .from('athlete_certificates')
                .select('id, school_id, child_id, profile_id, pdf_url, status, folio, download_count')
                .eq('id', certificateId)
                .single();

            if (certErr || !cert || !cert.pdf_url) {
                return res.status(404).json({ error: 'certificate_or_pdf_not_found' });
            }

            // Authz: super-admin / admin de la escuela / deportista dueño / acudiente del menor.
            // 'admin' acá es admin DE ESCUELA (membresía), no de plataforma: con él
            // un admin bajaba certificados de CUALQUIER escuela.
            const isSuperAdmin = req.role === 'super_admin' && await esAdminDePlataforma(req.user.id);
            const isSchoolAdmin = ['owner', 'admin', 'school_admin', 'school'].includes(req.role)
                && cert.school_id === req.schoolId;
            const isAthleteOwner = cert.profile_id === req.user.id;

            let isParentOwner = false;
            if (cert.child_id && !isSuperAdmin && !isSchoolAdmin && !isAthleteOwner) {
                const { data: child } = await supabase
                    .from('children')
                    .select('parent_id')
                    .eq('id', cert.child_id)
                    .single();
                isParentOwner = child?.parent_id === req.user.id;
            }

            if (!isSuperAdmin && !isSchoolAdmin && !isAthleteOwner && !isParentOwner) {
                return res.status(403).json({ error: 'forbidden' });
            }

            // Una constancia anulada no se descarga (la página pública ya dice «revocada»).
            if (cert.status !== 'issued' && !isSchoolAdmin && !isSuperAdmin) {
                return res.status(409).json({ error: 'certificate_not_available' });
            }

            const { data: signed, error: signErr } = await supabase.storage
                .from('certificates')
                .createSignedUrl(cert.pdf_url, 600, { download: `${cert.folio}.pdf` });

            if (signErr || !signed) {
                return res.status(500).json({ error: 'sign_failed', detail: signErr?.message });
            }

            // Contador de descargas. Antes llamaba set_certificate_pdf_url con la
            // service key: esa RPC exige admin por auth.uid() (null acá) y fallaba
            // en silencio, así que el contador nunca subió.
            await supabase
                .from('athlete_certificates')
                .update({ download_count: Number(cert.download_count ?? 0) + 1 })
                .eq('id', certificateId);

            return res.json({ ok: true, url: signed.signedUrl, expires_in: 600 });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
