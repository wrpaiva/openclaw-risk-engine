import type { AccountSnapshot, AccountSnapshotProvider } from '../../application/ports/AccountSnapshotProvider.js';
import type { InstrumentCatalog } from '../../application/ports/InstrumentCatalog.js';
import type { FxRate, MarketDataProvider, MarketQuote } from '../../application/ports/MarketDataProvider.js';
import type { InstrumentSpec } from '../../domain/InstrumentSpec.js';

// Fontes reais dependem de D-02/D-03/D-05 (em aberto). Até lá, tudo indisponível => BLOCK (fail-closed).

export class UnconfiguredAccountSnapshotProvider implements AccountSnapshotProvider {
  getSnapshot(): Promise<AccountSnapshot | null> {
    return Promise.resolve(null);
  }
}

export class UnconfiguredMarketDataProvider implements MarketDataProvider {
  quote(): Promise<MarketQuote | null> {
    return Promise.resolve(null);
  }
  fxRate(): Promise<FxRate | null> {
    return Promise.resolve(null);
  }
}

export class UnconfiguredInstrumentCatalog implements InstrumentCatalog {
  find(): Promise<InstrumentSpec | null> {
    return Promise.resolve(null);
  }
}
