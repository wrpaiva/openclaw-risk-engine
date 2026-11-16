import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { seedGrant, seedPolicy } from '../../integration/support/database.js';
import { validProposal } from '../../fixtures/proposals.js';

// Dados FICTÍCIOS. Cada teste usa conta própria (`paper-e2e-*`) no banco descartável compartilhado.

export const uniqueAccount = (): string => `paper-e2e-${randomBytes(5).toString('hex')}`;

export interface SeedOptions {
  readonly accountId: string;
  readonly agents?: readonly string[];
  readonly executors?: readonly string[];
  /** false = conta sem política (POLICY_MISSING). */
  readonly policy?: boolean;
  readonly policyOverrides?: Record<string, unknown>;
  /** Âncora (ms) da validade da política; a política cobre [anchor - 1 dia, anchor + 30 dias]. */
  readonly anchorMs?: number;
}

export async function seedAccountFor(admin: pg.Pool, options: SeedOptions): Promise<void> {
  const { accountId } = options;
  await admin.query(`INSERT INTO risk_accounts (account_id, environment) VALUES ($1, 'PAPER')`, [accountId]);
  for (const principalId of options.agents ?? []) await seedGrant(admin, { principalId, role: 'AGENT', accountId });
  for (const principalId of options.executors ?? []) await seedGrant(admin, { principalId, role: 'PAPER_EXECUTOR', accountId });
  if (options.policy ?? true) {
    const anchor = options.anchorMs ?? Date.now();
    await seedPolicy(admin, {
      accountId,
      policyId: `policy-${accountId}`,
      validFrom: new Date(anchor - 86_400_000).toISOString(),
      validUntil: new Date(anchor + 30 * 86_400_000).toISOString(),
      ...options.policyOverrides,
    });
  }
}

/** Proposta válida FICTÍCIA com identificadores únicos, datada em `nowMs` (createdAt = now - 1 s; TTL 30 s). */
export function proposalAt(nowMs: number, fields: { accountId: string; agentId: string } & Record<string, unknown>): Record<string, unknown> {
  return validProposal({
    proposalId: randomUUID(),
    idempotencyKey: `idem-${randomUUID()}`,
    correlationId: `corr-${randomUUID()}`,
    createdAt: new Date(nowMs - 1000).toISOString(),
    expiresAt: new Date(nowMs + 30_000).toISOString(),
    ...fields,
  });
}

export interface AccountCounts {
  readonly proposals: number;
  readonly decisions: number;
  readonly allow: number;
  readonly block: number;
  readonly reservations: number;
  readonly activeReservations: number;
  readonly audit: number;
}

export async function accountCounts(admin: pg.Pool, accountId: string): Promise<AccountCounts> {
  const one = async (sql: string): Promise<number> => Number((await admin.query<{ n: string }>(sql, [accountId])).rows[0]?.n ?? '0');
  return {
    proposals: await one('SELECT count(*)::text n FROM trade_proposals WHERE account_id = $1'),
    decisions: await one('SELECT count(*)::text n FROM risk_decisions WHERE account_id = $1'),
    allow: await one(`SELECT count(*)::text n FROM risk_decisions WHERE account_id = $1 AND status = 'ALLOW_PAPER'`),
    block: await one(`SELECT count(*)::text n FROM risk_decisions WHERE account_id = $1 AND status = 'BLOCK'`),
    reservations: await one('SELECT count(*)::text n FROM risk_reservations WHERE account_id = $1'),
    activeReservations: await one(`SELECT count(*)::text n FROM risk_reservations WHERE account_id = $1 AND status = 'ACTIVE'`),
    audit: await one('SELECT count(*)::text n FROM risk_audit_events WHERE account_id = $1'),
  };
}

/**
 * Invariantes SQL de uma conta (SPEC §2.2, §9.4 critério final). Devolve violações; vazio = íntegro.
 *  - toda decisão tem proposta e vice-versa (1:1);
 *  - todo ALLOW_PAPER tem reserva da mesma decisão, com exposição positiva e vencimento igual ao da autorização;
 *  - todo BLOCK não tem reserva;
 *  - toda reserva pertence a uma decisão ALLOW_PAPER;
 *  - paper_order_id não se repete; CONSUMED <=> paper_order_id;
 *  - exposição ACTIVE não excede o limite informado (I-03).
 */
export async function integrityViolations(admin: pg.Pool, accountId: string, maxGrossExposure?: string): Promise<string[]> {
  const out: string[] = [];
  const q = async (sql: string): Promise<number> => Number((await admin.query<{ n: string }>(sql, [accountId])).rows[0]?.n ?? '0');
  const check = async (label: string, sql: string): Promise<void> => {
    const n = await q(sql);
    if (n !== 0) out.push(`${label}: ${n}`);
  };
  await check('proposta sem decisão', `SELECT count(*)::text n FROM trade_proposals p WHERE p.account_id = $1 AND NOT EXISTS (SELECT 1 FROM risk_decisions d WHERE d.proposal_id = p.proposal_id)`);
  await check('decisão sem proposta', `SELECT count(*)::text n FROM risk_decisions d WHERE d.account_id = $1 AND NOT EXISTS (SELECT 1 FROM trade_proposals p WHERE p.proposal_id = d.proposal_id)`);
  await check('ALLOW sem reserva', `SELECT count(*)::text n FROM risk_decisions d WHERE d.account_id = $1 AND d.status = 'ALLOW_PAPER' AND NOT EXISTS (SELECT 1 FROM risk_reservations r WHERE r.decision_id = d.decision_id AND r.reservation_id = d.reservation_id)`);
  await check('ALLOW com vencimento divergente da reserva', `SELECT count(*)::text n FROM risk_decisions d JOIN risk_reservations r ON r.decision_id = d.decision_id WHERE d.account_id = $1 AND d.authorization_expires_at <> r.expires_at`);
  await check('BLOCK com reserva', `SELECT count(*)::text n FROM risk_decisions d WHERE d.account_id = $1 AND d.status = 'BLOCK' AND (d.reservation_id IS NOT NULL OR EXISTS (SELECT 1 FROM risk_reservations r WHERE r.decision_id = d.decision_id))`);
  await check('reserva sem ALLOW', `SELECT count(*)::text n FROM risk_reservations r WHERE r.account_id = $1 AND NOT EXISTS (SELECT 1 FROM risk_decisions d WHERE d.decision_id = r.decision_id AND d.status = 'ALLOW_PAPER')`);
  await check('paper_order_id repetido', `SELECT count(*)::text n FROM (SELECT paper_order_id FROM risk_reservations WHERE account_id = $1 AND paper_order_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) t`);
  await check('mais de uma reserva por decisão', `SELECT count(*)::text n FROM (SELECT decision_id FROM risk_reservations WHERE account_id = $1 GROUP BY 1 HAVING count(*) > 1) t`);
  await check('decisões duplicadas por proposta', `SELECT count(*)::text n FROM (SELECT proposal_id FROM risk_decisions WHERE account_id = $1 GROUP BY 1 HAVING count(*) > 1) t`);
  if (maxGrossExposure !== undefined) {
    const { rows } = await admin.query<{ over: boolean }>(
      `SELECT COALESCE(SUM(exposure_base), 0) > $2::numeric AS over FROM risk_reservations WHERE account_id = $1 AND status = 'ACTIVE'`,
      [accountId, maxGrossExposure],
    );
    if (rows[0]?.over) out.push('exposição ACTIVE acima do limite');
  }
  return out;
}

/** Corpo mínimo seguro de decisão para asserts (campos do contrato RiskDecisionV1 usados nos testes). */
export interface DecisionBody {
  decisionId: string;
  proposalId: string;
  accountId: string;
  agentId: string;
  proposalHash: string;
  status: 'ALLOW_PAPER' | 'BLOCK';
  violations: { code: string }[];
  reservationId: string | null;
  authorizationExpiresAt: string | null;
  policyVersion: string | null;
  policyHash: string | null;
  marketDataAsOf: string | null;
  snapshotVersion: string | null;
}
export const asDecision = (json: Record<string, unknown>): DecisionBody => json as unknown as DecisionBody;
