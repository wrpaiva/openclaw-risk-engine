import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { count, createIsolatedDatabase, seedAccount, seedPolicy, type IsolatedDatabase } from '../integration/support/database.js';
import { AGENT, executorPrincipal, harness, uniqueProposal } from '../integration/support/harness.js';

// B4: release x varredura de expiração sobre reservas vencidas: nunca dupla liberação.
let db: IsolatedDatabase;
beforeEach(async () => {
  db = await createIsolatedDatabase(12);
  await seedAccount(db.pool);
  await seedPolicy(db.pool);
});
afterEach(async () => db.drop());

describe('release x ExpireRiskReservations (reserva vencida)', () => {
  it.each([1, 2, 3])('rodada %i: 6 reservas vencidas, release e varredura em paralelo → cada uma EXPIRED uma única vez', async () => {
    const h = harness(db.pool);
    const reservations: string[] = [];
    let expiresAt = '';
    for (let i = 0; i < 6; i++) {
      const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
      reservations.push(r.decision.reservationId ?? '');
      expiresAt = r.decision.authorizationExpiresAt ?? '';
    }
    h.clock.set(expiresAt); // now == expiresAt: todas vencidas

    const results = await Promise.all([
      ...reservations.flatMap((id) => [
        h.release.execute({ principal: executorPrincipal(), reservationId: id, reason: 'cancelado' }),
        h.release.execute({ principal: executorPrincipal(), reservationId: id, reason: 'de novo' }),
      ]),
      h.expire.execute(),
      h.expire.execute(),
    ]);

    // Todo release (de quem quer que feche a reserva) responde CONFLICT EXPIRED; nunca RELEASED.
    const releases = results.slice(0, reservations.length * 2) as { kind: string; status?: string }[];
    for (const r of releases) expect(r).toEqual({ kind: 'CONFLICT', status: 'EXPIRED' });
    // As varreduras somam, no máximo, uma expiração por reserva (o resto foi fechado pelo release).
    const swept = (results.slice(-2) as number[]).reduce((a, b) => a + b, 0);
    expect(swept).toBeLessThanOrEqual(reservations.length);

    expect(await count(db.pool, 'risk_reservations', `status = 'EXPIRED'`)).toBe(reservations.length);
    expect(await count(db.pool, 'risk_reservations', `status IN ('ACTIVE','RELEASED','CONSUMED')`)).toBe(0);
    // Exatamente um evento de expiração por reserva (sem dupla liberação) e nenhum RELEASED.
    for (const id of reservations) {
      expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_EXPIRED' AND reservation_id = $1`, [id])).toBe(1);
    }
    expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_RELEASED'`)).toBe(0);
    const { rows } = await db.pool.query<{ active: string }>(`SELECT COALESCE(SUM(exposure_base),0)::text AS active FROM risk_reservations WHERE status = 'ACTIVE'`);
    expect(rows[0]?.active).toBe('0');
    // Limpa para a próxima rodada (banco é recriado por teste via beforeEach/afterEach).
  });

  it('release e varredura corridos uma contra a outra, 10 vezes na mesma reserva fresca', async () => {
    for (let i = 0; i < 10; i++) {
      const h = harness(db.pool);
      const r = await h.evaluate.execute({ proposal: uniqueProposal(), authenticatedAgentId: AGENT });
      if (r.kind !== 'DECISION' || r.decision.status !== 'ALLOW_PAPER') throw new Error('esperava ALLOW_PAPER');
      const id = r.decision.reservationId ?? '';
      h.clock.set(r.decision.authorizationExpiresAt ?? '');
      const [rel, sweep] = await Promise.all([h.release.execute({ principal: executorPrincipal(), reservationId: id, reason: 'x' }), h.expire.execute()]);
      expect(rel).toEqual({ kind: 'CONFLICT', status: 'EXPIRED' });
      expect(sweep).toBeLessThanOrEqual(1);
      expect(await count(db.pool, 'risk_audit_events', `event_type = 'RESERVATION_EXPIRED' AND reservation_id = $1`, [id])).toBe(1);
    }
  });
});
