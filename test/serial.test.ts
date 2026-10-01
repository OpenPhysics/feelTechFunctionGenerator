import { describe, expect, it, vi } from 'vitest';
import { Fy3200sTransport } from '../src/device/serial.ts';

describe('serial command queue', () => {
  it('reports a failed write and closes the connection', async () => {
    const errors: string[] = [];
    const statuses: string[] = [];
    const close = vi.fn(async () => {});
    const transport = new Fy3200sTransport({
      onError: (message) => errors.push(message),
      onStatus: (status) => statuses.push(status),
    });
    Object.assign(transport, {
      status: 'connected',
      writer: {
        write: vi.fn(async () => { throw new Error('write failed'); }),
        releaseLock: vi.fn(),
      },
      port: { close },
    });

    transport.enqueueAll(['bf100000', 'bw0']);

    await vi.waitFor(() => expect(statuses).toContain('disconnected'));
    expect(errors).toEqual(['write failed']);
    expect(transport.pendingCount).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });
});
