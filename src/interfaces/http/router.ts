export type RouteName = 'evaluate' | 'getDecision' | 'consume' | 'release' | 'live' | 'ready';

export interface ResolvedRoute {
  readonly name: RouteName;
  readonly method: 'GET' | 'POST';
  /** Identificador do caminho, já com o formato mínimo verificado pelo roteador. */
  readonly param: string | null;
  /**
   * Isenção explícita de autenticação: somente as rotas de saúde, que não leem corpo nem expõem dados de risco.
   * Toda outra rota exige `REQUIRED`.
   */
  readonly auth: 'REQUIRED' | 'NONE';
}

const SEGMENT = '([A-Za-z0-9_.~-]{1,128})';
const TABLE: readonly {
  readonly name: RouteName;
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly label: string;
  readonly auth: 'REQUIRED' | 'NONE';
}[] = [
  { name: 'live', method: 'GET', pattern: /^\/health\/live$/, label: 'GET /health/live', auth: 'NONE' },
  { name: 'ready', method: 'GET', pattern: /^\/health\/ready$/, label: 'GET /health/ready', auth: 'NONE' },
  { name: 'evaluate', method: 'POST', pattern: /^\/v1\/risk\/evaluations$/, label: 'POST /v1/risk/evaluations', auth: 'REQUIRED' },
  { name: 'getDecision', method: 'GET', pattern: new RegExp(`^/v1/risk/decisions/${SEGMENT}$`), label: 'GET /v1/risk/decisions/:id', auth: 'REQUIRED' },
  { name: 'consume', method: 'POST', pattern: new RegExp(`^/v1/risk/authorizations/${SEGMENT}/consume$`), label: 'POST /v1/risk/authorizations/:id/consume', auth: 'REQUIRED' },
  { name: 'release', method: 'POST', pattern: new RegExp(`^/v1/risk/reservations/${SEGMENT}/release$`), label: 'POST /v1/risk/reservations/:id/release', auth: 'REQUIRED' },
];

export type RouteMatch =
  | { readonly kind: 'FOUND'; readonly route: ResolvedRoute; readonly label: string }
  | { readonly kind: 'METHOD_NOT_ALLOWED'; readonly allow: string }
  | { readonly kind: 'NOT_FOUND' };

/** Resolve só pelo caminho (query ignorada). `label` é o padrão da rota, seguro para log (sem ids). */
export function resolveRoute(method: string, rawUrl: string): RouteMatch {
  const path = rawUrl.split('?', 1)[0] ?? '';
  for (const entry of TABLE) {
    const m = entry.pattern.exec(path);
    if (!m) continue;
    if (entry.method !== method) return { kind: 'METHOD_NOT_ALLOWED', allow: entry.method };
    return { kind: 'FOUND', route: { name: entry.name, method: entry.method, param: m[1] ?? null, auth: entry.auth }, label: entry.label };
  }
  return { kind: 'NOT_FOUND' };
}
