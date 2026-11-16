import { describe, expect, it } from 'vitest';
import { CheckReadiness } from '../../../src/application/CheckReadiness.js';
import type { CheckStatus, ReadinessProbe, ReadinessReport } from '../../../src/application/ports/ReadinessProbe.js';

// Probes FICTÍCIOS: nada de banco real aqui.
const report = (database: CheckStatus, schema: CheckStatus, privileges: CheckStatus, reconciliation: CheckStatus = 'OK'): ReadinessReport => ({ database, schema, privileges, reconciliation });
const probeOf = (r: ReadinessReport): ReadinessProbe => ({ check: () => Promise.resolve(r) });
const make = (probe: ReadinessProbe, draining: () => boolean = () => false) => new CheckReadiness({ probe, isDraining: draining });
const ALL_FAIL = report('FAIL', 'FAIL', 'FAIL', 'FAIL');

describe('CheckReadiness', () => {
  it('todos OK e sem drenagem: pronto', async () => {
    const r = await make(probeOf(report('OK', 'OK', 'OK'))).execute();
    expect(r).toEqual({ ready: true, checks: report('OK', 'OK', 'OK') });
  });

  it.each([
    ['database', report('FAIL', 'OK', 'OK')],
    ['schema', report('OK', 'FAIL', 'OK')],
    ['privileges', report('OK', 'OK', 'FAIL')],
    ['reconciliation', report('OK', 'OK', 'OK', 'FAIL')],
    ['todos', ALL_FAIL],
  ])('FAIL em %s: não pronto e o relatório é preservado', async (_n, rep) => {
    const r = await make(probeOf(rep)).execute();
    expect(r.ready).toBe(false);
    expect(r.checks).toEqual(rep);
  });

  it('drenando: não pronto, mesmo com tudo OK', async () => {
    const r = await make(probeOf(report('OK', 'OK', 'OK')), () => true).execute();
    expect(r.ready).toBe(false);
    expect(r.checks).toEqual(report('OK', 'OK', 'OK'));
  });

  it('a drenagem é consultada a cada execução (muda em tempo de execução)', async () => {
    let draining = false;
    const uc = make(probeOf(report('OK', 'OK', 'OK')), () => draining);
    expect((await uc.execute()).ready).toBe(true);
    draining = true;
    expect((await uc.execute()).ready).toBe(false);
    draining = false;
    expect((await uc.execute()).ready).toBe(true);
  });

  it('probe que lança de forma síncrona: não pronto, todos FAIL, sem lançar', async () => {
    const probe: ReadinessProbe = {
      check: () => {
        throw new Error('senha=segredo-fixture');
      },
    };
    const r = await make(probe).execute();
    expect(r).toEqual({ ready: false, checks: ALL_FAIL });
    expect(JSON.stringify(r)).not.toContain('segredo-fixture');
  });

  it('probe que rejeita: não pronto, todos FAIL, sem lançar', async () => {
    const probe: ReadinessProbe = { check: () => Promise.reject(new Error('conexão recusada')) };
    await expect(make(probe).execute()).resolves.toEqual({ ready: false, checks: ALL_FAIL });
  });

  it('probe que rejeita com valor não-Error: não pronto', async () => {
    const probe: ReadinessProbe = { // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- valor não-Error é o ponto do teste
      check: () => Promise.reject('texto') };
    await expect(make(probe).execute()).resolves.toEqual({ ready: false, checks: ALL_FAIL });
  });

  it('função de drenagem que lança: fail-closed, não pronto, sem lançar', async () => {
    const r = await make(probeOf(report('OK', 'OK', 'OK')), () => {
      throw new Error('boom');
    }).execute();
    expect(r.ready).toBe(false);
  });

  it('probe que devolve valor fora do contrato (status desconhecido): não pronto', async () => {
    const rep = { database: 'OK', schema: 'OK', privileges: 'MAYBE' } as unknown as ReadinessReport;
    expect((await make(probeOf(rep)).execute()).ready).toBe(false);
  });

  it('probe que devolve relatório incompleto: não pronto', async () => {
    const rep = { database: 'OK', schema: 'OK' } as unknown as ReadinessReport;
    expect((await make(probeOf(rep)).execute()).ready).toBe(false);
  });
});

describe('CheckReadiness: single-flight (sem cache)', () => {
  const OK = report('OK', 'OK', 'OK');
  /** Probe controlável: cada check() fica pendente até `resolveNext`. */
  function gatedProbe() {
    const pending: ((r: ReadinessReport) => void)[] = [];
    const rejects: ((e: unknown) => void)[] = [];
    let calls = 0;
    const probe: ReadinessProbe = {
      check: () => {
        calls += 1;
        return new Promise<ReadinessReport>((resolve, reject) => {
          pending.push(resolve);
          rejects.push(reject);
        });
      },
    };
    return { probe, calls: () => calls, resolveNext: (r: ReadinessReport) => {
        rejects.shift();
        pending.shift()?.(r);
      },
      rejectNext: (e: unknown) => {
        pending.shift();
        rejects.shift()?.(e);
      },
    };
  }

  it('N chamadas concorrentes → um único probe.check(), e todas recebem o mesmo resultado', async () => {
    const g = gatedProbe();
    const uc = make(g.probe);
    const all = Array.from({ length: 25 }, () => uc.execute());
    await Promise.resolve();
    expect(g.calls()).toBe(1);
    g.resolveNext(OK);
    const results = await Promise.all(all);
    expect(results.every((r) => r.ready && r.checks === results[0]?.checks)).toBe(true);
    expect(g.calls()).toBe(1);
  });

  it('chamada DEPOIS da conclusão faz um novo check() (nenhum cache/TTL): o resultado antigo não é reaproveitado', async () => {
    const g = gatedProbe();
    const uc = make(g.probe);
    const first = uc.execute();
    g.resolveNext(OK);
    expect((await first).ready).toBe(true);
    const second = uc.execute();
    await Promise.resolve();
    expect(g.calls()).toBe(2);
    g.resolveNext(report('FAIL', 'OK', 'OK'));
    expect((await second).ready).toBe(false); // refletiu o estado novo, não o OK anterior
    const third = uc.execute();
    await Promise.resolve();
    expect(g.calls()).toBe(3);
    g.resolveNext(OK);
    expect((await third).ready).toBe(true);
  });

  it('chamadas que chegam durante o voo compartilham o resultado; as posteriores ao fim começam outro voo', async () => {
    const g = gatedProbe();
    const uc = make(g.probe);
    const a = uc.execute();
    const b = uc.execute();
    await Promise.resolve();
    g.resolveNext(OK);
    await Promise.all([a, b]);
    const c = uc.execute();
    const d = uc.execute();
    await Promise.resolve();
    expect(g.calls()).toBe(2);
    g.resolveNext(OK);
    await Promise.all([c, d]);
  });

  it('draining é avaliado por chamada: chamadas que compartilham o voo veem o draining de cada uma, no instante em que concluem', async () => {
    const g = gatedProbe();
    let draining = false;
    const uc = make(g.probe, () => draining);
    const before = uc.execute();
    const during = uc.execute();
    await Promise.resolve();
    expect(g.calls()).toBe(1);
    draining = true; // liga o draining com o voo ainda em andamento
    g.resolveNext(OK);
    const [a, b] = await Promise.all([before, during]);
    expect([a.ready, b.ready]).toEqual([false, false]);
    expect(a.checks).toEqual(OK); // o relatório do probe é preservado
    draining = false;
    const next = uc.execute();
    await Promise.resolve();
    g.resolveNext(OK);
    expect((await next).ready).toBe(true);
  });

  it('probe que lança no voo compartilhado: todas as chamadas recebem ALL_FAIL e a seguinte tenta de novo', async () => {
    const g = gatedProbe();
    const uc = make(g.probe);
    const all = [uc.execute(), uc.execute(), uc.execute()];
    await Promise.resolve();
    g.rejectNext(new Error('senha=segredo-fixture'));
    const results = await Promise.all(all);
    for (const r of results) expect(r).toEqual({ ready: false, checks: ALL_FAIL });
    expect(JSON.stringify(results)).not.toContain('segredo-fixture');
    expect(g.calls()).toBe(1);
    const retry = uc.execute();
    await Promise.resolve();
    expect(g.calls()).toBe(2);
    g.resolveNext(OK);
    expect((await retry).ready).toBe(true);
  });

  it('probe síncrono que lança também libera o voo (nenhuma promessa presa)', async () => {
    let calls = 0;
    const probe: ReadinessProbe = {
      check: () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    const uc = make(probe);
    expect((await Promise.all([uc.execute(), uc.execute()])).every((r) => !r.ready)).toBe(true);
    await uc.execute();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('rajadas sequenciais de 10 concorrentes: um check por rajada', async () => {
    let calls = 0;
    const probe: ReadinessProbe = {
      check: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return OK;
      },
    };
    const uc = make(probe);
    for (let burst = 1; burst <= 3; burst++) {
      await Promise.all(Array.from({ length: 10 }, () => uc.execute()));
      expect(calls).toBe(burst);
    }
  });
});
