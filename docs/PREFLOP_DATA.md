# Preflop Strategy Data Pipeline

RangeLab imports only complete, licensed 169-hand spots. The CLI creates authoring templates, converts CSV or JSON rows into the canonical contract, and validates final datasets. It does not synthesize solver frequencies.

## 1. Create an authoring template

```powershell
npm run strategy:data -- template data\btn-vs-co.csv --positions BTN --stacks 100 `
  --scenarios open-with-callers --opener CO --callers SB --sizes 2.5,3
```

Comma-separated lists generate multiple spots. Supported positions are `UTG,UTG+1,MP,HJ,CO,BTN,SB,BB`; stacks are `20,40,60,100,150`; scenarios are `unopened,single-open,open-with-callers,facing-3bet,facing-4bet`.

The template leaves `fold`, `passive`, and `aggressive` empty. Populate these values from a solve or a properly licensed source. Each row may use probabilities totaling 1 or percentages totaling 100. `callerPositions` uses `+` between positions, for example `BTN+SB`.

## 2. Convert source rows

```powershell
npm run strategy:data -- convert data\btn-rfi.csv data\6max-100bb-rfi-v1.json `
  --id 6max-100bb-rfi-v1 `
  --license "Proprietary - self solved" `
  --generated-at 2026-08-27
```

The v2 CSV columns are `hand,position,stack,scenario,openerPosition,callerPositions,actionSize,fold,passive,aggressive`. Common aliases include `holding`, `pos`, `stack_bb`, `spot`, `opener`, `callers`, `size`, `call` for passive, and `raise` for aggressive. JSON input may be a row array or an object containing `rows`.

The output contract is `rangelab.preflop_strategy.v2`. Every distinct position/stack/scenario/opener/callers/size group must contain each of the 169 normalized starting hands exactly once. Existing `rangelab.preflop_strategy.v1` datasets remain valid and act as wildcard spots when no more specific v2 row matches.

## 3. Validate before import

```powershell
npm run strategy:data -- validate data\6max-100bb-rfi-v1.json
```

Validation checks the contract, dataset id, license, ISO generation date, supported spot values, non-negative finite frequencies, sums within 0.01 of 100, duplicates, and missing hands. A successful JSON file can be loaded through the app's `STRATEGY DATA` panel.
