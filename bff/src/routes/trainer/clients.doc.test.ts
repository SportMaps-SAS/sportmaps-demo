/**
 * PUT /clients/:clientId — documento del menor/ficha, documento del acudiente
 * y solo-lectura del documento del perfil del adulto (Supabase mockeado).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const state = vi.hoisted(() => ({
  enrolled: true,
  dup: null as { id: string; full_name: string } | null,
  captured: {} as Record<string, any>,
}));

vi.mock('../../config/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const obj: any = {
        select: () => obj,
        eq: () => obj,
        neq: () => obj,
        is: () => obj,
        limit: async () => ({ data: table === 'children' && state.dup ? [state.dup] : [], error: null }),
        maybeSingle: async () => ({ data: state.enrolled ? { id: 'enr-1' } : null }),
        update: (payload: any) => { state.captured = { table, payload }; return obj; },
        single: async () => ({ data: { id: 'c1', ...state.captured.payload }, error: null }),
      };
      return obj;
    },
  },
}));

import router from './clients';

async function put(type: string, body: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.schoolId = 'school-1'; next(); });
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/clients/c1?type=${type}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as any };
  } finally { server.close(); }
}

describe('PUT /clients/:id documentos', () => {
  beforeEach(() => { state.enrolled = true; state.dup = null; state.captured = {}; });

  it('403 si el cliente no está en la escuela', async () => {
    state.enrolled = false;
    expect((await put('child', { doc_type: 'TI', doc_number: '12345678' })).status).toBe(403);
  });
  it('400 con tipo inválido y con número inválido', async () => {
    expect((await put('child', { doc_type: 'XX', doc_number: '12345678' })).status).toBe(400);
    expect((await put('child', { doc_type: 'TI', doc_number: '12 3' })).status).toBe(400);
  });
  it('409 DOC_DUPLICADO y pasa con allow_duplicate', async () => {
    state.dup = { id: 'otro', full_name: 'Otro' };
    const r = await put('unregistered', { doc_type: 'TI', doc_number: '12345678' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('DOC_DUPLICADO');
    const ok = await put('unregistered', { doc_type: 'TI', doc_number: '12345678', allow_duplicate: true });
    expect(ok.status).toBe(200);
    expect(state.captured.payload.doc_number).toBe('12345678');
  });
  it('guarda guardian_doc_* validados', async () => {
    expect((await put('child', { guardian_doc_type: 'RC', guardian_doc_number: '12345678' })).status).toBe(400);
    const ok = await put('child', { guardian_doc_type: 'nit', guardian_doc_number: '900123-4' });
    expect(ok.status).toBe(200);
    expect(state.captured.payload).toMatchObject({ guardian_doc_type: 'NIT', guardian_doc_number: '900123-4' });
  });
  it('adulto: ignora doc_*, no los escribe', async () => {
    const r = await put('adult', { full_name: 'Ana', doc_type: 'CC', doc_number: '99999999', document_number: '1' });
    expect(r.status).toBe(200);
    expect(state.captured.table).toBe('profiles');
    expect(Object.keys(state.captured.payload)).toEqual(['full_name']);
  });
});
