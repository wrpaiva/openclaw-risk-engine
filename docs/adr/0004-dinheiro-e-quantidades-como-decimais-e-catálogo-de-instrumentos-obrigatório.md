# ADR-0004 — Dinheiro e quantidades como decimais e catálogo de instrumentos obrigatório

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
BTC/ETH, forex e ouro possuem escalas, lotes, moedas, ticks e multiplicadores distintos. `number`/IEEE-754 pode acumular erro em operações monetárias.

## Decisão proposta
Usar decimais exatos como string nos contratos, valor interno com biblioteca decimal (ex.: `decimal.js`) e `NUMERIC` no PostgreSQL. Operações financeiras devem considerar `InstrumentSpec` verificado, preço de entrada conservador, tick, lote, conversão FX válida e custos/slippage explicitamente configurados.

## Alternativas consideradas
- `number` JS para cálculos financeiros: rejeitada.
- Converter todos ativos em unidades genéricas: rejeitada.
- Escalas fixas globais para qualquer ativo: rejeitada.

## Justificativa e consequências
+ Cálculo reprodutível com instrumentos específicos.
- Exige catálogo versionado e política de arredondamento por instrumento.
- Sem cadastro confiável do produto não há autorização.

## Restrições, riscos e mitigação
Overflow, expoentes, strings inválidas, preços negativos, quantidade zero, NaN, FX vencido e margem indefinida devem ser rejeitados. Não assumir equivalência de moedas ou netting de exposição bruta.

## Critérios de validação
- Testes com bordas decimais, escala, rounding, símbolos desconhecidos, forex, cripto e metais.
- Propriedades de monotonicidade: aumento de quantidade não pode reduzir exposição em contexto constante.
- Comparação exata dos valores persistidos e recalculados.

## Relação com a especificação
Seções 4, 5, 6 e 9.

## Revisão da decisão
- **Gatilhos para revisão:** introdução de novo tipo de derivativo ou convenção de arredondamento
- **Dependências em aberto:** D-01, D-02, D-03, D-06
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.
