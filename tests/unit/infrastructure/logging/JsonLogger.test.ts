import { describe, expect, it } from 'vitest';
import { JsonLogger, type LogLevel } from '../../../../src/infrastructure/logging/JsonLogger.js';

const NOW = new Date('2026-11-13T22:00:00.000Z');
function make(level: LogLevel = 'info') {
  const lines: string[] = [];
  const logger = new JsonLogger(level, { write: (l) => lines.push(l) }, () => NOW);
  return { lines, logger, last: () => JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown> };
}

describe('JsonLogger', () => {
  it('emite JSON lines com time, level e event', () => {
    const { logger, lines, last } = make();
    logger.info('evt', { requestId: 'r1', httpStatus: 200 });
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(last()).toEqual({ time: '2026-11-13T22:00:00.000Z', level: 'info', event: 'evt', requestId: 'r1', httpStatus: 200 });
  });

  it('campos fora da allowlist não saem', () => {
    const { logger, lines } = make();
    logger.info('evt', { requestId: 'r1', token: 'segredo', authorization: 'Bearer x', prompt: 'p' } as never);
    expect(lines[0]).not.toContain('segredo');
    expect(lines[0]).not.toContain('Bearer');
    expect(lines[0]).not.toContain('prompt');
    expect(Object.keys(JSON.parse(lines[0] ?? '{}') as object)).toEqual(['time', 'level', 'event', 'requestId']);
  });

  it('bindScope e transport (ADR-0011) passam pela allowlist; host, porta e URL continuam fora', () => {
    const { logger, last } = make();
    logger.info('http.listening', { outcome: 'STARTED', bindScope: 'private-network', transport: 'plaintext-encrypted-overlay', host: '0.0.0.0', port: 8080, url: 'http://0.0.0.0:8080' } as never);
    expect(last()).toEqual({ time: '2026-11-13T22:00:00.000Z', level: 'info', event: 'http.listening', outcome: 'STARTED', bindScope: 'private-network', transport: 'plaintext-encrypted-overlay' });
  });

  it('bindScope/transport ausentes não geram chave; valores não string são descartados; strings são limpas e truncadas', () => {
    const { logger, last } = make();
    logger.info('e', { bindScope: 'loopback' });
    expect(Object.keys(last())).toEqual(['time', 'level', 'event', 'bindScope']);
    logger.info('e', { bindScope: { a: 1 }, transport: Number.NaN } as never);
    expect(Object.keys(last())).toEqual(['time', 'level', 'event']);
    logger.info('e', { transport: `x\ny${'z'.repeat(5000)}` });
    const t = last()['transport'] as string;
    expect(t).not.toContain('\n');
    expect(t.length).toBeLessThan(300);
  });

  it('strings longas são truncadas', () => {
    const { logger, last } = make();
    logger.info('e'.repeat(5000), { requestId: 'a'.repeat(5000), violationCodes: ['b'.repeat(5000)] });
    const r = last();
    expect((r['event'] as string).length).toBeLessThan(300);
    expect((r['requestId'] as string).length).toBeLessThan(300);
    expect(((r['violationCodes'] as string[])[0] as string).length).toBeLessThan(300);
  });

  it('arrays são limitados e só mantêm strings', () => {
    const { logger, last } = make();
    logger.info('e', { violationCodes: [...Array.from({ length: 80 }, () => 'X'), 5 as never] });
    expect((last()['violationCodes'] as string[]).length).toBeLessThanOrEqual(50);
  });

  it('controles e U+2028/2029 saem escapados; uma linha por registro', () => {
    const { logger, lines } = make();
    logger.warn('a\nb\r c d\u0000e\u001bf\u007fg\u0085h', { requestId: 'x\ny' });
    expect(lines).toHaveLength(1);
    const raw = lines[0] as string;
    // eslint-disable-next-line no-control-regex
    expect(raw.slice(0, -1)).not.toMatch(new RegExp('[\\n\\r\\u2028\\u2029\\u0000\\u001b\\u007f\\u0085]'));
    expect(raw).toContain('\\\\u000a');
    expect(raw).toContain('\\\\u2028');
    expect(raw).toContain('\\\\u2029');
  });

  it('números não finitos e tipos errados são descartados', () => {
    const { logger, last } = make();
    logger.info('e', { durationMs: Number.NaN, httpStatus: Infinity, requestId: { token: 'segredo' } as never });
    expect(Object.keys(last())).toEqual(['time', 'level', 'event']);
  });

  it('filtro de nível', () => {
    const w = make('warn');
    w.logger.info('i');
    expect(w.lines).toHaveLength(0);
    w.logger.warn('w');
    w.logger.error('e');
    expect(w.lines).toHaveLength(2);
    const e = make('error');
    e.logger.warn('w');
    expect(e.lines).toHaveLength(0);
    e.logger.error('e');
    expect(e.lines).toHaveLength(1);
  });

  it('stream que lança não propaga', () => {
    const logger = new JsonLogger('info', { write: () => { throw new Error('boom'); } }, () => NOW);
    expect(() => { logger.info('e'); logger.warn('e'); logger.error('e'); }).not.toThrow();
  });

  it('relógio que lança não propaga', () => {
    const logger = new JsonLogger('info', { write: () => undefined }, () => { throw new Error('clock'); });
    expect(() => {
      logger.info('e');
    }).not.toThrow();
  });
});
