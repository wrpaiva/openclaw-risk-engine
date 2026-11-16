import type { IncomingMessage } from 'node:http';

export type BodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'TOO_LARGE' | 'INVALID_JSON' | 'ABORTED' };

/** Lê o corpo até `maxBytes`; ao exceder, para de acumular imediatamente. */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return Promise.resolve({ ok: false, reason: /^\d+$/.test(declared) ? 'TOO_LARGE' : 'INVALID_JSON' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        finish({ ok: false, reason: 'TOO_LARGE' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) finish({ ok: false, reason: 'INVALID_JSON' });
        else finish({ ok: true, value: parsed as Record<string, unknown> });
      } catch {
        finish({ ok: false, reason: 'INVALID_JSON' });
      }
    });
    req.on('error', () => {
      finish({ ok: false, reason: 'ABORTED' });
    });
    req.on('close', () => {
      finish({ ok: false, reason: 'ABORTED' });
    });
  });
}
