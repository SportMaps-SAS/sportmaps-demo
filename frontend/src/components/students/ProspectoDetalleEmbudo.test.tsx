/**
 * Deportistas → Clase de prueba: la línea de detalle del embudo del bot
 * (respuestas, sede, grupo, profe, cupo separado, pago en revisión). Un
 * prospecto de siempre se ve exactamente igual.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const st = vi.hoisted(() => ({ prospectos: [] as unknown[] }));
vi.mock('@/hooks/useClasePrueba', () => ({
  useConfigClasePrueba: () => ({ config: { enabled: true, presencial_enabled: true, es_admin: true } }),
  useProspectosClasePrueba: () => ({
    prospectos: st.prospectos, isLoading: false, error: null,
    registrar: { mutate: vi.fn(), isPending: false }, cerrar: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { ClasePruebaPanel } from './ClasePruebaPanel';
import { ProspectoDetalleEmbudo } from './ProspectoDetalleEmbudo';
import { detalleEmbudo } from './prospectoEmbudoModel';
import type { ProspectoClasePrueba } from '@/hooks/useClasePrueba';
import { anioDe, estadoDePago, lineaPerfil, sexoTexto, textoRespuestas } from '@/lib/clasePruebaTextos';

const base: ProspectoClasePrueba = {
  id: 'l1', full_name: 'Mariana Gómez Rojas', guardian_name: 'Ana Rojas', phone: '3191234512', email: null, gender: 'female',
  birth_date: '2011-03-14', notes: null, status: 'new', created_at: '2026-10-29T10:00:00Z', canal: 'whatsapp', asistencia: null,
  fecha_clase: '2026-10-31', cupo_label: 'Infantil Femenino', cupo_hora: '08:00:00',
};
const embudo: ProspectoClasePrueba = {
  ...base,
  sede: 'Sede Norte', grupo: 'Infantil Femenino', profe: 'Iván',
  respuestas: { posicion: 'Punta', trayectoria: 'Club y torneos', trayectoria_detalle: 'Club Titanes, Distrital 2025, Festival Nacional sub-15' },
  estado_cupo: 'agendada', pago: { monto: 15000, estado: 'paid' },
};

describe('textos del prospecto', () => {
  it('año, sexo y respuestas con su detalle', () => {
    expect(anioDe('2011-03-14')).toBe(2011);
    expect(anioDe(2009)).toBe(2009);
    expect(anioDe('sin fecha')).toBeNull();
    expect(sexoTexto('F')).toBe('Mujer');
    expect(sexoTexto('male')).toBe('Hombre');
    expect(sexoTexto('otro')).toBeNull();
    expect(textoRespuestas(embudo.respuestas)).toEqual(['Punta', 'Club y torneos (Club Titanes, Distrital 2025, Festival Nacional sub-15)']);
    // Las claves reservadas no se repiten como respuesta; un detalle suelto va al final.
    expect(textoRespuestas({ nombre: 'X', sexo: 'F', posicion: 'Central', detalle: 'zurda' })).toEqual(['Central (zurda)']);
    expect(textoRespuestas({ opciones: ['Punta', 'Líbero'], club: { etiqueta: 'Club', detalle: 'Titanes' } })).toEqual(['Punta, Líbero', 'Club (Titanes)']);
    expect(textoRespuestas(null)).toEqual([]);
    expect(lineaPerfil({ nacimiento: '2011-03-14', sexo: 'F', respuestas: { posicion: 'Punta' } })).toBe('2011 · Mujer · Punta');
  });

  it('estado del pago: pagado / en revisión', () => {
    expect(estadoDePago({ estado: 'paid' })).toBe('pagado');
    expect(estadoDePago({ status: 'awaiting_approval' })).toBe('en_revision');
    expect(estadoDePago('pending')).toBeNull();
    expect(estadoDePago(null)).toBeNull();
  });
});

describe('detalleEmbudo', () => {
  it('un prospecto de siempre (sin embudo) no dibuja nada', () => {
    expect(detalleEmbudo(base)).toBeNull();
    const { container } = render(<ProspectoDetalleEmbudo prospecto={base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('agendada y pagada: perfil, sede · grupo · profe y «Pagó $15.000»', () => {
    expect(detalleEmbudo(embudo)).toEqual({
      perfil: '2011 · Mujer · Punta · Club y torneos (Club Titanes, Distrital 2025, Festival Nacional sub-15)',
      agenda: 'Sede Norte · Infantil Femenino · Profe Iván',
      estado: { texto: 'Pagó $15.000', tono: 'ok' },
    });
  });

  it('comprobante que llegó por WhatsApp sin revisar: «Pago en revisión»', () => {
    expect(detalleEmbudo({ ...embudo, pago: { monto: 15000, estado: 'awaiting_approval' } })?.estado).toEqual({ texto: 'Pago en revisión', tono: 'pendiente' });
  });

  it('cupo separado sin comprobante, con hasta cuándo', () => {
    const d = detalleEmbudo({ ...embudo, pago: null, estado_cupo: 'separado', separado_hasta: '2026-11-01T15:00:00' });
    expect(d?.estado?.texto).toMatch(/^Cupo separado · sin comprobante · hasta .*1 nov.*3:00 p\. m\.$/);
    expect(d?.estado?.tono).toBe('pendiente');
  });

  it('el profe que ya viene con «Profe» no se repite; varios profes van en plural', () => {
    expect(detalleEmbudo({ ...embudo, profe: 'Profe Sebastián' })?.agenda).toBe('Sede Norte · Infantil Femenino · Profe Sebastián');
    expect(detalleEmbudo({ ...embudo, profe: 'Iván Pérez, Laura Gómez' })?.agenda).toBe('Sede Norte · Infantil Femenino · Profes Iván Pérez, Laura Gómez');
  });

  it('el cupo separado muestra su franja (la agendada ya sale en la etiqueta «Clase …»)', () => {
    const d = detalleEmbudo({ ...embudo, pago: null, estado_cupo: 'separado', fecha_clase: null, separado_fecha: '2026-11-04', separado_hora: '16:00:00' });
    expect(d?.agenda).toMatch(/^Sede Norte · Infantil Femenino · Profe Iván · .*4 nov, 4:00 p\. m\.$/);
    expect(detalleEmbudo(embudo)?.agenda).toBe('Sede Norte · Infantil Femenino · Profe Iván');
  });
});

describe('ClasePruebaPanel con el detalle', () => {
  it('la fila del prospecto del embudo muestra el detalle; la de siempre no', () => {
    st.prospectos = [embudo, { ...base, id: 'l2', full_name: 'Samuel Ortiz' }];
    render(<ClasePruebaPanel schoolId="s1" onCompletar={vi.fn()} onConfigurar={vi.fn()} />);
    expect(screen.getAllByTestId('prospecto-embudo')).toHaveLength(1);
    expect(screen.getByText('Sede Norte · Infantil Femenino · Profe Iván')).toBeInTheDocument();
    expect(screen.getByText('Pagó $15.000')).toBeInTheDocument();
    expect(screen.getByText('Samuel Ortiz')).toBeInTheDocument();
  });
});
