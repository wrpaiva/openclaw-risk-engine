import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { CheckReadiness } from '../../application/CheckReadiness.js';
import type { ConsumePaperAuthorization } from '../../application/ConsumePaperAuthorization.js';
import type { EvaluateTradeRisk } from '../../application/EvaluateTradeRisk.js';
import type { GetRiskDecision } from '../../application/GetRiskDecision.js';
import type { ReleaseRiskReservation } from '../../application/ReleaseRiskReservation.js';
import type { IdGenerator } from '../../application/ports/IdGenerator.js';
import type { Logger, LogFields } from '../../application/ports/Logger.js';
import type { PrincipalAuthenticator } from '../../application/ports/PrincipalAuthenticator.js';
import type { AuthenticatedPrincipal } from '../../application/ports/AuthenticatedAgentContext.js';
import { isOpaqueId } from '../../domain/schemaSupport.js';
import { readJsonBody } from './readJsonBody.js';
import { sanitizeViolations, sendError, sendJson } from './responses.js';
import { resolveRoute, type ResolvedRoute } from './router.js';

export interface RiskHttpServerDeps {
  readonly authenticator: PrincipalAuthenticator;
  readonly evaluate: Pick<EvaluateTradeRisk, 'execute'>;
  readonly consume: Pick<ConsumePaperAuthorization, 'execute'>;
  readonly release: Pick<ReleaseRiskReservation, 'execute'>;
  readonly getDecision: Pick<GetRiskDecision, 'execute'>;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  /** /health/ready; ausente = nunca pronto (fail-closed). */
  readonly readiness?: Pick<CheckReadiness, 'execute'>;
  /** Verdadeiro durante o desligamento ordenado; ausente = não está drenando. */
  readonly isDraining?: () => boolean;
  readonly limits: { readonly maxBodyBytes: number; readonly requestTimeoutMs: number; readonly headersTimeoutMs: number };
}

const consumeBody = z
  .object({
    accountId: z.string().refine(isOpaqueId),
    paperOrderId: z.string().refine(isOpaqueId),
    proposalHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
// Motivo curto de texto livre; o caso de uso ainda o trunca em 64.
const releaseBody = z.object({ reason: z.string().min(1).max(256) }).strict();

const HEALTH_LIVE = 'GET /health/live';
const HEALTH_READY = 'GET /health/ready';
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/;

interface RequestState {
  readonly requestId: string;
  readonly started: number;
  fields: LogFields;
}

/** Devolve o servidor sem chamar `listen`. */
export function createRiskHttpServer(deps: RiskHttpServerDeps): Server {
  const server = createServer((req, res) => {
    void handle(deps, req, res);
  });
  server.requestTimeout = deps.limits.requestTimeoutMs;
  server.headersTimeout = deps.limits.headersTimeoutMs;
  return server;
}

async function handle(deps: RiskHttpServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const state: RequestState = { requestId: deps.ids.uuid(), started: Date.now(), fields: {} };
  let route = 'UNMATCHED';
  try {
    route = await dispatch(deps, req, res, state, (label) => {
      route = label;
    });
  } catch (error) {
    const errorKind = error instanceof Error ? error.name : 'NonError';
    state.fields = { ...state.fields, errorKind };
    deps.logger.error('http.internal_error', { requestId: state.requestId, route, errorKind });
    sendError(res, 500, 'INTERNAL_ERROR', state.requestId);
  }
  // Rota sem resposta (kind inesperado): nunca deixa a requisição pendurada nem loga 200.
  if (!res.headersSent && !res.destroyed) {
    deps.logger.error('http.internal_error', { requestId: state.requestId, route, errorKind: 'NoResponse' });
    sendError(res, 500, 'INTERNAL_ERROR', state.requestId);
  }
  const httpStatus = res.statusCode;
  // Sondas de saúde com 200 não geram log (ruído); qualquer outro status é registrado.
  if (httpStatus === 200 && (route === HEALTH_LIVE || route === HEALTH_READY)) return;
  const fields = {
    ...state.fields,
    requestId: state.requestId,
    route,
    httpStatus,
    durationMs: Date.now() - state.started,
  };
  if (httpStatus >= 500) deps.logger.error('http.request', fields);
  else if (httpStatus === 401 || httpStatus === 403) deps.logger.warn('http.request', fields);
  else deps.logger.info('http.request', fields);
}

async function dispatch(
  deps: RiskHttpServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  state: RequestState,
  setRoute: (label: string) => void,
): Promise<string> {
  const { requestId } = state;
  const match = resolveRoute(req.method ?? '', req.url ?? '');
  // Métodos com corpo (POST/PUT/PATCH/DELETE) em 404/405: o corpo não será lido; fecha e destrói o socket
  // (como `early` em 401/403) em vez de deixar o Node drenar um upload arbitrário.
  const mayHaveBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes((req.method ?? '').toUpperCase());
  const closeAfter = (): void => {
    res.once('finish', () => {
      req.socket.destroy();
    });
  };
  if (match.kind === 'NOT_FOUND') {
    sendError(res, 404, 'NOT_FOUND', requestId, {}, mayHaveBody ? { Connection: 'close' } : {});
    if (mayHaveBody) closeAfter();
    return 'UNMATCHED';
  }
  if (match.kind === 'METHOD_NOT_ALLOWED') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', requestId, {}, mayHaveBody ? { Allow: match.allow, Connection: 'close' } : { Allow: match.allow });
    if (mayHaveBody) closeAfter();
    return 'UNMATCHED';
  }
  setRoute(match.label);

  // Isenção explícita de autenticação (router): sem corpo lido, sem principal, sem dados de risco.
  if (match.route.auth === 'NONE') {
    await health(deps, match.route.name, res);
    return match.label;
  }

  // Erro antes de ler o corpo de um POST: fecha a conexão em vez de deixar o Node drenar o upload.
  const early = (status: number, code: string, headers: Record<string, string> = {}): void => {
    if (match.route.method === 'POST') {
      sendError(res, status, code, requestId, {}, { ...headers, Connection: 'close' });
      res.once('finish', () => {
        req.socket.destroy();
      });
    } else sendError(res, status, code, requestId, {}, headers);
  };

  // Autenticação antes de qualquer leitura de corpo.
  const principal = authenticate(deps.authenticator, req);
  if (principal === null) {
    early(401, 'UNAUTHENTICATED', { 'WWW-Authenticate': 'Bearer' });
    return match.label;
  }
  state.fields = { principalId: principal.principalId };

  const required = match.route.name === 'evaluate' ? 'AGENT' : match.route.name === 'getDecision' ? null : 'PAPER_EXECUTOR';
  if (required !== null && principal.kind !== required) {
    deps.logger.warn('http.forbidden', { requestId, principalId: principal.principalId, route: match.label, outcome: 'WRONG_ROLE' });
    early(403, 'FORBIDDEN');
    return match.label;
  }

  let body: Record<string, unknown> | null = null;
  if (match.route.method === 'POST') {
    const type = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      early(400, 'INVALID_CONTENT_TYPE');
      return match.label;
    }
    const read = await readJsonBody(req, deps.limits.maxBodyBytes);
    if (!read.ok) {
      if (read.reason === 'TOO_LARGE') {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', requestId, {}, { Connection: 'close' });
        res.once('finish', () => {
          req.socket.destroy();
        });
      } else if (read.reason === 'INVALID_JSON') {
        sendError(res, 400, 'INVALID_JSON', requestId);
      } else {
        // Cliente abortou: nada a responder.
        res.statusCode = 499;
        res.destroy();
      }
      return match.label;
    }
    body = read.value;
  }

  await route(deps, match.route, principal, body, res, state);
  return match.label;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Corpo fixo: sem versão, hostname, mensagens de erro ou nomes de objetos. */
async function health(deps: RiskHttpServerDeps, name: string, res: ServerResponse): Promise<void> {
  if (name === 'live') {
    sendJson(res, 200, { status: 'live' }, NO_STORE);
    return;
  }
  const draining = isDraining(deps);
  let ready = false;
  let checks: { database: 'FAIL' | 'OK'; schema: 'FAIL' | 'OK'; privileges: 'FAIL' | 'OK'; reconciliation: 'FAIL' | 'OK' } = {
    database: 'FAIL',
    schema: 'FAIL',
    privileges: 'FAIL',
    reconciliation: 'FAIL',
  };
  try {
    if (deps.readiness !== undefined) {
      const result = await deps.readiness.execute();
      checks = {
        database: result.checks.database,
        schema: result.checks.schema,
        privileges: result.checks.privileges,
        reconciliation: result.checks.reconciliation,
      };
      ready = result.ready && !draining && checks.database === 'OK' && checks.schema === 'OK' && checks.privileges === 'OK' && checks.reconciliation === 'OK';
    }
  } catch {
    ready = false;
  }
  const lower = (v: 'OK' | 'FAIL'): 'ok' | 'fail' => (v === 'OK' ? 'ok' : 'fail');
  sendJson(
    res,
    ready ? 200 : 503,
    {
      status: ready ? 'ready' : 'not_ready',
      checks: { database: lower(checks.database), schema: lower(checks.schema), privileges: lower(checks.privileges), reconciliation: lower(checks.reconciliation), draining: draining ? 'fail' : 'ok' },
    },
    NO_STORE,
  );
}

function isDraining(deps: RiskHttpServerDeps): boolean {
  try {
    return deps.isDraining?.() ?? false;
  } catch {
    return true;
  }
}

function authenticate(authenticator: PrincipalAuthenticator, req: IncomingMessage): AuthenticatedPrincipal | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = BEARER.exec(header);
  if (!m?.[1]) return null;
  try {
    return authenticator.authenticate(m[1]);
  } catch {
    return null;
  }
}

async function route(
  deps: RiskHttpServerDeps,
  r: ResolvedRoute,
  principal: AuthenticatedPrincipal,
  body: Record<string, unknown> | null,
  res: ServerResponse,
  state: RequestState,
): Promise<void> {
  const { requestId } = state;
  const param = r.param ?? '';
  switch (r.name) {
    case 'evaluate': {
      const result = await deps.evaluate.execute({ proposal: body, authenticatedAgentId: principal.principalId });
      switch (result.kind) {
        case 'DECISION':
          state.fields = {
            ...state.fields,
            correlationId: result.decision.correlationId,
            proposalId: result.decision.proposalId,
            decisionId: result.decision.decisionId,
            outcome: result.decision.status,
            violationCodes: result.decision.violations.map((v) => v.code),
          };
          sendJson(res, 200, result.decision, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
          return;
        case 'REJECTED':
          // Só os códigos de violação no log (nunca payload, mensagens ou valores observados).
          state.fields = { ...state.fields, violationCodes: result.violations.map((v) => v.code) };
          if (result.reason === 'UNAUTHENTICATED') sendError(res, 401, 'UNAUTHENTICATED', requestId, {}, { 'WWW-Authenticate': 'Bearer' });
          else if (result.reason === 'FORBIDDEN') sendError(res, 403, 'FORBIDDEN', requestId);
          else sendError(res, 422, 'INVALID_CONTRACT', requestId, { violations: sanitizeViolations(result.violations) });
          return;
        case 'IDEMPOTENCY_CONFLICT':
          sendError(res, 409, 'IDEMPOTENCY_CONFLICT', requestId);
          return;
        case 'UNAVAILABLE':
          sendError(res, 503, 'UNAVAILABLE', requestId);
          return;
        default:
          return assertNever(result);
      }
    }
    case 'getDecision': {
      const result = await deps.getDecision.execute({ decisionId: param, principal });
      switch (result.kind) {
        case 'FOUND':
          state.fields = { ...state.fields, decisionId: result.decision.decisionId, proposalId: result.decision.proposalId, correlationId: result.decision.correlationId };
          sendJson(res, 200, result.decision);
          return;
        case 'NOT_FOUND':
          sendError(res, 404, 'NOT_FOUND', requestId);
          return;
        case 'UNAVAILABLE':
          sendError(res, 503, 'UNAVAILABLE', requestId);
          return;
        default:
          return assertNever(result);
      }
    }
    case 'consume': {
      const parsed = consumeBody.safeParse(body);
      if (!parsed.success) {
        sendError(res, 422, 'INVALID_CONTRACT', requestId, { fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))] });
        return;
      }
      const result = await deps.consume.execute({ principal, decisionId: param, ...parsed.data });
      switch (result.kind) {
        case 'CONSUMED':
          state.fields = { ...state.fields, decisionId: param, reservationId: result.reservationId, accountId: parsed.data.accountId, outcome: 'CONSUMED' };
          sendJson(res, 200, { status: 'CONSUMED', reservationId: result.reservationId, replayed: result.replayed });
          return;
        case 'FORBIDDEN':
          sendError(res, 403, 'FORBIDDEN', requestId);
          return;
        case 'NOT_FOUND':
          sendError(res, 404, 'NOT_FOUND', requestId);
          return;
        case 'NOT_AUTHORIZED':
          sendError(res, 409, 'NOT_AUTHORIZED', requestId, { reason: result.reason });
          return;
        case 'CONFLICT':
          sendError(res, 409, 'CONFLICT', requestId);
          return;
        case 'UNAVAILABLE':
          sendError(res, 503, 'UNAVAILABLE', requestId);
          return;
        default:
          return assertNever(result);
      }
    }
    case 'release': {
      const parsed = releaseBody.safeParse(body);
      if (!parsed.success) {
        sendError(res, 422, 'INVALID_CONTRACT', requestId, { fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))] });
        return;
      }
      const result = await deps.release.execute({ principal, reservationId: param, reason: parsed.data.reason });
      switch (result.kind) {
        case 'RELEASED':
          state.fields = { ...state.fields, reservationId: param, outcome: 'RELEASED' };
          sendJson(res, 200, { status: 'RELEASED', replayed: result.replayed });
          return;
        case 'FORBIDDEN':
          sendError(res, 403, 'FORBIDDEN', requestId);
          return;
        case 'NOT_FOUND':
          sendError(res, 404, 'NOT_FOUND', requestId);
          return;
        case 'CONFLICT':
          sendError(res, 409, 'CONFLICT', requestId, { status: result.status });
          return;
        case 'UNAVAILABLE':
          sendError(res, 503, 'UNAVAILABLE', requestId);
          return;
        default:
          return assertNever(result);
      }
    }
    case 'live':
    case 'ready':
      // Rotas de saúde são atendidas antes da autenticação e nunca chegam aqui.
      throw new Error('rota de saúde fora do fluxo de saúde');
    default:
      return assertNever(r.name);
  }
}

function assertNever(value: never): never {
  // Só o tipo do valor inesperado; nunca o conteúdo.
  throw new Error(`variante inesperada: ${typeof value}`);
}
