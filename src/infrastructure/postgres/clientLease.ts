import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Logger } from '../../application/ports/Logger.js';
import { guardClient, type ClientGuard } from './guardClient.js';

/**
 * Prazos do lado do cliente. `statement_timeout`/`lock_timeout` são server-side: com o banco congelado
 * (processo parado, rede cortada) o servidor nunca responde e nada os dispara. Estes prazos garantem que
 * a aplicação devolve erro em tempo finito (=> UNAVAILABLE/503 ou FAIL), nunca autoriza e nunca pendura.
 *
 *   connectMs = RISK_DB_CONNECTION_TIMEOUT_MS
 *   queryMs   = RISK_DB_CONNECTION_TIMEOUT_MS + RISK_DB_STATEMENT_TIMEOUT_MS
 *
 * `queryMs` é por comando (`query_timeout` do node-pg): o tempo máximo que o servidor tem para estourar o
 * `statement_timeout` (a margem de uma conexão cobre a ida e volta). Nenhum valor numérico novo: só a soma de
 * dois timeouts obrigatórios na configuração.
 */
export interface DbDeadlines {
  readonly connectMs: number;
  readonly queryMs: number;
}

export class DbDeadlineError extends Error {
  override readonly name = 'DbDeadlineError';
}

/**
 * `connectionTimeoutMs` explícito (config); senão o do próprio pool; senão (pool sem limite) o statement timeout,
 * para que nunca exista espera infinita.
 */
export function deriveDeadlines(pool: Pool, statementTimeoutMs: number, connectionTimeoutMs?: number): DbDeadlines {
  const fromPool = (pool as { options?: { connectionTimeoutMillis?: number } }).options?.connectionTimeoutMillis;
  const connectMs = connectionTimeoutMs ?? (typeof fromPool === 'number' && fromPool > 0 ? fromPool : statementTimeoutMs);
  return { connectMs, queryMs: connectMs + statementTimeoutMs };
}

/**
 * Executa um comando com prazo do lado do cliente. Ao estourar, rejeita com DbDeadlineError; o comando segue
 * pendente no servidor, então o chamador deve tratar a conexão como incerta e destruí-la (`release(true)`).
 * (Prazo próprio em vez do `query_timeout` do node-pg: não depende de configuração do pool nem de internos do driver.)
 */
export function queryWithDeadline<R extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] | undefined,
  queryMs: number | undefined,
): Promise<QueryResult<R>> {
  const pending = values === undefined ? client.query<R>(text) : client.query<R>(text, [...values]);
  if (queryMs === undefined) return pending;
  return new Promise<QueryResult<R>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DbDeadlineError('prazo do comando excedido'));
    }, queryMs);
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('falha de comando'));
      },
    );
  });
}

/** Erro de prazo do cliente (DbDeadlineError): a conexão está em estado incerto. */
export function isClientDeadline(error: unknown): boolean {
  return error instanceof DbDeadlineError;
}

/**
 * Cliente emprestado do pool com: espera de conexão limitada, `query_timeout` em todo comando e `release`
 * idempotente. Um cliente que estourou prazo ou falhou é destruído (`release(true)`), nunca devolvido.
 */
export class ClientLease {
  private finished = false;
  private broken = false;
  private deadlineHit = false;

  private constructor(
    readonly client: PoolClient,
    private readonly guard: ClientGuard,
    private readonly queryMs: number,
  ) {}

  static async acquire(pool: Pool, deadlines: DbDeadlines, logger?: Logger): Promise<ClientLease> {
    const client = await new Promise<PoolClient>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new DbDeadlineError('prazo de conexão excedido'));
      }, deadlines.connectMs);
      pool.connect().then(
        (c) => {
          clearTimeout(timer);
          if (settled) {
            // Conexão chegou depois do prazo: ninguém a usará.
            c.release(true);
            return;
          }
          settled = true;
          resolve(c);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(error instanceof Error ? error : new Error('falha de conexão'));
          }
        },
      );
    });
    return new ClientLease(client, guardClient(client, logger), deadlines.queryMs);
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>> {
    return queryWithDeadline<R>(this.client, text, values, this.queryMs).catch((error: unknown) => {
      if (isClientDeadline(error)) this.markDeadline();
      throw error;
    });
  }

  /** Marca a conexão como incerta: `finish()` a destrói. */
  markBroken(): void {
    this.broken = true;
  }

  /** Prazo do cliente estourado em comando executado fora da lease (ex.: PgRiskUnitOfWork): conexão incerta e falha de banco. */
  markDeadline(): void {
    this.broken = true;
    this.deadlineHit = true;
  }

  /** Conexão perdida em uso (evento 'error') ou prazo do comando estourado: falha de infraestrutura do banco. */
  isLost(): boolean {
    return this.deadlineHit || this.guard.broken();
  }

  isBroken(): boolean {
    return this.broken || this.guard.broken();
  }

  /** Destrói agora (ex.: prazo total estourado com comando em curso). Idempotente. */
  destroy(): void {
    this.broken = true;
    this.finish();
  }

  /** Devolve ao pool (ou destrói, se incerto). Idempotente. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const destroy = this.isBroken();
    this.guard.dispose();
    // Evento 'error' tardio de um socket destruído não pode virar uncaughtException.
    if (destroy) this.client.on('error', () => undefined);
    this.client.release(destroy);
  }
}

/** Corre `work` contra um prazo total; ao estourar, `onExpire` (destruir o cliente) e rejeita com DbDeadlineError. */
export function raceDeadline<T>(work: Promise<T>, ms: number, onExpire: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onExpire();
      reject(new DbDeadlineError('prazo total excedido'));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('falha'));
      },
    );
  });
}
