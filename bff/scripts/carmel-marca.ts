/**
 * Carmel Club Campestre: sube su logo al bucket school-assets y genera los íconos de la app instalable.
 * Va DESPUÉS de aplicar la migración 20261112132803_carmel_marca_propia (que activa el addon y escribe logo_url).
 *
 *   cd bff
 *   npx tsx scripts/carmel-marca.ts <ruta-del-logo.jpg>            # simula: valida el archivo, no sube nada
 *   npx tsx scripts/carmel-marca.ts <ruta-del-logo.jpg> --aplicar  # sube el logo y genera los íconos
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { supabase } from '../src/config/supabase';
import { generarIconosPwa } from '../src/services/pwaIcons.service';
import { invalidatePwaManifestCache } from '../src/routes/pwa.routes';

const SCHOOL_ID = '374a6716-af42-4745-afe1-8d089153e01b';
const SUPER_ADMIN = 'bcb88976-5998-440f-ba9b-803571bfb46f';
const PATH = `logos/${SCHOOL_ID}/logo.jpg`;

async function main() {
    const archivo = process.argv[2];
    const aplicar = process.argv.includes('--aplicar');
    if (!archivo) throw new Error('Falta la ruta del logo.');

    const buf = readFileSync(archivo);
    const esJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    console.log(`Logo: ${buf.length} bytes · ${esJpeg ? 'JPEG real' : 'NO es JPEG'}`);
    if (!esJpeg) throw new Error('El archivo no es un JPEG (la migración apunta a logo.jpg).');
    if (!aplicar) return console.log('Simulación: no se subió nada. Usa --aplicar.');

    const { error } = await supabase.storage.from('school-assets').upload(PATH, buf, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error(`upload: ${error.message}`);
    const { data } = supabase.storage.from('school-assets').getPublicUrl(PATH);
    console.log('Logo subido:', data.publicUrl);

    const r = await generarIconosPwa({ schoolId: SCHOOL_ID, logoUrl: data.publicUrl, backgroundColor: '#1D6FB8', actorId: SUPER_ADMIN });
    console.log('Íconos:', r.ok ? 'OK' : `FALLÓ (${r.error})`);
    try { invalidatePwaManifestCache?.(); } catch { /* el manifest se cachea 5 min en el BFF; vence solo */ }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
