import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { ClientLease } from './clientLease.js';

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Chave fixa do advisory lock que serializa migradores concorrentes.
const MIGRATION_LOCK_KEY = 7_340_011_001;

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

/** Migrações empacotadas (versão = nome do arquivo, checksum = SHA-256 do conteúdo), em ordem. Só leitura de arquivos. */
export async function readBundledMigrations(directory: string): Promise<readonly AppliedMigration[]> {
  const files = (await readdir(directory)).filter((f) => FILE.test(f)).sort();
  const result: AppliedMigration[] = [];
  for (const file of files) {
    const sql = await readFile(join(directory, file), 'utf8');
    result.push({ version: file, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') });
  }
  return result;
}

export interface MigrateTimeouts {
  /** RISK_DB_CONNECTION_TIMEOUT_MS, RISK_DB_STATEMENT_TIMEOUT_MS e RISK_DB_LOCK_TIMEOUT_MS (variáveis já existentes). */
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

// Máximo de setTimeout do Node (acima disso o timer dispara na hora): só para o caminho legado, sem prazos.
const NO_DEADLINE_MS = 2_147_483_647;

/**
 * Aplica migrações SQL versionadas, cada uma em sua transação. Uma migração já aplicada
 * cujo conteúdo mudou interrompe o processo: migrações são imutáveis depois de aplicadas.
 *
 * Com `timeouts` (sempre na CLI), nada fica sem prazo: espera de conexão, cada comando (client-side,
 * conexão + statement) e, no servidor, `statement_timeout` e `lock_timeout` de SESSÃO. O `pg_advisory_lock` de
 * sessão obedece a `lock_timeout` (um migrador concorrente travado vira falha, não espera infinita).
 * Pendência de decisão do usuário: uma DDL legítima mais longa que RISK_DB_STATEMENT_TIMEOUT_MS falha e dá
 * rollback; um prazo próprio para migrações NÃO foi inventado (ver docs/operacao/deploy.md).
 * Sem `timeouts` (apenas testes de integração) o comportamento é o legado, sem prazos.
 */
export async function migrate(pool: Pool, directory: string, timeouts?: MigrateTimeouts): Promise<readonly AppliedMigration[]> {
  const files = (await readdir(directory)).filter((f) => FILE.test(f)).sort();
  const lease = await ClientLease.acquire(
    pool,
    timeouts === undefined
      ? { connectMs: NO_DEADLINE_MS, queryMs: NO_DEADLINE_MS }
      : { connectMs: timeouts.connectionTimeoutMs, queryMs: timeouts.connectionTimeoutMs + timeouts.statementTimeoutMs },
  );
  let locked = false;
  try {
    if (timeouts !== undefined) {
      await lease.query("SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)", [
        String(timeouts.statementTimeoutMs),
        String(timeouts.lockTimeoutMs),
      ]);
    }
    await lease.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;
    await lease.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await lease.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const newlyApplied: AppliedMigration[] = [];
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`migração ${file} foi alterada depois de aplicada`);
        continue;
      }
      await lease.query('BEGIN');
      try {
        await lease.query(sql);
        await lease.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await lease.query('COMMIT');
      } catch (error) {
        await lease.query('ROLLBACK').catch(() => {
          lease.markBroken();
        });
        throw error;
      }
      newlyApplied.push({ version: file, checksum });
    }
    return newlyApplied;
  } catch (error) {
    // Prazo estourado ou conexão perdida: destruir (o servidor encerra a sessão e libera o advisory lock).
    if (lease.isLost()) lease.markBroken();
    throw error;
  } finally {
    if (locked && !lease.isBroken()) {
      await lease.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
        lease.markBroken();
      });
    }
    lease.finish();
  }
}
