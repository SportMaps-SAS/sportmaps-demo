/**
 * soportes.service — faltantes, bloqueo con el flag prendido/apagado, permisos (coach / otra escuela => 403 que
 * viene de la RPC), archivo, ruta, tope de recordatorios y guardarSoporte. Cero red: supabase y createClient
 * simulados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    // RPC con el JWT del usuario
    userRpc: { data: null as any, error: null as any },
    userRpcCalls: [] as any[],
    // service role
    serviceRpc: { data: [] as any, error: null as any },
    serviceRpcCalls: [] as any[],
    tablas: {} as Record<string, any>,
    uploads: [] as any[],
    removes: [] as any[],
    inserts: [] as any[],
    uploadError: null as any,
    insertError: null as any,
    settings: { data: { require_athlete_documents: false, required_document_types: [] as string[] }, error: null as any },
}));

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        rpc: (fn: string, args: any) => { h.userRpcCalls.push({ fn, args }); return Promise.resolve(h.userRpc); },
    }),
}));

vi.mock('../config/supabase', () => {
    const consulta = (tabla: string) => {
        const b: any = {};
        for (const m of ['eq', 'neq', 'in', 'order', 'limit']) b[m] = () => b;
        b.select = () => b;
        b.maybeSingle = () => Promise.resolve(
            tabla === 'school_settings' ? h.settings : { data: (h.tablas[tabla] ?? [])[0] ?? null, error: null });
        b.single = () => Promise.resolve({ data: { id: 'doc-1' }, error: null });
        b.insert = (v: any) => {
            h.inserts.push({ tabla, v });
            const ins: any = { select: () => ({ single: () => Promise.resolve(h.insertError ? { data: null, error: h.insertError } : { data: { id: 'doc-1' }, error: null }) }) };
            return ins;
        };
        b.then = (res: any) => res({ data: h.tablas[tabla] ?? [], error: null });
        return b;
    };
    return {
        SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'anon',
        supabase: {
            from: (t: string) => consulta(t),
            rpc: (fn: string, args: any) => { h.serviceRpcCalls.push({ fn, args }); return Promise.resolve(h.serviceRpc); },
            storage: {
                from: () => ({
                    upload: (path: string, buf: Buffer, opts: any) => { h.uploads.push({ path, opts, bytes: buf.length }); return Promise.resolve({ error: h.uploadError }); },
                    remove: (paths: string[]) => { h.removes.push(paths); return Promise.resolve({ error: null }); },
                }),
            },
        },
    };
});

const S = await import('./soportes.service');

const ESC = '11111111-1111-4111-8111-111111111111';
const HIJO = '22222222-2222-4222-8222-222222222222';
const PADRE = '33333333-3333-4333-8333-333333333333';
const FICHA = '44444444-4444-4444-8444-444444444444';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]);

beforeEach(() => {
    h.userRpc = { data: null, error: null };
    h.userRpcCalls = [];
    h.serviceRpc = { data: [], error: null };
    h.serviceRpcCalls = [];
    h.tablas = {};
    h.uploads = [];
    h.removes = [];
    h.inserts = [];
    h.uploadError = null;
    h.insertError = null;
    h.settings = { data: { require_athlete_documents: false, required_document_types: [] }, error: null };
});

describe('cálculo de faltantes (espejo del SQL)', () => {
    it('devuelve lo que falta en el orden de los requeridos', () => {
        expect(S.calcularFaltantes(S.SOPORTES_MONSTER, ['eps_certificate', 'athlete_photo']))
            .toEqual(['guardian_id_front', 'athlete_id_front', 'guardian_signature', 'athlete_signature', 'good_standing_certificate']);
    });
    it('con los 7 no falta nada; con 6 falta exactamente 1', () => {
        expect(S.calcularFaltantes(S.SOPORTES_MONSTER, [...S.SOPORTES_MONSTER])).toEqual([]);
        expect(S.calcularFaltantes(S.SOPORTES_MONSTER, S.SOPORTES_MONSTER.slice(0, 6))).toEqual(['good_standing_certificate']);
    });
    it('un tipo repetido o uno de más (reverso, other) no cuenta ni rompe', () => {
        expect(S.calcularFaltantes(['athlete_photo'], ['athlete_photo', 'athlete_photo', 'other', 'guardian_id_back'])).toEqual([]);
        expect(S.calcularFaltantes(['athlete_photo', 'athlete_photo'], [])).toEqual(['athlete_photo']);
    });
    it('sin requeridos (flag apagado) nada falta', () => {
        expect(S.calcularFaltantes([], ['athlete_photo'])).toEqual([]);
    });
});

describe('bloqueo: flag prendido / apagado', () => {
    it('apagado no bloquea aunque «falten» tipos', () => {
        expect(S.debeBloquear({ activo: false, faltan: ['athlete_photo'] })).toBe(false);
    });
    it('prendido con faltantes bloquea; prendido y completo no', () => {
        expect(S.debeBloquear({ activo: true, faltan: ['athlete_photo'] })).toBe(true);
        expect(S.debeBloquear({ activo: true, faltan: [] })).toBe(false);
    });
    it('chequearSoportesSujeto: prendido y faltan → bloquear con la lista', async () => {
        h.userRpc = { data: { activo: true, completo: false, requeridos: S.SOPORTES_MONSTER, faltan: ['athlete_photo'] }, error: null };
        expect(await S.chequearSoportesSujeto('Bearer t', ESC, { tipo: 'child', id: HIJO }))
            .toEqual({ bloquear: true, faltan: ['athlete_photo'] });
        expect(h.userRpcCalls).toEqual([{ fn: 'soportes_verificar_sujeto', args: { p_school_id: ESC, p_subject_type: 'child', p_subject_id: HIJO } }]);
    });
    it('chequearSoportesSujeto: apagado (activo=false) → no bloquea', async () => {
        h.userRpc = { data: { activo: false, completo: true, requeridos: [], faltan: [] }, error: null };
        expect(await S.chequearSoportesSujeto('Bearer t', ESC, { tipo: 'child', id: HIJO })).toEqual({ bloquear: false });
    });
    it('chequearSoportesSujeto: migración pendiente (la RPC no existe) → no bloquea', async () => {
        h.userRpc = { data: null, error: { code: 'PGRST202', message: 'no existe' } };
        expect(await S.chequearSoportesSujeto('Bearer t', ESC, { tipo: 'child', id: HIJO })).toEqual({ bloquear: false });
    });
    it('chequearSoportesSujeto: otro error inesperado NO se traga en silencio', async () => {
        h.userRpc = { data: null, error: { code: 'XX000', message: 'boom' } };
        await expect(S.chequearSoportesSujeto('Bearer t', ESC, { tipo: 'child', id: HIJO })).rejects.toThrow(/soportes_verificar_sujeto/);
    });
});

describe('permisos (la RPC corta; el BFF lo traduce a 403)', () => {
    it('coach u otra escuela: 42501 → 403 en el estado de la escuela', async () => {
        h.userRpc = { data: null, error: { code: '42501', message: 'No autorizado.' } };
        expect(await S.estadoDeEscuela('Bearer coach', ESC)).toEqual({ ok: false, status: 403, error: 'forbidden' });
    });
    it('coach u otra escuela: 42501 → 403 al verificar un deportista', async () => {
        h.userRpc = { data: null, error: { code: '42501', message: 'No autorizado.' } };
        expect(await S.verificarSujeto('Bearer coach', ESC, { tipo: 'child', id: HIJO })).toEqual({ ok: false, status: 403, error: 'forbidden' });
    });
    it('deportista de otra escuela: 22023 → 404', async () => {
        h.userRpc = { data: null, error: { code: '22023', message: 'no pertenece' } };
        expect(await S.verificarSujeto('Bearer t', ESC, { tipo: 'child', id: HIJO })).toMatchObject({ ok: false, status: 404 });
    });
    it('la administración recibe el lote y el resumen (sin cuenta aparte)', async () => {
        h.settings = { data: { require_athlete_documents: true, required_document_types: S.SOPORTES_MONSTER }, error: null };
        h.userRpc = {
            data: [
                { subject_type: 'child', subject_id: HIJO, full_name: 'Ana', notify_profile_id: PADRE, has_account: true, required_total: 7, present_total: 7, missing: [], complete: true },
                { subject_type: 'unregistered', subject_id: FICHA, full_name: 'Luis', notify_profile_id: null, has_account: false, required_total: 7, present_total: 5, missing: ['athlete_photo', 'eps_certificate'], complete: false },
            ], error: null,
        };
        const r = await S.estadoDeEscuela('Bearer admin', ESC);
        expect(r).toMatchObject({ ok: true, activo: true, resumen: { total: 2, completos: 1, incompletos: 1, sin_cuenta_incompletos: 1 } });
    });
    it('escuela con el flag apagado: activo=false y 0 deportistas', async () => {
        h.userRpc = { data: [], error: null };
        expect(await S.estadoDeEscuela('Bearer admin', ESC)).toMatchObject({ ok: true, activo: false, deportistas: [], resumen: { total: 0 } });
    });
});

describe('archivo y ruta', () => {
    it('reconoce el formato por su firma, no por lo que diga el cliente', () => {
        expect(S.mimeDeFirma(PNG)).toBe('image/png');
        expect(S.mimeDeFirma(JPG)).toBe('image/jpeg');
        expect(S.mimeDeFirma(PDF)).toBe('application/pdf');
        expect(S.mimeDeFirma(Buffer.from('MZ\x90\x00 ejecutable'))).toBeNull();
        expect(S.mimeDeFirma(Buffer.from('<html><script>'))).toBeNull();
    });
    it('foto y firmas solo imagen; el resto acepta PDF', () => {
        expect(S.validarArchivoSoporte('athlete_photo', PDF)).toEqual({ ok: false, error: 'solo_imagen' });
        expect(S.validarArchivoSoporte('guardian_signature', PDF)).toEqual({ ok: false, error: 'solo_imagen' });
        expect(S.validarArchivoSoporte('eps_certificate', PDF)).toMatchObject({ ok: true, ext: 'pdf' });
        expect(S.validarArchivoSoporte('athlete_photo', JPG)).toMatchObject({ ok: true, ext: 'jpg' });
    });
    it('rechaza tipo inexistente, vacío y demasiado grande', () => {
        expect(S.validarArchivoSoporte('cedula', PNG)).toEqual({ ok: false, error: 'tipo_invalido' });
        expect(S.validarArchivoSoporte('athlete_photo', Buffer.alloc(0))).toEqual({ ok: false, error: 'archivo_vacio' });
        expect(S.validarArchivoSoporte('athlete_photo', Buffer.alloc(S.MAX_BYTES_SOPORTE + 1, 0xff))).toEqual({ ok: false, error: 'archivo_muy_grande' });
    });
    it('misma convención de carpetas que lee la escuela y sube la familia', () => {
        const ahora = new Date('2026-11-06T15:00:00Z');
        expect(S.rutaDeSoporte({ sujeto: { tipo: 'unregistered', id: FICHA }, tipo: 'eps_certificate', ext: 'pdf', ahora, nombre: 'eps.pdf' }))
            .toBe(`unregistered_athletes/${FICHA}/docs/eps_certificate-2026-11-06T15-00-00-000Z-eps.pdf`);
        expect(S.rutaDeSoporte({ sujeto: { tipo: 'child', id: HIJO }, tipo: 'athlete_photo', ext: 'jpg', parentId: PADRE, ahora }))
            .toMatch(new RegExp(`^children/${PADRE}/${HIJO}/docs/athlete_photo-`));
        expect(S.rutaDeSoporte({ sujeto: { tipo: 'child', id: HIJO }, tipo: 'athlete_photo', ext: 'jpg', ahora })).toMatch(new RegExp(`^children/${HIJO}/docs/`));
        expect(S.rutaDeSoporte({ sujeto: { tipo: 'profile', id: PADRE }, tipo: 'athlete_photo', ext: 'jpg', ahora })).toMatch(new RegExp(`^children/${PADRE}/docs/`));
    });
    it('el nombre original no puede colar carpetas ni caracteres raros', () => {
        const r = S.rutaDeSoporte({ sujeto: { tipo: 'unregistered', id: FICHA }, tipo: 'athlete_photo', ext: 'jpg', nombre: '../../etc/passwd.jpg' });
        expect(r.split('/')).toHaveLength(4);
        expect(r).not.toContain('..');
    });
});

describe('tope de recordatorios (cada 4 días, máximo 6)', () => {
    const ahora = new Date('2026-11-10T12:00:00Z');
    const hace = (d: number) => new Date(ahora.getTime() - d * 86_400_000).toISOString();
    it('sin registro previo: avisa', () => expect(S.puedeAvisar(null, ahora)).toBe(true));
    it('a los 3 días no; a los 4 sí', () => {
        expect(S.puedeAvisar({ last_sent_at: hace(3), sent_count: 1 }, ahora)).toBe(false);
        expect(S.puedeAvisar({ last_sent_at: hace(4), sent_count: 1 }, ahora)).toBe(true);
    });
    it('con 6 avisos nunca más', () => {
        expect(S.puedeAvisar({ last_sent_at: hace(30), sent_count: 6 }, ahora)).toBe(false);
        expect(S.puedeAvisar({ last_sent_at: hace(30), sent_count: 5 }, ahora)).toBe(true);
    });
    it('máximo 0 apaga el aviso', () => expect(S.puedeAvisar(null, ahora, 4, 0)).toBe(false));
});

describe('avisos a las familias', () => {
    const fila = (o: Partial<any>) => ({
        subject_type: 'child', subject_id: HIJO, full_name: 'Ana', notify_profile_id: PADRE, has_account: true,
        required_total: 7, present_total: 5, missing: ['athlete_photo', 'eps_certificate'], complete: false, ...o,
    });
    it('un acudiente con dos hijos recibe UN aviso', () => {
        const a = S.agruparAvisos([fila({}), fila({ subject_id: FICHA, full_name: 'Bruno', missing: ['good_standing_certificate'] })]);
        expect(a).toHaveLength(1);
        expect(a[0].deportistas.map((d) => d.nombre)).toEqual(['Ana', 'Bruno']);
    });
    it('sin cuenta, completos o sin faltantes no generan aviso', () => {
        expect(S.agruparAvisos([fila({ notify_profile_id: null, has_account: false }), fila({ complete: true, missing: [] })])).toEqual([]);
    });
    it('el texto nunca habla de cobro, mora ni pago', () => {
        const uno = S.textoAviso(S.agruparAvisos([fila({})])[0]);
        const varios = S.textoAviso(S.agruparAvisos([fila({}), fila({ subject_id: FICHA, full_name: 'Bruno' })])[0]);
        for (const t of [uno, varios]) {
            expect(`${t.titulo} ${t.mensaje}`).not.toMatch(/cobr|mora|pago|deuda|vencid|saldo/i);
        }
        expect(uno.mensaje).toContain('Ana');
        expect(uno.mensaje).toContain('Foto del deportista');
    });
});

describe('guardarSoporte', () => {
    const base = { schoolId: ESC, sujeto: { tipo: 'unregistered' as const, id: FICHA }, tipo: 'eps_certificate', archivo: { buffer: PDF, nombre: 'eps.pdf' } };

    it('guarda en el bucket privado, registra la fila y dice qué falta (flag prendido)', async () => {
        h.tablas.unregistered_athletes = [{ id: FICHA }];
        h.serviceRpc = { data: [{ subject_type: 'unregistered', subject_id: FICHA, full_name: 'Luis', notify_profile_id: null, has_account: false, required_total: 7, present_total: 6, missing: ['athlete_photo'], complete: false }], error: null };
        const r = await S.guardarSoporte({ ...base, subidoPor: PADRE });
        expect(r).toMatchObject({ ok: true, tipo: 'eps_certificate', activo: true, completo: false, faltan: ['athlete_photo'] });
        expect(h.uploads).toHaveLength(1);
        expect(h.uploads[0].path).toMatch(new RegExp(`^unregistered_athletes/${FICHA}/docs/eps_certificate-`));
        expect(h.uploads[0].opts).toMatchObject({ contentType: 'application/pdf', upsert: false });
        expect(h.inserts[0]).toMatchObject({ tabla: 'athlete_documents', v: {
            school_id: ESC, document_type: 'eps_certificate', unregistered_athlete_id: FICHA, child_id: null, user_id: null, uploaded_by: PADRE,
        } });
        expect(h.serviceRpcCalls[0]).toEqual({ fn: 'soportes_estado_interno', args: { p_school_id: ESC, p_subject_type: 'unregistered', p_subject_id: FICHA } });
    });

    it('flag apagado: guarda igual y responde activo=false, sin faltantes', async () => {
        h.tablas.unregistered_athletes = [{ id: FICHA }];
        h.serviceRpc = { data: [], error: null };
        expect(await S.guardarSoporte(base)).toMatchObject({ ok: true, activo: false, completo: true, faltan: [] });
    });

    it('deportista que no es de la escuela → 404 y no sube nada', async () => {
        h.tablas.unregistered_athletes = [];
        expect(await S.guardarSoporte(base)).toEqual({ ok: false, status: 404, error: 'deportista_no_encontrado' });
        expect(h.uploads).toHaveLength(0);
        expect(h.inserts).toHaveLength(0);
    });

    it('archivo que no es imagen/PDF → 400 y no sube nada', async () => {
        const r = await S.guardarSoporte({ ...base, archivo: { buffer: Buffer.from('MZ\x90 malware') } });
        expect(r).toEqual({ ok: false, status: 400, error: 'formato_no_permitido' });
        expect(h.uploads).toHaveLength(0);
    });

    it('foto como PDF → 400 solo_imagen; archivo enorme → 413', async () => {
        expect(await S.guardarSoporte({ ...base, tipo: 'athlete_photo' })).toMatchObject({ ok: false, status: 400, error: 'solo_imagen' });
        expect(await S.guardarSoporte({ ...base, archivo: { buffer: Buffer.concat([JPG, Buffer.alloc(S.MAX_BYTES_SOPORTE)]) } }))
            .toMatchObject({ ok: false, status: 413 });
    });

    it('ids que no son uuid → 400', async () => {
        expect(await S.guardarSoporte({ ...base, schoolId: 'x' })).toMatchObject({ ok: false, status: 400 });
        expect(await S.guardarSoporte({ ...base, sujeto: { tipo: 'child', id: 'no' } })).toMatchObject({ ok: false, status: 400 });
    });

    it('si falla el registro, el archivo subido se retira (sin huérfanos)', async () => {
        h.tablas.unregistered_athletes = [{ id: FICHA }];
        h.insertError = { message: 'rls' };
        await expect(S.guardarSoporte(base)).rejects.toThrow(/athlete_documents/);
        expect(h.removes).toHaveLength(1);
        expect(h.removes[0][0]).toBe(h.uploads[0].path);
    });

    it('un hijo sube a la carpeta de su acudiente', async () => {
        h.tablas.children = [{ id: HIJO, parent_id: PADRE, school_id: ESC }];
        const r = await S.guardarSoporte({ ...base, sujeto: { tipo: 'child', id: HIJO }, tipo: 'athlete_photo', archivo: { buffer: JPG } });
        expect(r.ok).toBe(true);
        expect(h.uploads[0].path).toMatch(new RegExp(`^children/${PADRE}/${HIJO}/docs/athlete_photo-`));
        expect(h.inserts[0].v).toMatchObject({ child_id: HIJO, unregistered_athlete_id: null });
    });

    it('un hijo de OTRA escuela (ni children.school_id ni inscripción) → 404', async () => {
        h.tablas.children = [{ id: HIJO, parent_id: PADRE, school_id: '99999999-9999-4999-8999-999999999999' }];
        h.tablas.enrollments = [];
        expect(await S.guardarSoporte({ ...base, sujeto: { tipo: 'child', id: HIJO }, tipo: 'athlete_photo', archivo: { buffer: JPG } }))
            .toMatchObject({ ok: false, status: 404 });
        expect(h.uploads).toHaveLength(0);
    });
});

describe('esFamiliaDelSujeto', () => {
    it('el acudiente del hijo sí; otro perfil no', async () => {
        h.tablas.children = [{ parent_id: PADRE }];
        expect(await S.esFamiliaDelSujeto(PADRE, { tipo: 'child', id: HIJO })).toBe(true);
        expect(await S.esFamiliaDelSujeto('otro', { tipo: 'child', id: HIJO })).toBe(false);
    });
    it('el adulto solo por su propio perfil', async () => {
        expect(await S.esFamiliaDelSujeto(PADRE, { tipo: 'profile', id: PADRE })).toBe(true);
        expect(await S.esFamiliaDelSujeto('otro', { tipo: 'profile', id: PADRE })).toBe(false);
    });
});

describe('verificarSujetoDeFamilia (la familia titular, con service role)', () => {
    const fila = (o: any = {}) => ({ subject_type: 'child', subject_id: HIJO, full_name: 'Ana', notify_profile_id: PADRE, has_account: true, required_total: 7, present_total: 5, missing: ['eps_certificate', 'athlete_photo'], complete: false, ...o });

    it('escuela sin soportes exigidos: activo=false y nada que pedir (no consulta el estado)', async () => {
        h.settings = { data: { require_athlete_documents: false, required_document_types: [] }, error: null };
        const r = await S.verificarSujetoDeFamilia(ESC, { tipo: 'child', id: HIJO });
        expect(r).toEqual({ ok: true, activo: false, completo: true, requeridos: [], faltan: [] });
        expect(h.serviceRpcCalls).toHaveLength(0);
    });
    it('con soportes exigidos: devuelve lo que falta y los tipos requeridos de la escuela', async () => {
        h.settings = { data: { require_athlete_documents: true, required_document_types: ['athlete_photo', 'eps_certificate'] }, error: null };
        h.serviceRpc = { data: [fila()], error: null };
        const r: any = await S.verificarSujetoDeFamilia(ESC, { tipo: 'child', id: HIJO });
        expect(r).toMatchObject({ ok: true, activo: true, completo: false, requeridos: ['athlete_photo', 'eps_certificate'], faltan: ['eps_certificate', 'athlete_photo'] });
        expect(h.serviceRpcCalls[0]).toMatchObject({ fn: 'soportes_estado_interno', args: { p_school_id: ESC, p_subject_type: 'child', p_subject_id: HIJO } });
    });
    it('deportista completo', async () => {
        h.settings = { data: { require_athlete_documents: true, required_document_types: ['athlete_photo'] }, error: null };
        h.serviceRpc = { data: [fila({ missing: [], complete: true, present_total: 7 })], error: null };
        expect(await S.verificarSujetoDeFamilia(ESC, { tipo: 'child', id: HIJO })).toMatchObject({ ok: true, completo: true, faltan: [] });
    });
    it('el deportista no es de esa escuela: 404', async () => {
        h.settings = { data: { require_athlete_documents: true, required_document_types: ['athlete_photo'] }, error: null };
        h.serviceRpc = { data: [], error: null };
        expect(await S.verificarSujetoDeFamilia(ESC, { tipo: 'child', id: HIJO })).toEqual({ ok: false, status: 404, error: 'deportista_no_encontrado' });
    });
});
