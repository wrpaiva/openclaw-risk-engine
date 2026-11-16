import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Verificação estática de deploy/stack.example.yml (exemplo documental, NÃO aplicado). Nada aqui é limite aprovado.
const ROOT = join(import.meta.dirname, '../../..');
const text = readFileSync(join(ROOT, 'deploy/stack.example.yml'), 'utf8');
const lines = text.split('\n');
const active = lines.filter((l) => !l.trim().startsWith('#')).join('\n');

const indentOf = (l: string): number => /^\s*/.exec(l)?.[0].length ?? 0;

function block(header: RegExp, source: string): string {
  const all = source.split('\n');
  const start = all.findIndex((l) => header.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const indent = indentOf(all[start] ?? '');
  const out = [all[start] ?? ''];
  for (const l of all.slice(start + 1)) {
    if (l.trim() !== '' && indentOf(l) <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}

describe('deploy/stack.example.yml', () => {
  it('traz o banner NÃO APLICADO no cabeçalho', () => {
    expect(lines.slice(0, 10).join('\n')).toContain('NÃO APLICADO');
  });

  it('nenhuma publicação de porta (sem chave ports: ativa)', () => {
    expect(active).not.toMatch(/^\s*ports:/m);
  });

  it('risk-engine anexa risk_transactional; risk-engine-migrate não', () => {
    const engine = block(/^ {2}risk-engine:\s*$/, active);
    const migrate = block(/^ {2}risk-engine-migrate:\s*$/, active);
    expect(engine).toMatch(/^\s*networks:\s*\n\s*- risk_transactional\s*$/m);
    expect(migrate).not.toContain('risk_transactional');
    expect(migrate).not.toMatch(/^\s*networks:/m);
  });

  it('rede risk_transactional é external e o comentário de criação exige cifrada e interna, sem attachable', () => {
    const net = block(/^ {2}risk_transactional:\s*$/, active);
    expect(net).toMatch(/^\s*external:\s*true\s*$/m);
    const create = lines.filter((l) => l.includes('docker network create')).join('\n');
    expect(create).toContain('--opt encrypted');
    expect(create).toContain('--internal');
    expect(create).not.toContain('--attachable');
  });

  it('nenhum valor numérico inventado em healthcheck/deploy/stop_grace_period/restart (só comentados "a definir")', () => {
    expect(active).not.toMatch(/^\s*(healthcheck|deploy|stop_grace_period|restart_policy|update_config|rollback_config|replicas|interval|timeout|retries|start_period):/m);
    const commented = lines.filter((l) => /^\s*#\s*(interval|timeout|retries|start_period|stop_grace_period):/.test(l));
    for (const l of commented) expect(l).toContain('a definir');
  });

  it('sem credenciais de exchange/corretora e sem RISK_MIGRATION_* no serviço da app', () => {
    expect(active).not.toMatch(/API_KEY|API_SECRET|BROKER|EXCHANGE/i);
    const engine = block(/^ {2}risk-engine:\s*$/, active);
    expect(engine).not.toContain('RISK_MIGRATION_');
  });
});
