// Tests de la validación y conversión del escudo (spec carnet-3d-club §10).
// Sin red ni base: solo las funciones puras de branding-escudo.ts.
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
    detectarFormatoEscudo,
    validarSvgEscudo,
    procesarEscudo,
    ESCUDO_MAX_BYTES,
    STATUS_POR_ERROR_BRANDING,
} from './branding-escudo';

/** PNG RGBA: fondo transparente con un cuadrado opaco rojo en el centro. */
async function pngConTransparencia(lado = 600): Promise<Buffer> {
    const cuadro = Math.floor(lado / 2);
    const rojo = await sharp({
        create: { width: cuadro, height: cuadro, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    return sharp({
        create: { width: lado, height: lado, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
        .composite([{ input: rojo, left: Math.floor(lado / 4), top: Math.floor(lado / 4) }])
        .png()
        .toBuffer();
}

async function pngOpaco(ancho: number, alto: number): Promise<Buffer> {
    return sharp({
        create: { width: ancho, height: alto, channels: 3, background: { r: 10, g: 120, b: 40 } },
    }).png().toBuffer();
}

/** Alfa del píxel (x, y) de una imagen cualquiera. */
async function alfaEn(img: Buffer, x: number, y: number): Promise<number> {
    const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels + 3]!;
}

const SVG_OK = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
        '<circle cx="50" cy="50" r="30" fill="#248223"/></svg>',
);

describe('detectarFormatoEscudo — firma de bytes, no extensión', () => {
    it('reconoce PNG, WebP y SVG', async () => {
        const png = await pngConTransparencia(16);
        const webp = await sharp(png).webp().toBuffer();
        expect(detectarFormatoEscudo(png)).toBe('png');
        expect(detectarFormatoEscudo(webp)).toBe('webp');
        expect(detectarFormatoEscudo(SVG_OK)).toBe('svg');
        expect(detectarFormatoEscudo(Buffer.from('﻿<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
    });

    it('rechaza JPEG (sin transparencia) y lo que no es imagen', async () => {
        const jpg = await sharp(await pngOpaco(16, 16)).jpeg().toBuffer();
        expect(detectarFormatoEscudo(jpg)).toBeNull();
        expect(detectarFormatoEscudo(Buffer.from('%PDF-1.7 hola'))).toBeNull();
        expect(detectarFormatoEscudo(Buffer.from('<?xml version="1.0"?><html></html>'))).toBeNull();
        expect(detectarFormatoEscudo(Buffer.alloc(0))).toBeNull();
    });

    it('un PNG renombrado no engaña: manda el contenido', async () => {
        // Un "escudo.png" que en realidad es texto → no permitido.
        expect(detectarFormatoEscudo(Buffer.from('MZ\x90\x00 ejecutable disfrazado'))).toBeNull();
    });
});

describe('validarSvgEscudo', () => {
    it('acepta un SVG limpio y anclas internas', () => {
        expect(validarSvgEscudo(SVG_OK.toString()).ok).toBe(true);
        expect(validarSvgEscudo('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>').ok).toBe(true);
    });

    it.each([
        ['script', '<svg><script>alert(1)</script></svg>'],
        ['on*', '<svg onload="alert(1)"></svg>'],
        ['javascript:', '<svg><a href="javascript:alert(1)"><rect/></a></svg>'],
        ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
        ['entidad XML', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'],
        ['href externo', '<svg><image href="https://evil.example/a.png"/></svg>'],
        ['xlink:href a archivo', '<svg><image xlink:href="file:///etc/passwd"/></svg>'],
        ['url() externa', '<svg><rect style="fill:url(https://evil.example/x)"/></svg>'],
        ['@import', '<svg><style>@import "https://evil.example/x.css";</style></svg>'],
    ])('rechaza %s', (_n, svg) => {
        expect(validarSvgEscudo(svg).ok).toBe(false);
    });
});

describe('procesarEscudo', () => {
    it('rechaza archivos de más de 2 MB', async () => {
        const grande = Buffer.concat([await pngConTransparencia(16), Buffer.alloc(ESCUDO_MAX_BYTES)]);
        const r = await procesarEscudo(grande);
        expect(r).toMatchObject({ ok: false, error: 'archivo_muy_grande' });
    });

    it('rechaza archivo vacío', async () => {
        expect(await procesarEscudo(Buffer.alloc(0))).toMatchObject({ ok: false, error: 'archivo_vacio' });
    });

    it('rechaza imágenes con lado menor < 512 px', async () => {
        const r = await procesarEscudo(await pngOpaco(800, 511));
        expect(r).toMatchObject({ ok: false, error: 'imagen_muy_pequena' });
    });

    it('acepta 512 px justos', async () => {
        const r = await procesarEscudo(await pngOpaco(512, 900));
        expect(r.ok).toBe(true);
    });

    it('rechaza JPEG aunque sea grande', async () => {
        const jpg = await sharp(await pngOpaco(600, 600)).jpeg().toBuffer();
        expect(await procesarEscudo(jpg)).toMatchObject({ ok: false, error: 'formato_no_permitido' });
    });

    it('WebP conserva el alfa: el píxel transparente sigue transparente', async () => {
        const png = await pngConTransparencia(600);
        expect(await alfaEn(png, 0, 0)).toBe(0);

        const r = await procesarEscudo(png);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(detectarFormatoEscudo(r.webp)).toBe('webp');
        const meta = await sharp(r.webp).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.hasAlpha).toBe(true);
        // esquina: transparente; centro: opaco
        expect(await alfaEn(r.webp, 0, 0)).toBe(0);
        expect(await alfaEn(r.webp, 300, 300)).toBe(255);
        expect(r.sinTransparencia).toBe(false);
    });

    it('avisa (sin bloquear) cuando la imagen no tiene transparencia', async () => {
        const r = await procesarEscudo(await pngOpaco(600, 600));
        expect(r).toMatchObject({ ok: true, sinTransparencia: true });
    });

    it('SVG → PNG → WebP: rasteriza a buen tamaño y conserva la transparencia', async () => {
        const r = await procesarEscudo(SVG_OK);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.formatoOriginal).toBe('svg');
        expect(Math.min(r.ancho, r.alto)).toBeGreaterThanOrEqual(512);
        expect((await sharp(r.webp).metadata()).format).toBe('webp');
        // fuera del círculo: transparente; centro: opaco
        expect(await alfaEn(r.webp, 2, 2)).toBe(0);
        expect(await alfaEn(r.webp, Math.floor(r.ancho / 2), Math.floor(r.alto / 2))).toBe(255);
        expect(r.sinTransparencia).toBe(false);
    });

    it('SVG inseguro no se rasteriza', async () => {
        const r = await procesarEscudo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'));
        expect(r).toMatchObject({ ok: false, error: 'svg_inseguro' });
    });

    it('normaliza el lado mayor a 1024 px', async () => {
        const r = await procesarEscudo(await pngOpaco(2000, 1000));
        expect(r).toMatchObject({ ok: true, ancho: 1024, alto: 512 });
    });
});

describe('mapa de errores de update_school_branding', () => {
    it('invalid_accent_color → 400', () => {
        expect(STATUS_POR_ERROR_BRANDING.invalid_accent_color).toBe(400);
        expect(STATUS_POR_ERROR_BRANDING.feature_not_available).toBe(403);
    });
});
