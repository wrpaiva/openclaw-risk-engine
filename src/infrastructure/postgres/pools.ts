import { Pool } from 'pg';

/**
 * `search_path` fixo na conexão (opção de startup do protocolo): o runtime só resolve nomes não qualificados em `public`
 * (pg_catalog é sempre pesquisado antes). Impede que um schema criado por outra role, ou o schema de mesmo nome
 * do usuário (`"$user"`), sombreie tabelas ou funções de `public`. Complementa a checagem do PgPrivilegeInspector.
 */
const SEARCH_PATH_OPTION = '-c search_path=public';

export interface PoolSettings {
  readonly connectionString: string;
  readonly connectionTimeoutMs: number;
  /** Omitido = default do driver. */
  readonly max?: number;
}

export function createPool(settings: PoolSettings): Pool {
  const pool = new Pool({
    connectionString: settings.connectionString,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    ...(settings.max === undefined ? {} : { max: settings.max }),
    options: SEARCH_PATH_OPTION,
  });
  pool.on('error', () => undefined);
  return pool;
}
