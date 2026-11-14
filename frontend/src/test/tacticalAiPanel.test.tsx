/**
 * «Analizar jugada» con IA (M3): panel, capa de «Ver contraataque», «Guardar
 * como nueva jugada» y saldo agotado. El BFF va mockeado (bffClient): nada
 * sale a la red ni al modelo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => {
  class BFFError extends Error {
    constructor(public status: number, message: string, public body?: unknown) { super(message); }
  }
  return { bffClient: { post: api.post, get: api.get }, BFFError };
});

import { BFFError } from '@/lib/api/bffClient';
import { TacticalAiOverlay, TacticalAiPanel, type AiPreview } from '@/components/school/TacticalAiPanel';
import {
  quotaLabel, fallbackMoreMessage, requestMoreHref, buildAnalyzeRequest, humanizeResult, humanizeText, suggestionToBoardFrames,
  rechargeLabel, rechargeOfferOf, boostLabel, AI_METER_UNIT,
  type AiResult, type AiSuggestion,
} from '@/lib/school/tacticalAi';
import { resolveViewerSource, suggestionViewer3D } from '@/lib/school/tactical3dSuggestion';
import { FULL_VIEW } from '@/lib/school/tacticalGeometry';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';

const K1 = 'athlete:11111111-1111-4111-8111-111111111111';
const K2 = 'child:22222222-2222-4222-8222-222222222222';

const counter: AiSuggestion = {
  titulo: 'Salida rápida por la banda derecha',
  explicacion: 'El rival recupera y corre al espacio del lateral.',
  frames: [
    { id: 'c1', duration_ms: 1000, players: [{ key: K1, x: 50, y: 90 }, { key: 'rival:2', x: 70, y: 20 }, { key: 'rival:1', x: 40, y: 25 }], ball: { x: 70, y: 20 }, arrows: [] },
    { id: 'c2', duration_ms: 1500, players: [{ key: K1, x: 52, y: 85 }, { key: 'rival:2', x: 75, y: 45 }], ball: null, arrows: [{ type: 'arrow', x1: 70, y1: 20, x2: 75, y2: 45, color: 'red' }] },
    { id: 'c3', duration_ms: 1500, players: [{ key: K1, x: 55, y: 80 }, { key: 'rival:2', x: 78, y: 70 }, { key: 'rival:1', x: 50, y: 60 }], ball: { x: 78, y: 70 }, arrows: [] },
  ],
};
const result: AiResult = {
  lectura: 'La jugada carga la banda derecha con el lateral.',
  riesgos: [{ titulo: 'Espalda del lateral', detalle: 'Queda un carril libre.', zona: 'banda derecha propia' }],
  contraataques: [counter, { ...counter, titulo: 'Pase largo al centro' }],
  variantes: [{ ...counter, titulo: 'Lateral con cobertura', frames: counter.frames.map((f) => ({ ...f, players: f.players.filter((p) => !p.key.startsWith('rival:')) })) }],
};
/** Saldo del BFF (cupo por costo real): `pctLeft` % que queda, `futbol` análisis aprox. */
const balance = (pctLeft: number, futbol = 9, extra: Record<string, unknown> = {}) => ({
  period: '2026-10', used_usd: (100 - pctLeft) / 100, budget_usd: 1, remaining_usd: pctLeft / 100,
  pct: 100 - pctLeft, remaining_pct: pctLeft, exhausted: pctLeft < 8, limited_by: pctLeft < 8 ? 'user' : null,
  approx_remaining: { futbol, voleibol: futbol + 3 }, analyses: 6, cache_hits: 1, ...extra,
});

const playFrames: TacticalFrame[] = [{
  id: 'f1', duration_ms: 1200,
  players: [{ key: K1, x: 50, y: 90 }, { key: K2, x: 30, y: 60 }],
  ball: null,
  arrows: [
    { type: 'opponent', x1: 50, y1: 20, x2: 50, y2: 20, color: 'orange' },
    { type: 'text', x1: 50, y1: 50, x2: 50, y2: 50, text: 'Juanito presiona' },
    { type: 'freehand', x1: 1, y1: 1, x2: 2, y2: 2, points: [1, 1, 2, 2] },
  ],
}];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function setup(over: Partial<React.ComponentProps<typeof TacticalAiPanel>> = {}) {
  const onPreview = vi.fn();
  const onApply = vi.fn();
  const getRequest = vi.fn(() => buildAnalyzeRequest({ teamId: 't-1', sport: 'futbol', frames: playFrames, labelOf: () => 'Central' }));
  const props = {
    open: true, onClose: vi.fn(), getRequest, sport: 'futbol' as const, canApply: true,
    preview: null as AiPreview | null, onPreview, onApply, ...over,
  };
  const utils = render(
    <MemoryRouter initialEntries={['/pizarra']}>
      <Routes>
        <Route path="*" element={<><TacticalAiPanel {...props} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, onPreview, onApply, getRequest, props };
}

beforeEach(() => {
  api.post.mockReset();
  api.get.mockReset();
  api.get.mockResolvedValue(balance(60));
  api.post.mockResolvedValue({ result, cached: false, balance: balance(54, 8) });
});

describe('TacticalAiPanel', () => {
  it('muestra el saldo y, al analizar, la lectura, los riesgos y las tarjetas «Sugerencia IA»', async () => {
    setup();
    expect(await screen.findByText('Te queda el 60 % de tu IA este mes · unos 9 análisis de fútbol 11')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'IA que te queda este mes' })).toHaveAttribute('aria-valuenow', '60');
    expect(api.get).toHaveBeenCalledWith('/api/v1/school/tactical/ai-balance?sport=futbol');
    fireEvent.click(screen.getByRole('button', { name: /Analizar jugada/ }));
    expect(await screen.findByText(result.lectura)).toBeInTheDocument();
    expect(screen.getByText(/Espalda del lateral/)).toBeInTheDocument();
    expect(screen.getAllByText('Sugerencia IA').length).toBeGreaterThanOrEqual(4); // lectura + 3 tarjetas
    expect(screen.getByText('Salida rápida por la banda derecha')).toBeInTheDocument();
    expect(screen.getByText('Te queda el 54 % de tu IA este mes · unos 8 análisis de fútbol 11')).toBeInTheDocument();
    // Lo que se mandó: sin texto libre ni lápiz, rival en su color.
    const sent = api.post.mock.calls[0][1];
    expect(api.post.mock.calls[0][0]).toBe('/api/v1/school/tactical/analyze');
    expect(JSON.stringify(sent)).not.toContain('Juanito');
    expect(sent.frames[0].arrows.map((a: any) => a.type)).toEqual(['opponent']);
    expect(sent.colors).toEqual({ own: 'green', rival: 'orange' });
    expect(sent.labels[K1]).toBe('Central');
  });

  it('buildAnalyzeRequest manda la formación elegida (clave de catálogo) y descarta basura', () => {
    const base = { teamId: 't-1', sport: 'futbol' as const, frames: playFrames, labelOf: () => 'Central' };
    expect(buildAnalyzeRequest({ ...base, formation: '4-2-3-1' }).formacion).toBe('4-2-3-1');
    expect(buildAnalyzeRequest({ ...base, formation: 'Mi formación <b>' }).formacion).toBeUndefined();
    expect(buildAnalyzeRequest(base).formacion).toBeUndefined();
  });

  it('«Ver contraataque» manda la sugerencia a la capa y la capa dibuja a los rivales', async () => {
    const { onPreview } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    const ver = await screen.findAllByRole('button', { name: 'Ver contraataque' });
    fireEvent.click(ver[0]);
    expect(onPreview).toHaveBeenCalledTimes(2); // null al analizar + la sugerencia
    const p = onPreview.mock.calls[1][0] as AiPreview;
    expect(p.kind).toBe('contraataque');
    expect(p.frames).toBe(counter.frames);
    expect(p.rivalColor).toBe('orange');
    const html = renderToStaticMarkup(<TacticalAiOverlay preview={p} view={FULL_VIEW} />);
    expect(html.match(/data-ai-rival="true"/g)).toHaveLength(2);
    expect(html).toContain('data-ai-own="true"');
    expect(html).toContain('Sugerencia IA');
    expect(html).toContain('#fb923c'); // naranja del rival
  });

  it('«Guardar como nueva jugada» entrega cuadros de pizarra: rivales como material «Rival» y balón', async () => {
    const { onApply } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Guardar como nueva jugada/ }))[0]);
    const [frames, titulo] = onApply.mock.calls[0];
    expect(titulo).toBe('Salida rápida por la banda derecha');
    expect(frames).toHaveLength(3);
    for (const f of frames as TacticalFrame[]) {
      expect(f.players.every((p) => !p.key.startsWith('rival:'))).toBe(true);
      expect(f.arrows[0].type).toBe('ball');
      expect(f.arrows.filter((a) => a.type === 'opponent')).toHaveLength(2); // índice estable
    }
    // rival:1 falta en el cuadro 2: se queda donde estaba.
    expect(frames[1].arrows[1]).toMatchObject({ type: 'opponent', x1: 40, y1: 25, color: 'orange' });
    expect(frames[2].arrows[2]).toMatchObject({ type: 'opponent', x1: 78, y1: 70 });
    expect(new Set(frames.map((f: TacticalFrame) => f.id)).size).toBe(3);
  });

  it('«Útil / No útil» en cada sugerencia: manda la valoración con el analysis_ref; otro toque la quita', async () => {
    const REF = 'b'.repeat(64);
    api.post.mockResolvedValueOnce({ result, cached: false, balance: balance(54, 8), analysis_ref: REF });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    const util = await screen.findByRole('button', { name: 'Útil: Pase largo al centro' });
    fireEvent.click(util);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/school/tactical/ai-feedback', {
      analysis_ref: REF, sport: 'futbol', kind: 'contraataque', index: 1, verdict: 'util',
    }));
    expect(util).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(util);
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/v1/school/tactical/ai-feedback', expect.objectContaining({ verdict: null })));
    fireEvent.click(screen.getByRole('button', { name: 'No útil: Lateral con cobertura' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/v1/school/tactical/ai-feedback', expect.objectContaining({ kind: 'variante', index: 0, verdict: 'no_util' })));
  });

  it('«Guardar como nueva jugada» queda registrado como sugerencia usada', async () => {
    const REF = 'c'.repeat(64);
    api.post.mockResolvedValueOnce({ result, cached: false, balance: balance(54, 8), analysis_ref: REF });
    const { onApply } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Guardar como nueva jugada/ }))[2]);
    expect(onApply).toHaveBeenCalled();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/school/tactical/ai-feedback', {
      analysis_ref: REF, sport: 'futbol', kind: 'variante', index: 0, saved: true,
    }));
  });

  it('si el envío de la valoración falla, el voto vuelve atrás', async () => {
    api.post.mockResolvedValueOnce({ result, cached: false, balance: balance(54, 8), analysis_ref: 'd'.repeat(64) });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    const util = await screen.findByRole('button', { name: 'Útil: Salida rápida por la banda derecha' });
    api.post.mockRejectedValueOnce(new BFFError(500, 'x'));
    fireEvent.click(util);
    await waitFor(() => expect(util).toHaveAttribute('aria-pressed', 'false'));
  });

  it('sin analysis_ref (BFF viejo) no ofrece valorar', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    await screen.findByText(result.lectura);
    expect(screen.queryByRole('button', { name: /^Útil/ })).toBeNull();
  });

  it('cupo ampliado: la barra dice hasta cuándo', async () => {
    api.get.mockResolvedValue(balance(60, 9, { boost: { multiplier: 3, expires_at: '2026-11-05T05:00:00+00:00' } }));
    setup();
    expect(await screen.findByTestId('ai-boost')).toHaveTextContent('Cupo ampliado ×3 hasta el 4 de noviembre');
  });

  it('sin permiso táctico no ofrece guardar', async () => {
    setup({ canApply: false });
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    await screen.findByText(result.lectura);
    expect(screen.queryByRole('button', { name: /Guardar como nueva jugada/ })).toBeNull();
  });

  it('tras analizar, la barra se actualiza con el saldo que devuelve el BFF', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    expect(await screen.findByText('Te queda el 54 % de tu IA este mes · unos 8 análisis de fútbol 11')).toBeInTheDocument();
  });

  it('agotado (402): «Usaste tu IA de este mes» y «Quiero +50 % de IA» abre el WhatsApp de ventas con el mensaje del BFF', async () => {
    const msg = 'Hola, soy Profe Andrés de Club Demo. Usé el 98 % de mi IA de la pizarra de octubre 2026, 15 análisis. Quiero una recarga de +50 % de IA.';
    api.post.mockRejectedValue(new BFFError(402, 'needs', {
      error: 'Usaste tu IA de este mes.', needs_more: true, limited_by: 'user', balance: balance(2, 0), request_more_message: msg,
    }));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(await screen.findByText('Usaste tu IA de este mes.')).toBeInTheDocument();
    // Recarga en la misma moneda que el medidor (%).
    const more = screen.getByRole('link', { name: 'Quiero +50 % de IA' });
    expect(more).toHaveAttribute('href', `https://wa.me/573202683539?text=${encodeURIComponent(msg)}`);
    expect(more).toHaveAttribute('target', '_blank');
    // El flujo de compra en la app (no construido) ya no aparece.
    expect(screen.queryByText(/Comprar/)).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('/pizarra');
  });

  it('agotado desde que abre (coach): barra en «Usaste tu IA de este mes» y «Quiero más» con mensaje de respaldo sin atletas', async () => {
    api.get.mockResolvedValue(balance(0, 0));
    setup();
    expect(await screen.findByTestId('ai-exhausted')).toBeInTheDocument();
    expect(screen.getByTestId('ai-balance')).toHaveTextContent('Usaste tu IA de este mes');
    const href = screen.getByRole('link', { name: /Quiero \+50 % de IA/ }).getAttribute('href')!;
    expect(href.startsWith('https://wa.me/573202683539?text=')).toBe(true);
    const text = decodeURIComponent(href.split('?text=')[1]);
    expect(text).toContain('fútbol 11');
    expect(text).toContain('el 100 % de mi IA');
    expect(text).toContain('+50 % de IA');
    expect(text).not.toContain('US$');
    expect(text).not.toMatch(/athlete:|child:|1111-4111/);
  });

  it('techo de la escuela: lo dice', async () => {
    api.get.mockResolvedValue(balance(0, 0, { limited_by: 'school' }));
    setup();
    expect(await screen.findByText('Tu escuela usó toda la IA de este mes.')).toBeInTheDocument();
  });

  it('error del modelo: mensaje claro, sin romper el panel', async () => {
    api.post.mockRejectedValue(new BFFError(504, 'x', { error: 'La IA tardó demasiado en responder. No se descontó el análisis; intenta de nuevo.' }));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('tardó demasiado');
    expect(screen.getByRole('button', { name: /Analizar jugada/ })).toBeEnabled();
  });

  it('cancha vacía: no llama al BFF', async () => {
    setup({ getRequest: () => null });
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pon al menos un jugador');
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('ningún pN / rN llega a la pantalla', () => {
  // Texto real de la corrida del 2026-10-14 (futbol-c1.png) + variantes.
  const keys = { p5: K1, p2: K2, p9: 'athlete:99999999-9999-4999-8999-999999999999' };
  const labelOf = (k: string) => ({ [K1]: 'Lateral der.', [K2]: '' } as Record<string, string>)[k];

  it('pN → etiqueta del jugador en la cancha; rN → «rival N»; «(p5)» tras un puesto se quita', () => {
    expect(humanizeText('r4 conduce por el espacio que dejó p5 y busca al delantero que se abre al lado de p3.', keys, labelOf))
      .toBe('rival 4 conduce por el espacio que dejó Lateral der. y busca al delantero que se abre al lado de jugador 3.');
    expect(humanizeText('El volante (p5) filtra el balón', keys, labelOf)).toBe('El volante filtra el balón');
  });
  it('sin etiqueta (o etiqueta vacía) → «jugador N»; sin mapa → igual', () => {
    expect(humanizeText('p2 y p9 quedan lejos', keys, labelOf)).toBe('jugador 2 y jugador 9 quedan lejos');
    expect(humanizeText('p7 sube', undefined, labelOf)).toBe('jugador 7 sube');
    // No toca palabras ni números que no son claves.
    expect(humanizeText('Presión alta en 3p, sp5 y la zona 4', keys, labelOf)).toBe('Presión alta en 3p, sp5 y la zona 4');
  });
  it('humanizeResult cubre lectura, riesgos, contraataques y variantes', () => {
    const r = humanizeResult({
      lectura: 'p5 sube', riesgos: [{ titulo: 'Hueco de p5', detalle: 'r4 corre', zona: 'detrás de p2' }],
      contraataques: [{ ...counter, titulo: 'r4 al espacio de p5', explicacion: 'r1 y r2 salen' }],
      variantes: [{ ...counter, titulo: 'p2 cierra', explicacion: 'p9 cubre' }],
    }, keys, labelOf);
    const all = JSON.stringify({ l: r.lectura, ri: r.riesgos, c: r.contraataques.map((s) => [s.titulo, s.explicacion]), v: r.variantes.map((s) => [s.titulo, s.explicacion]) });
    expect(all).not.toMatch(/\b[pr]\d{1,2}\b/);
    expect(r.riesgos[0]).toEqual({ titulo: 'Hueco de Lateral der.', detalle: 'rival 4 corre', zona: 'detrás de jugador 2' });
    expect(r.contraataques[0].titulo).toBe('rival 4 al espacio de Lateral der.');
    expect(r.variantes[0].explicacion).toBe('jugador 9 cubre');
    // Los cuadros no se tocan (las claves de los cuadros sí se usan).
    expect(r.contraataques[0].frames).toBe(counter.frames);
  });
  it('el panel muestra el texto traducido con la etiqueta que se mandó', async () => {
    api.post.mockResolvedValue({
      result: { ...result, lectura: 'El lateral (p1) sube y r4 ataca la espalda de p1; p2 no llega.' },
      cached: false, balance: balance(11), keys: { p1: K1, p2: K2 },
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    // labelOf del setup devuelve «Central» para todos.
    expect(await screen.findByText('El lateral sube y rival 4 ataca la espalda de Central; Central no llega.')).toBeInTheDocument();
  });
});

describe('tacticalAi (lógica)', () => {
  it('quotaLabel', () => {
    expect(quotaLabel(balance(60) as any, 'futbol')).toBe('Te queda el 60 % de tu IA este mes · unos 9 análisis de fútbol 11');
    expect(quotaLabel(balance(60) as any, 'voleibol')).toBe('Te queda el 60 % de tu IA este mes · unos 12 análisis de voleibol');
    expect(quotaLabel(balance(10, 1) as any, 'futbol')).toBe('Te queda el 10 % de tu IA este mes · un análisis de fútbol 11');
    expect(quotaLabel(balance(60) as any, 'baloncesto')).toBe('Te queda el 60 % de tu IA este mes');
    expect(quotaLabel(balance(0) as any, 'futbol')).toBe('Usaste tu IA de este mes');
    expect(quotaLabel(null, 'futbol')).toBeNull();
  });
  it('requestMoreHref: wa.me del comercial; usa el mensaje del BFF y si no, uno sin atletas', () => {
    expect(requestMoreHref(null, 'futbol', 'hola')).toBe('https://wa.me/573202683539?text=hola');
    expect(fallbackMoreMessage(balance(0) as any, 'futsal')).toBe('Hola, uso la pizarra de SportMaps con futsal y se me acabó la IA del mes. Este mes: 6 análisis, el 100 % de mi IA. Quiero una recarga de +50 % de IA.');
  });
  it('recargas en la moneda del medidor: % → «+50 % de IA»; análisis → «+10 análisis»', () => {
    expect(AI_METER_UNIT).toBe('pct');
    expect(rechargeLabel('pct')).toBe('+50 % de IA');
    expect(rechargeLabel('analyses')).toBe('+10 análisis');
    expect(rechargeOfferOf(null).label).toBe('+50 % de IA');
    // Si el BFF manda la recarga (p. ej. el medidor pasa a análisis), manda la del BFF.
    expect(rechargeOfferOf(balance(0, 0, { recharge: { unit: 'analyses', amount: 10, label: '+10 análisis' } }) as any).label).toBe('+10 análisis');
  });
  it('boostLabel: «Cupo ampliado ×3 hasta el 4 de noviembre» (vencimiento exclusivo, hora Colombia)', () => {
    expect(boostLabel(balance(60) as any)).toBeNull();
    expect(boostLabel(balance(60, 9, { boost: { multiplier: 3, expires_at: '2026-11-05T05:00:00+00:00' } }) as any))
      .toBe('Cupo ampliado ×3 hasta el 4 de noviembre');
    expect(boostLabel(balance(60, 9, { boost: { multiplier: 1.5, expires_at: null } }) as any)).toBe('Cupo ampliado ×1,5');
  });
  it('«Ver en 3D» en cada tarjeta: abre el visor (sin WebGL2 cae a 2D) y registra ver/guardar/analizar', async () => {
    const onEvent = vi.fn();
    const base = { frames: playFrames, players: [], arrows: [], playerLabels: { [K1]: 'Central' }, sport: 'futbol' as const, title: 'Mi jugada' };
    setup({ get3DSource: () => base, onEvent });
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    const ver3d = await screen.findAllByRole('button', { name: /^Ver en 3D: / });
    expect(ver3d).toHaveLength(3); // 2 contraataques + 1 variante
    expect(ver3d[0]).toHaveAccessibleName('Ver en 3D: Salida rápida por la banda derecha');
    fireEvent.click(screen.getAllByRole('button', { name: 'Ver contraataque' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /Guardar como nueva jugada/ })[0]);
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(['ai_analyze', 'ai_view_counter', 'ai_save_variant']);
  });

  it('sin get3DSource las tarjetas no ofrecen 3D', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Analizar jugada/ }));
    await screen.findAllByRole('button', { name: 'Ver contraataque' });
    expect(screen.queryByRole('button', { name: /^Ver en 3D/ })).toBeNull();
  });

  it('suggestionViewer3D: contraataque = jugada del coach + SOLO rivales encima, etiquetas «Rival N»', () => {
    const base = { frames: playFrames, players: [], arrows: [], playerLabels: { [K1]: 'Central' }, sport: 'futbol' as const, title: 'Mi jugada' };
    const src = suggestionViewer3D(base, { ...counter, kind: 'contraataque' });
    expect(src.frames).toBe(playFrames);
    expect(src.overlayName).toBe('Contraataque del rival');
    expect(src.overlayFrames).toHaveLength(3);
    for (const f of src.overlayFrames!) expect(f.players.every((p) => p.key.startsWith('rival:'))).toBe(true);
    expect(src.overlayFrames![1].arrows).toEqual(counter.frames[1].arrows);
    expect(src.overlayLabels).toEqual({ 'rival:1': 'Rival 1', 'rival:2': 'Rival 2' });
    expect(JSON.stringify(src.overlayLabels)).not.toMatch(/\b[pr]\d\b/);
  });

  it('suggestionViewer3D: variante = los propios de la variante + rivales encima', () => {
    const base = { frames: null, players: [], arrows: [], playerLabels: { [K1]: 'Central' }, sport: 'futbol' as const, title: 'Mi jugada' };
    const src = suggestionViewer3D(base, { ...counter, kind: 'variante' });
    expect(src.title).toBe(counter.titulo);
    expect(src.frames!.map((f) => f.players.map((p) => p.key))).toEqual([[K1], [K1], [K1]]);
    expect(src.frames![2].ball).toEqual({ x: 78, y: 70 });
    expect(src.overlayFrames![1].arrows).toEqual([]);
    expect(src.overlayName).toBe('Rivales');
    expect(src.playerLabels).toEqual({ [K1]: 'Central' });
  });

  it('resolveViewerSource: sin tarjeta de IA deja la fuente igual; con tarjeta la resuelve y la suelta', () => {
    const base = { frames: playFrames, players: [], arrows: [], sport: 'futbol' as const };
    expect(resolveViewerSource(base)).toBe(base);
    const out = resolveViewerSource({ ...base, aiSuggestion: { kind: 'contraataque', titulo: counter.titulo, frames: counter.frames } });
    expect(out.aiSuggestion).toBeNull();
    expect(out.overlayFrames).toHaveLength(3);
  });

  it('suggestionToBoardFrames sin balón ni rivales (variante) deja solo propios y flechas', () => {
    const out = suggestionToBoardFrames({ titulo: 'v', explicacion: '', frames: [{ id: 'a', duration_ms: 900, players: [{ key: K1, x: 1, y: 2 }], ball: null, arrows: [] }] });
    expect(out[0]).toMatchObject({ duration_ms: 900, players: [{ key: K1, x: 1, y: 2 }], ball: null, arrows: [] });
  });
});
