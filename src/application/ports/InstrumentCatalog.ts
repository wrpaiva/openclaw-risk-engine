import type { InstrumentSpec } from '../../domain/InstrumentSpec.js';

export interface InstrumentCatalog {
  /** `null` = instrumento desconhecido → INSTRUMENT_NOT_ALLOWED (fail-closed). */
  find(instrument: string): Promise<InstrumentSpec | null>;
}
