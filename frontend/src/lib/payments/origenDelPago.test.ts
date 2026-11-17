import { describe, it, expect } from 'vitest';
import { origenDelPago } from './origenDelPago';

describe('origenDelPago', () => {
  it('XLS- gana, en mayúsculas o minúsculas, incluso con comprobante', () => {
    expect(origenDelPago({ reference: 'XLS-ABONO-12', status: 'paid' })).toBe('migrado_excel');
    expect(origenDelPago({ reference: 'xls-nov-3', status: 'paid', receipt_url: 'a/b.png' })).toBe('migrado_excel');
    expect(origenDelPago({ reference: '  XLS-NOV-1 ', status: 'paid' })).toBe('migrado_excel');
  });
  it('con comprobante → comprobante', () => {
    expect(origenDelPago({ reference: 'TRF-1', status: 'paid', receipt_url: 'a/b.png' })).toBe('comprobante');
  });
  it('pagado sin comprobante y sin XLS- → manual_sin_comprobante', () => {
    expect(origenDelPago({ reference: 'CASH-1', status: 'paid', payment_method: 'cash' })).toBe('manual_sin_comprobante');
    expect(origenDelPago({ status: 'paid' })).toBe('manual_sin_comprobante');
  });
  it('lo confirmado por pasarela no es «sin comprobante»', () => {
    expect(origenDelPago({ status: 'paid', wompi_transaction_id: 'w-1', payment_channel: 'online' })).toBe('otro');
  });
  it('cobros abiertos y casos vacíos → otro', () => {
    expect(origenDelPago({ status: 'pending' })).toBe('otro');
    expect(origenDelPago({ status: 'awaiting_approval', receipt_url: null })).toBe('otro');
    expect(origenDelPago(null)).toBe('otro');
    expect(origenDelPago({ reference: 'EXLS-1', status: 'pending' })).toBe('otro');
  });
});
