import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// T7 — rastreabilidade (SPEC §9.1 e §2.2; critério "100% dos cenários obrigatórios cobertos"). Falha se algum UT-001..UT-020 ou
// I-01..I-08 não aparecer como TAG em ao menos um arquivo de teste. A tag é o identificador literal (ex.: "UT-005", "I-03")
// em título de describe/it ou em cabeçalho de arquivo. Este arquivo gera os identificadores por código (não os cita literalmente)
// e não conta para a cobertura. Não prova que a asserção é suficiente: só que o cenário tem dono declarado.
const TESTS = join(import.meta.dirname, '..');
const SELF = 'unit/traceability.test.ts';

const pad = (n: number): string => String(n).padStart(2, '0');
const UT = Array.from({ length: 20 }, (_v, i) => `UT-0${pad(i + 1)}`);
const INVARIANTS = Array.from({ length: 8 }, (_v, i) => `I-${pad(i + 1)}`);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(e.name) && relative(TESTS, path) !== SELF ? [path] : [];
  });
}

const files = testFiles(TESTS);
const texts = new Map(files.map((f) => [relative(TESTS, f), readFileSync(f, 'utf8')]));

function filesWithTag(tag: string): string[] {
  const pattern = new RegExp(`(?<![A-Za-z0-9-])${tag}(?![0-9])`);
  return [...texts].filter(([, text]) => pattern.test(text)).map(([name]) => name);
}

describe('rastreabilidade de testes (SPEC §9.1, §2.2)', () => {
  it('há arquivos de teste para varrer', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('todos os cenários UT-001..UT-020 têm ao menos um teste com a tag', () => {
    const missing = UT.filter((tag) => filesWithTag(tag).length === 0);
    expect(missing).toEqual([]);
  });

  it('todas as invariantes I-01..I-08 têm ao menos um teste com a tag', () => {
    const missing = INVARIANTS.filter((tag) => filesWithTag(tag).length === 0);
    expect(missing).toEqual([]);
  });

  it.each([...UT, ...INVARIANTS])('%s tem dono declarado (arquivo de teste com a tag)', (tag) => {
    expect(filesWithTag(tag), `nenhum teste referencia ${tag}`).not.toEqual([]);
  });

  it('tags inexistentes (UT-021+, I-09+) não são usadas: evita rastreabilidade para cenário que não existe', () => {
    const stray: string[] = [];
    for (const [name, text] of texts) {
      for (const m of text.matchAll(/(?<![A-Za-z0-9-])(UT-0(2[1-9]|[3-9][0-9])|I-(09|[1-9][0-9]))(?![0-9])/g)) stray.push(`${name}:${m[0]}`);
    }
    expect(stray).toEqual([]);
  });
});
