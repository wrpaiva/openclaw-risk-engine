import type { PoolClient } from 'pg';
import type { Logger } from '../../application/ports/Logger.js';

export interface ClientGuard {
  /** true se o cliente emitiu 'error' enquanto em uso (conexão perdida): deve ser destruído, nunca devolvido ao pool. */
  readonly broken: () => boolean;
  /** Remove o listener; chamar imediatamente antes de `release`. */
  readonly dispose: () => void;
}

/**
 * pg-pool só escuta 'error' com o cliente ocioso; em uso, um 'error' sem listener vira uncaughtException.
 * Este guard absorve o evento (log só com errorKind, nunca a mensagem do pg) e marca o cliente como quebrado;
 * a operação em curso falha normalmente pela própria query rejeitada (fail-closed).
 */
export function guardClient(client: PoolClient, logger?: Logger): ClientGuard {
  let isBroken = false;
  const onError = (error: Error): void => {
    isBroken = true;
    try {
      logger?.error('db.client_error', { errorKind: error.name });
    } catch {
      // log nunca derruba o processo
    }
  };
  client.on('error', onError);
  return {
    broken: () => isBroken,
    dispose: () => {
      client.removeListener('error', onError);
      // Evento tardio entre dispose e destruição do socket: mantém um no-op para não derrubar o processo.
      if (isBroken) client.on('error', () => undefined);
    },
  };
}
