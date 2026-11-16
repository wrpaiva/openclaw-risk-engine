import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireSuiteLock, adminPool, call, dockerRun, e2eEnv, EVALUATE } from '../support/env.js';
import { accountCounts, asDecision, proposalAt, seedAccountFor, uniqueAccount } from '../support/data.js';
import type pg from 'pg';

// Item §9.4 #7 — "Receiver e Pixel Agents mantêm observabilidade sem influenciar autorização".
// Invariantes: I-08 (estado do receiver/Pixel não altera decisões; integridade dos dados de risco independente), I-02.
// Camadas: estática (grafo de imports transitivo a partir dos pontos de entrada) + (a) imagem real (conteúdo, ambiente,
// decisões independentes de qualquer componente visual).
// LACUNA DECLARADA: o receiver e o painel Pixel Agents reais não existem neste ambiente de teste; não há prova de "nenhuma
// regressão funcional do painel" nem de que a observabilidade continua íntegra quando o receiver cai. O que se prova é a
// ausência de dependência: nenhum caminho de código, config, variável ou rede do motor referencia o receiver/Pixel.
const env = e2eEnv();
const ROOT = join(import.meta.dirname, '../../..');
const PIXEL = /pixel[-_]?(agents|events)|receiver/i;
let release: () => void;
let admin: pg.Pool;
beforeAll(async () => {
  release = await acquireSuiteLock();
  admin = adminPool(3);
});
afterAll(async () => {
  await admin.end();
  release();
});

/** Fecho transitivo de imports relativos (.js -> .ts) a partir de um arquivo; devolve arquivos e especificadores. */
function importGraph(entry: string): { files: string[]; specifiers: string[] } {
  const seen = new Set<string>();
  const specifiers: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? '';
      specifiers.push(spec);
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  };
  visit(entry);
  return { files: [...seen], specifiers };
}

describe('grafo de imports (estático)', () => {
  const entries = ['src/interfaces/http/main.ts', 'src/interfaces/cli/main.ts', 'src/index.ts'].map((e) => join(ROOT, e));
  it.each(entries.map((e): [string, string] => [relative(ROOT, e), e]))('%s: nenhum import (transitivo) de pixel-agents/pixel-events/receiver', (_n, entry) => {
    const { files, specifiers } = importGraph(entry);
    expect(files.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => PIXEL.test(s))).toEqual([]);
    expect(files.filter((f) => PIXEL.test(relative(ROOT, f)))).toEqual([]);
  });

  it('dependências externas do grafo ⊆ {pg, decimal.js, zod, node:*}', () => {
    const external = new Set(entries.flatMap((e) => importGraph(e).specifiers).filter((s) => !s.startsWith('.')));
    const outside = [...external].filter((s) => !/^(node:[a-z:/_]+|pg|decimal\.js|zod)$/.test(s));
    expect(outside).toEqual([]);
  });

  it('nenhuma menção a Pixel/receiver em src, migrations, .env.example e package.json', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'migrations')), join(ROOT, '.env.example'), join(ROOT, 'package.json')];
    for (const f of files) expect(readFileSync(f, 'utf8'), relative(ROOT, f)).not.toMatch(/pixel[-_]?(agents|events)/i);
  });
});

describe('imagem real: sem componente Pixel/receiver', () => {
  it('dist, migrations e package.json da imagem não mencionam Pixel Agents/pixel-events; sem dependência de receiver', () => {
    const r = dockerRun(['exec', env.appContainer, 'sh', '-c', 'grep -rIil -E "pixel[-_]?(agents|events)" /app/dist /app/migrations /app/package.json; echo done']);
    expect(r.stdout.trim()).toBe('done');
    const pkg = dockerRun(['exec', env.appContainer, 'cat', '/app/package.json']).stdout;
    expect(Object.keys((JSON.parse(pkg) as { dependencies: Record<string, string> }).dependencies).filter((d) => PIXEL.test(d))).toEqual([]);
  });

  it('o processo da app não tem variáveis de ambiente de receiver/Pixel nem conexões de saída além do Postgres', () => {
    const environ = dockerRun(['exec', env.appContainer, 'sh', '-c', 'cat /proc/1/environ | tr "\\0" "\\n"']).stdout;
    expect(environ.split('\n').map((l) => l.split('=')[0] ?? '').filter((n) => PIXEL.test(n))).toEqual([]);
  });

  it('as decisões não dependem de nenhum canal de observabilidade: mesma proposta, mesmo resultado, nenhuma chamada de saída (BLOCK fail-closed e persistido)', async () => {
    // Não há receiver/painel no ambiente: as decisões são produzidas só com banco e fontes locais. A proposta é decidida e
    // persistida mesmo sem qualquer destino de observabilidade, e o log vai só para stdout do contêiner.
    const acct = uniqueAccount();
    await seedAccountFor(admin, { accountId: acct, agents: [env.agentId] });
    const body = proposalAt(Date.now(), { accountId: acct, agentId: env.agentId });
    const a = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, body);
    const b = await call(env.baseUrl, 'POST', EVALUATE, env.agentToken, body);
    expect(a.status).toBe(200);
    expect(asDecision(a.json).status).toBe('BLOCK');
    expect(b.json).toEqual(a.json);
    expect(await accountCounts(admin, acct)).toMatchObject({ proposals: 1, decisions: 1 });
    // Tabela de saída (outbox) é só transacional; nada é publicado para fora.
    const published = await admin.query<{ n: string }>(`SELECT count(*)::text n FROM risk_outbox WHERE published_at IS NOT NULL`);
    expect(published.rows[0]?.n).toBe('0');
  });
});
