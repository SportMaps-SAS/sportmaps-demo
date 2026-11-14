import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditClientModal, GUARDIAN_DOC_REGEX } from './EditClientModal';

const toast = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 't' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const res = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body }) as any;

function setup(type: 'adult' | 'child' | 'unregistered', initialData: any = {}) {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  render(
    <EditClientModal open onClose={onClose} onSuccess={onSuccess} clientId="c1" clientType={type}
      initialData={{ full_name: 'Ana', ...initialData }} />,
  );
  return { onSuccess, onClose };
}

describe('EditClientModal', () => {
  beforeEach(() => { toast.mockReset(); vi.restoreAllMocks(); });

  it('regex del documento del acudiente', () => {
    expect(GUARDIAN_DOC_REGEX.test('1020304050')).toBe(true);
    expect(GUARDIAN_DOC_REGEX.test('abc')).toBe(false);
    expect(GUARDIAN_DOC_REGEX.test('12 34 56')).toBe(false);
  });

  it('child: envía guardian_doc_*', async () => {
    const f = vi.fn().mockResolvedValue(res(200, {}));
    vi.stubGlobal('fetch', f);
    const { onSuccess } = setup('child', { guardian_doc_type: 'CE', guardian_doc_number: 'AB-1234' });
    fireEvent.click(screen.getByText('Guardar Cambios'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.guardian_doc_type).toBe('CE');
    expect(body.guardian_doc_number).toBe('AB-1234');
  });

  it('número inválido bloquea el envío', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    setup('unregistered', { guardian_doc_number: '12' });
    fireEvent.click(screen.getByText('Guardar Cambios'));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(f).not.toHaveBeenCalled();
  });

  it('teléfono incompleto bloquea el envío', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    setup('unregistered', { phone: '+57300' });
    fireEvent.click(screen.getByText('Guardar Cambios'));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(f).not.toHaveBeenCalled();
  });

  it('adult: documento solo lectura y sin guardian_doc_*', async () => {
    const f = vi.fn().mockResolvedValue(res(200, {}));
    vi.stubGlobal('fetch', f);
    const { onSuccess } = setup('adult', { profile_doc_type: 'CC', profile_doc_number: '999888' });
    expect(screen.getByDisplayValue('CC 999888')).toBeDisabled();
    expect(screen.getByText(/Vinculado a su cuenta/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Guardar Cambios'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).not.toHaveProperty('guardian_doc_number');
  });

  it('409 DOC_DUPLICADO: confirma y reintenta con allow_duplicate', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(409, { code: 'DOC_DUPLICADO', error: 'Documento repetido' }))
      .mockResolvedValueOnce(res(200, {}));
    vi.stubGlobal('fetch', f);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onSuccess } = setup('child', { guardian_doc_number: '1020304050' });
    fireEvent.click(screen.getByText('Guardar Cambios'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[0][1].body)).not.toHaveProperty('allow_duplicate');
    expect(JSON.parse(f.mock.calls[1][1].body).allow_duplicate).toBe(true);
  });

  it('409 DOC_DUPLICADO: si cancela no reintenta', async () => {
    const f = vi.fn().mockResolvedValue(res(409, { code: 'DOC_DUPLICADO', error: 'Documento repetido' }));
    vi.stubGlobal('fetch', f);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onSuccess } = setup('child', { guardian_doc_number: '1020304050' });
    fireEvent.click(screen.getByText('Guardar Cambios'));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(f).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
