import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
    aFormatoIncrustable,
    buildVars,
    edadEn,
    esImagenIncrustable,
    fechaLarga,
    generarPdfConstancia,
    plantillaTraeFecha,
    renderTemplate,
    snapshotDeEjemplo,
    VARIABLES_CONSTANCIA,
} from './constancias';

describe('fechaLarga', () => {
    it('una fecha de calendario no se corre un día', () => {
        expect(fechaLarga('2026-12-31')).toBe('31 de diciembre de 2026');
        expect(fechaLarga('2026-01-01')).toBe('1 de enero de 2026');
    });
    it('un instante se lee en hora de Bogotá', () => {
        // 2026-11-25 02:00 UTC = 24 nov 21:00 en Bogotá
        expect(fechaLarga('2026-11-25T02:00:00Z')).toBe('24 de noviembre de 2026');
    });
    it('vacío o basura → vacío', () => {
        expect(fechaLarga(null)).toBe('');
        expect(fechaLarga('')).toBe('');
        expect(fechaLarga('no es fecha')).toBe('');
    });
});

describe('edadEn', () => {
    it('cuenta los años cumplidos', () => {
        expect(edadEn('2017-04-09', '2026-04-08')).toBe('8');
        expect(edadEn('2017-04-09', '2026-04-09')).toBe('9');
        expect(edadEn(null, '2026-04-09')).toBe('');
    });
});

describe('renderTemplate', () => {
    it('reemplaza variables anidadas y reporta las vacías', () => {
        const r = renderTemplate('Hola {{atleta.nombre}}, doc {{atleta.documento}}.', { atleta: { nombre: 'Ana', documento: '' } });
        expect(r.texto).toBe('Hola Ana, doc.');
        expect(r.vacias).toEqual(['atleta.documento']);
    });
    it('una variable mal escrita queda vacía y se reporta', () => {
        const r = renderTemplate('{{atleta.nombres}} x', { atleta: { nombre: 'Ana' } });
        expect(r.texto).toBe(' x');
        expect(r.vacias).toEqual(['atleta.nombres']);
    });
    it('no deja espacios dobles ni espacio antes de la coma', () => {
        const r = renderTemplate('inscrito en {{equipo}} , sede {{sede}} .', { equipo: '', sede: 'Norte' });
        expect(r.texto).toBe('inscrito en, sede Norte.');
    });
    it('respeta los saltos de párrafo', () => {
        expect(renderTemplate('a\n\nb', {}).texto).toBe('a\n\nb');
    });
    it('un objeto no se imprime como [object Object]', () => {
        const r = renderTemplate('{{atleta}}', { atleta: { nombre: 'Ana' } });
        expect(r.texto).toBe('');
        expect(r.vacias).toEqual(['atleta']);
    });
});

describe('buildVars', () => {
    const snap = snapshotDeEjemplo({ name: 'Club X', city: 'Cali' });

    it('usa la fecha de EMISIÓN, no la de hoy', () => {
        const v = buildVars(snap, 'CX-2026-00001', '2026-03-10T15:00:00Z');
        expect(v.fecha_emision).toBe('10 de marzo de 2026');
        expect(v.fecha_actual).toBe('10 de marzo de 2026');
    });
    it('fechas de la inscripción en español', () => {
        const v = buildVars(snap, 'F', '2026-03-10');
        expect(v.inscripcion.vence).toBe('15 de diciembre de 2026');
        expect(v.inscripcion.inicio).toBe('1 de febrero de 2026');
        expect(v.atleta.fecha_nac).toBe('9 de abril de 2017');
    });
    it('concuerda el género', () => {
        expect(buildVars(snap, 'F', '2026-03-10').atleta.inscrito).toBe('inscrita');
        const m = { ...snap, athlete: { ...snap.athlete, gender: 'M' } };
        expect(buildVars(m, 'F', '2026-03-10').atleta.inscrito).toBe('inscrito');
        const n = { ...snap, athlete: { ...snap.athlete, gender: null } };
        expect(buildVars(n, 'F', '2026-03-10').atleta.inscrito).toBe('inscrito(a)');
    });
    it('identificación: frase completa con documento, nada sin él', () => {
        expect(buildVars(snap, 'F', '2026-03-10').atleta.identificacion).toBe('identificada con TI 1.023.456.789');
        expect(buildVars(snap, 'F', '2026-03-10').atleta.activo).toBe('activa');
        const sinDoc = { ...snap, athlete: { ...snap.athlete, doc_number: null } };
        const v = buildVars(sinDoc, 'F', '2026-03-10');
        expect(v.atleta.identificacion).toBe('');
        expect(renderTemplate('que {{atleta.nombre}}, {{atleta.identificacion}}, de {{atleta.edad}} años', v).texto)
            .toBe('que Sofía Herrera Gómez, de 8 años');
    });
    it('el nombre de la escuela manda sobre la foto de datos', () => {
        expect(buildVars(snap, 'F', null, 'Nombre vivo').escuela.nombre).toBe('Nombre vivo');
        expect(buildVars(snap, 'F', null).escuela.ciudad).toBe('Cali');
    });
    it('toda variable del catálogo tiene valor con el ejemplo', () => {
        const v = buildVars(snapshotDeEjemplo({ name: 'C', city: 'B', address: 'Dir', phone: '1' }), 'F', '2026-03-10');
        const plantilla = VARIABLES_CONSTANCIA.map((x) => `{{${x.clave}}}`).join(' ');
        expect(renderTemplate(plantilla, v).vacias).toEqual([]);
    });
});

describe('plantillaTraeFecha', () => {
    it('detecta las dos variables de fecha', () => {
        expect(plantillaTraeFecha('el {{ fecha_emision }}')).toBe(true);
        expect(plantillaTraeFecha('el {{fecha_actual}}')).toBe(true);
        expect(plantillaTraeFecha('sin fecha')).toBe(false);
    });
});

describe('esImagenIncrustable', () => {
    it('acepta PNG y JPEG por firma de bytes', () => {
        expect(esImagenIncrustable(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
        expect(esImagenIncrustable(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
        expect(esImagenIncrustable(Buffer.from('<svg></svg>'))).toBe(false);
        expect(esImagenIncrustable(null)).toBe(false);
    });
});

describe('aFormatoIncrustable', () => {
    it('pasa un WEBP (así sube el navegador los logos) a PNG', async () => {
        const webp = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0.5 } } }).webp().toBuffer();
        expect(esImagenIncrustable(webp)).toBe(false);
        const png = await aFormatoIncrustable(webp);
        expect(esImagenIncrustable(png)).toBe(true);
    });
    it('basura → null, sin lanzar', async () => {
        expect(await aFormatoIncrustable(Buffer.from('no es imagen'))).toBeNull();
        expect(await aFormatoIncrustable(null)).toBeNull();
    });
});

describe('generarPdfConstancia', () => {
    it('produce un PDF aunque el cuerpo sea largo', async () => {
        const pdf = await generarPdfConstancia({
            folio: 'CX-2026-00001',
            titulo: 'CONSTANCIA DE ESTUDIO',
            cuerpo: 'Texto largo. '.repeat(600),
            fechaEmision: '24 de noviembre de 2026',
            escuela: 'Club X',
            color: '#248223',
            firmaNombre: 'Ana Pérez',
            firmaCargo: 'Directora',
            pie: 'Documento electrónico',
            verifyUrl: 'https://app.sportmaps.co/cert/00000000-0000-0000-0000-000000000000',
            marcaSportMaps: true,
            vistaPrevia: true,
            incluirLineaFecha: true,
        });
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        expect(pdf.length).toBeGreaterThan(2000);
    });
});
