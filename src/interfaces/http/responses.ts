import type { ServerResponse } from 'node:http';
import type { RiskViolationV1 } from '../../domain/RiskViolation.js';

const MAX_OBSERVED = 64;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/** Corpo de erro fixo: nunca ecoa headers, token, corpo da requisição nem mensagem de exceção. */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  requestId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error: { code, requestId, ...extra } }, headers);
}

/** Valores observados vêm de entrada não confiável: truncados antes de voltar ao cliente. */
export function sanitizeViolations(violations: readonly RiskViolationV1[]): readonly RiskViolationV1[] {
  return violations.map((v) => ({
    ...v,
    ...(v.observed !== undefined && v.observed.length > MAX_OBSERVED ? { observed: `${v.observed.slice(0, MAX_OBSERVED)}...` } : {}),
  }));
}
