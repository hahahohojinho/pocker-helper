# RangeLab Solver 확장 기술 구현 명세서

- 작성일: 2026-11-25
- 기준 코드: `chore/cleanup-docs` (master f9b9e09 + 문서/데드코드 정리)
- 입력 자료: 외부 설계 대화 "Texas Hold'em GTO Solver 시뮬레이터 설계" (Python 신규 개발 제안), 2026-11-25 코드 점검 결과

## 0. 이 문서의 결정 사항

외부 설계는 Python으로 엔진, Evaluator, CFR을 처음부터 만드는 계획이다. RangeLab에는 그 계획의 Phase 1~5 대부분이 TypeScript와 Rust로 이미 구현돼 있으므로 **재작성하지 않고 기존 구조 위에서 확장한다.**

| 외부 설계 항목 | RangeLab 현재 구현 | 판단 |
| --- | --- | --- |
| Game Engine (2~8인, 베팅, 사이드팟) | `preflop-machine.ts`, `postflop-hand-state.ts`, `pots.ts` | 유지. 블라인드/앤티 설정만 확장 (P2) |
| Hand Evaluator / Equity | `equity.ts`, `range-equity.ts` (7-card, Monte Carlo, 가중 레인지) | 유지 |
| CFR / CFR+ / DCFR | `tools/dcfr-solver` (submodule), `dcfr-core`, `dcfr-wasm`, `dcfr-adapter` | 유지. 트리 구성 결함 수정 (P0) |
| MCCFR 프리플랍 | `tools/rangelab-preflop` + `public/data/preflop` (6/8-max x 20/40/60/100/150bb) | 유지. 앤티/ICM 확장 (P2, P4) |
| Multiway | `tools/multiway-core` (3인 리버, 3인 턴 근사) | 연구 과제로 유지 (P5) |
| Strategy Store (SQLite) | 전략은 JSON 팩/플랍 라이브러리, SQLite는 상대 성향 기록용 | 유지 |
| Cash Rake | 엔진(`cfr.rs` `rake_pct`, `rake_cap`)에만 있고 요청 경로 미연결 | 연결 (P3) |
| Tournament / Ante / ICM | 없음 | 신규 (P2, P4) |
| CLI 실행 | 웹 UI + 빌드 스크립트 (`scripts/`) | 웹 UI 유지, 배치 계산은 기존 스크립트 방식 |
| Deep CFR | 없음 | 범위 밖 (9장) |

외부 설계에서 그대로 채택하는 원칙:
1. 지원 범위와 정확도를 분리해 표시한다 (이미 `NOT GTO`, `MODEL EV` 등의 라벨로 하고 있음. 근사 매칭 라벨을 추가한다).
2. 수학적 정확성은 리뷰가 아니라 알려진 해가 있는 게임과의 비교 테스트로 검증한다 (P0-3).
3. 캐시 평가는 Chip EV, 토너먼트 평가는 Chip EV와 ICM $EV로 분리한다.
4. 계산은 사전 계산(팩, 라이브러리), 실시간 서브게임 계산, 시뮬레이션 검증을 함께 쓴다.

외부 설계와 다르게 가는 부분:
- **내부 단위.** 외부 설계는 칩 단위로 통일하자고 한다. RangeLab 엔진은 BB 단위 실수를 쓰고 솔버 요청에서만 1/100BB 정수(칩)로 바꾼다. 전체를 칩 단위로 바꾸는 비용에 비해 이득이 작으므로 **엔진은 BB 단위를 유지하고, 칩과 블라인드 레벨은 테이블 설정(P2)과 기록 계층에서만 다룬다.**

## 1. 최종 목표 범위

| 항목 | 목표 |
| --- | --- |
| 테이블 | 6-max 우선, 8-max 확장 (같은 엔진에서 인원 가변) |
| 게임 | 캐시 (고정 블라인드, 스택 변동, 레이크), 토너먼트 (블라인드 상승, 앤티, BB 앤티, ICM) |
| 스택 | 플레이어별 독립, 10~200bb 우선 지원 |
| Solver 범위 | 프리플랍 + 포스트플랍 모두 핵심 기능 |
| Multiway | 3인부터 단계적 지원. 4인 이상은 근사와 명시적 라벨 |

## 2. 현재 상태와 확인된 결함

### 2-1. [Critical] dcfr 경로는 계산 중인 스트리트에서만 베팅 가능
- 위치: `tools/dcfr-core/src/solve.rs:17-31` `bet_config()`.
- 동작: 현재 스트리트(`sizes[request.street.index()]`)에만 베팅 사이즈를 넣는다. 다음 스트리트는 사이즈가 비어 있어 체크만 가능하다. 남은 스택이 팟 이하이면 올인은 가능하다(`allin_pot_ratio: 1.0`).
- 실측 (2026-11-25): 턴 트리의 시작점 액션은 `[Check, Bet(1/2)]`, 체크-체크 후 리버 시작점은 `[Check]` (스택 19500, 팟 1100).
- 영향:

| 계산 대상 | 실제로 푸는 게임 |
| --- | --- |
| 리버 | 리버 베팅 (정상) |
| 턴 | 턴 베팅 후 리버 체크다운 |
| 플랍 (실시간, 라이브러리) | 플랍 베팅 후 턴/리버 체크다운 |

- 결과: 턴/플랍의 exploitability 수치(턴 0.02% 이하, 라이브러리 0.5% 이하)는 단순화된 게임 기준이다. 드로우와 블러프 캐처 가치가 왜곡된다.
- 문서 오류: `docs/SOLVER_INTEGRATION.md`의 multiway 턴 근사 비교 문단은 기준 계산을 "river betting included"로 적었지만, 같은 `bet_config` 경로를 쓰므로 기준 쪽도 리버 체크다운이다.
- TexasSolver 경로(`texas-solver-config.ts`)는 모든 스트리트에 사이즈를 넣으므로 해당 없음.

### 2-2. [High] 베팅 사이즈가 한 가지
- 위치: `src/lib/solver-presets.ts:62` `tree:{betPercent:[50],raisePercent:[60],includeAllIn:false}` (모든 스트리트 공통).
- 예외: 핸드 기록에 나온 사이즈는 그 스트리트에 추가된다 (`solver-tree.ts`, `wasm-solver` `encodeHistory`).
- 영향: Hero가 먼저 베팅하는 노드에서 작은 사이즈와 오버벳을 선택할 수 없다.
- 엔진 한계는 아니다: 단계별 사이즈 최대 6개 (`request.rs:10`), 베팅/레이즈 최대 4회 (`request.rs:9`).

### 2-3. [High] 동적 스택 미흡 (캐시)
- 프리플랍 팩을 Hero 본인 스택으로 조회한다 (`table-helper-v2.tsx:54`, `effectiveStack:heroStack`). 실제 유효 스택이 아니다.
- 팩 근사 매칭(가장 가까운 스택, 2.5배 이내)에 근사 표시가 없다 (`preflop-packs.ts`).
- 플랍 라이브러리는 100bb 정확 일치만 사용한다 (`flop-library/manifest.ts`, 17개 시나리오 전부 `stack:100`).
- 핸드가 끝나도 스택이 자동 갱신되지 않는다 (`startNextHand`는 회전만 함).

### 2-4. [Medium] 블라인드, 앤티, 레이크, ICM 없음
- SB 0.5, BB 1이 코드에 고정돼 있다 (`preflop-machine.ts:41` 부근).
- 앤티, BB 앤티, ICM 코드가 없다. 레이크는 엔진에만 있다.

## 3. 공통 설계

### 3-1. TableConfig (신규, `src/lib/table-config.ts`)

```ts
export type GameType="cash"|"tournament";
export interface BlindLevel { level:number; smallBlind:number; bigBlind:number; ante:number; bbAnte:boolean; }
export interface RakeConfig { percent:number; capBb:number; noFlopNoDrop:boolean; }
export interface TableConfig {
  gameType:GameType;
  tableSize:6|8;
  blinds:BlindLevel;            // 칩 단위 원본 값
  rake?:RakeConfig;             // cash 전용
  payouts?:number[];            // tournament 전용, 순위별 상금
}
/** 엔진 입력 경계에서 칩을 BB로 바꾼다. 엔진 내부는 BB 단위 실수를 유지한다. */
export function chipsToBb(chips:number,config:TableConfig):number;
export function deadMoneyBb(config:TableConfig,activePlayers:number):number; // 앤티 합계 (BB 앤티면 1명분)
```

- 검증: `bigBlind>0`, `smallBlind<=bigBlind`, `ante>=0`, `rake.percent` 0~10, `payouts` 내림차순과 양수. 실패 시 사용자 메시지로 거부.
- 저장: 브라우저 상태 + 핸드 기록 DB(`profile-db-core.ts`)에 레벨과 칩 스택을 같이 저장.

### 3-2. 근사 표시 규칙 (전 구간 공통)

| 라벨 | 조건 |
| --- | --- |
| `SOLVED` | 정확 일치 팩, 라이브러리, 또는 수렴 기준 통과한 실시간 계산 |
| `APPROX STACK` | 팩/라이브러리를 다른 스택 깊이로 대신 사용 |
| `APPROX SIZE` | 다른 오픈/3벳 사이즈 스팟으로 대신 사용 |
| `APPROX ANTE` | 앤티 없는 팩을 앤티 있는 게임에 사용 |
| `CHECKDOWN TREE` | P0-1 수정 전 턴/플랍 결과 (뒤 스트리트 베팅 없음) |

### 3-3. 신규 입력값 검증 규칙 (보안 리뷰 반영)
- `betSizesByStreet`: 키는 `turn`, `river`만 허용(`deny_unknown_fields`), 각 스트리트에 `betSizes`와 같은 제한(깊이 1~4, 깊이당 1~6개, 분수는 양수이고 팟의 50배 이하). 해결 중인 스트리트나 그 이전 스트리트 키는 거부. 트리 크기는 기존 `estimate`의 `MAX_TREE_NODES`와 `max_tree_bytes`로 계산 전에 거부.
- `allinPotRatio` (P0-2): 유한한 값, 0 이상 상한(예: 100) 이하.
- `rake` (P3): `percent` 0~10, `capChips` 1~`MAX_CHIPS`. 레이크 계산은 i64 또는 checked 연산.
- `TableConfig` (P2): 칩 값은 정수이고 `MAX_CHIPS`(1천만) 이하, `capBb >= 0`, `payouts` 길이 10 이하. localStorage, 가져오기 파일 등 외부에서 읽을 때도 같은 검증을 거친다.
- TS(`texas-solver-config.ts`, `wasm-solver/request.ts`)와 Rust(`request.rs`)의 상수는 같은 값으로 유지한다.

## 4. 작업 명세

각 작업은 "변경 파일 / 인터페이스 / 완료 기준"으로 정의한다. 작업마다 구현, 테스트, code-reviewer와 security-reviewer 리뷰를 통과한 뒤 다음으로 넘어간다.

### P0. Solver 정확성 기반 (최우선)

#### P0-1. 뒤 스트리트 베팅 트리
- 변경 파일:
  - `tools/dcfr-core/src/request.rs`: 요청에 `betSizesByStreet` (선택) 추가. 형식은 `{flop?:Frac[][],turn?:Frac[][],river?:Frac[][]}`이고, 각 배열은 단계(0=베팅, 1+=레이즈)별 사이즈다. 없으면 기존 `betSizes`를 현재 스트리트에만 적용해 하위 호환을 유지한다.
  - `tools/dcfr-core/src/solve.rs` `bet_config()`: 현재 스트리트와 이후 스트리트에 사이즈를 채운다. 핸드 기록에서 관측된 사이즈는 현재 스트리트에만 병합한다.
  - `tools/dcfr-core/src/estimate.rs`: 트리 노드 수 추정에 뒤 스트리트를 포함하고 `MAX_TREE_NODES` 초과 시 거부 메시지를 반환한다.
  - `src/lib/wasm-solver/*.ts` `buildWasmSolveRequest`: `betSizesByStreet` 생성.
  - 재빌드: `npm run solver:wasm` (wasm, sha256, 라이선스 파일), 네이티브 adapter (`cargo build --release`, VS2022 BuildTools 환경 `vcvars64.bat` 필요. VS 18 Community에는 `msvcrt.lib`이 없어 링크 실패 확인됨).
- 완료 기준:
  - 턴 요청에서 체크-체크 후 리버 노드에 리버 베팅 액션이 존재한다 (Rust 단위 테스트).
  - 기존 리버 요청 결과는 변하지 않는다 (회귀 테스트, 같은 시드).
  - 측정표 기록: 턴(리버 베팅 포함) 4.5초 예산에서 반복 횟수와 exploitability, 레인지 2종(SRP, 100% vs 100%).
  - exploitability 1% 초과 시 턴 예산 조정안을 같이 제출한다.
- 위험: 트리 크기 증가로 브라우저 wasm 턴 계산이 5초를 넘을 수 있다. 이 경우 wasm은 기존 트리로 두고 `CHECKDOWN TREE` 라벨을 표시한다.

- 진행 상황 (2026-11-26): 네이티브 턴 계산에 리버 베팅(50%/60%) 적용, 4.5초에 0.29~0.48%. 턴 2사이즈나 리버 3사이즈를 턴 계산에 넣으면 1.6~18%로 실시간 불가. 브라우저 wasm과 플랍은 기존 트리 유지, 화면에 `이후 스트리트 체크다운 근사` 표시. 측정표는 `docs/SOLVER_INTEGRATION.md` "Later-street betting".

#### P0-2. 스트리트별 베팅 사이즈 프리셋
- 변경 파일: `src/lib/solver-presets.ts` (`getSolverPreset`이 스트리트별 트리 반환), `src/lib/texas-solver-config.ts` (트리 타입에 스트리트별 사이즈), `solver-tree.ts`.
- 기본 프리셋 (초기값, 측정 후 조정):

| 스트리트 | 베팅 | 레이즈 | 올인 |
| --- | --- | --- | --- |
| 플랍 | 33%, 75% | 60% | SPR 1 이하 |
| 턴 | 50%, 100% | 60% | 항상 |
| 리버 | 33%, 75%, 150% | 60% | 항상 |

- 진행 상황 (2026-11-26): 네이티브 리버 33/75/150% + 레이즈 60% 적용 (2초에 0.006% 이하). 턴/플랍 다중 사이즈는 위 측정 결과로 보류.
- 올인 "항상" 옵션: `bet_config.allin_pot_ratio`를 요청 값으로 받도록 `dcfr-core` 확장 (0.0 = 항상).
- 플랍 라이브러리 스펙(`manifest.ts`)은 P0-4에서 새 트리로 재생성하기 전까지 기존 `[50]/[60]`을 고정 사용한다. 그래야 기존 데이터가 `stale`로 버려지지 않는다.
- 완료 기준:
  - `solver-presets.test.ts`가 모든 백엔드와 스트리트 조합에서 `validateTexasSolverJob` 통과.
  - 리버 실측: 3사이즈와 올인에서 4.5초 안에 0.3% 이하.
  - UI 액션 목록에 사이즈별 빈도와 EV가 표시된다 (`postflop-panel.tsx`).

#### P0-3. 정답이 알려진 게임으로 교차 검증
- 진행 상황 (2026-11-26): 1번과 3번 완료 (`tools/dcfr-core/tests/known_games.rs`). 2번(TexasSolver 대조)은 실행 파일이 없어 보류.
- 테스트 세트:
  1. **리버 양극화 게임 (해석해 존재)**: 한쪽은 넛 또는 에어, 상대는 블러프 캐처 하나만 가진 게임. 베팅 b(팟 대비)일 때 블러프 비율 b/(1+2b), 콜 빈도 1/(1+b). 사이즈 0.5, 1.0, 1.5에서 0.5%p 이내로 일치해야 한다.
  2. **TexasSolver 대조**: 같은 보드, 같은 레인지, 같은 트리로 리버 3스팟과 턴 3스팟을 계산해 루트 액션 빈도는 3%p 이내, EV는 팟의 0.5% 이내로 일치해야 한다 (TexasSolver 실행 파일이 있을 때만 실행).
  3. **수렴 단조성**: 반복 횟수 100, 300, 1000에서 exploitability가 감소해야 한다.
- 위치: `tools/dcfr-core/tests/known_games.rs` (1, 3), `src/lib/server/solver-crosscheck.test.ts` (2, 환경 변수 `TEXAS_SOLVER_PATH`가 없으면 skip).

#### P0-4. 플랍 라이브러리 재생성 계획
- P0-1과 P0-2 완료 후, `scripts/build-flop-library.mjs --limit 20`으로 플랍 하나당 시간, 크기, exploitability를 측정한다.
- 측정값으로 전체 재계산 시간을 다시 추정해 보고한다. 지금의 "17개 시나리오 약 9일" 추정은 체크다운 트리 기준이라 무효다.
- 재계산 전까지 기존 라이브러리 결과에 `CHECKDOWN TREE` 라벨을 표시한다.

#### P0-5. 문서 정정
- `docs/SOLVER_INTEGRATION.md`: 2-1의 트리 범위를 명시하고 multiway 턴 비교 문단을 정정한다. README 정확도 표도 갱신한다.

### P1. 캐시게임 동적 스택

#### P1-1. 프리플랍 유효 스택 조회
- 진행 상황 (2026-11-26): 완료. 다인 팟에서는 어그레서 스택이 더 중요할 수 있다는 한계가 있음.
- 변경: `table-helper-v2.tsx:54`. `effectiveStack`을 Hero 스택과 아직 행동할 수 있는 상대 중 최대 스택의 최소값으로 바꾼다. 상대가 이미 레이즈했으면 그 레이저 스택 기준.
- 신규 함수: `src/lib/preflop-context.ts` 또는 기존 `game-state.ts`에 `preflopEffectiveStack(actions, seats, stacks, heroSeat):number`. 기존 유틸을 먼저 확인한 뒤 위치를 정한다.
- 완료 기준: Hero 250bb, 상대 40bb 레이즈 상황이면 40bb 팩을 선택한다 (단위 테스트).

#### P1-2. 근사 매칭 표시
- 진행 상황 (2026-11-26): 완료. 사이즈는 5% 이내면 같은 스팟으로 봄.
- 변경: `lookupPackStrategy` 반환값에 `match:{stack:"exact"|"approx";size:"exact"|"approx";packStack:number;requestedStack:number}`를 추가하고, UI에 3-2 라벨을 표시한다.
- 호출부 전체(`strategy-data.ts` 등)를 Grep으로 확인한 뒤 반환 타입 확장은 선택 필드로 한다.

#### P1-3. 플랍 라이브러리 스택 허용 범위
- 진행 상황 (2026-11-26): 완료. 가장 가까운 스택 우선, SPR 4 미만은 정확 일치만 허용 (코드 리뷰 반영). 실측 비교는 라이브러리 데이터가 있는 PC에서 필요.
- 변경: `flop-library/lookup.ts`. 유효 스택이 라이브러리 스택의 ±15% 이내이면 사용하고 `APPROX STACK`으로 표시한다.
- 허용 범위 상수는 `manifest.ts`에 둔다.
- 완료 기준: 90bb와 115bb 요청은 히트하고, 80bb 요청은 `scenario` 미스.
- 측정: 같은 보드에서 90bb 실시간 계산과 100bb 라이브러리 결과의 빈도 차이를 5개 보드에서 기록한다.

#### P1-4. 핸드 결과로 스택 자동 갱신
- 변경: "핸드 저장" 시 팟 분배 결과(`pots.ts` 레이어와 쇼다운 승자 입력)로 좌석별 스택을 계산해 `setStacks`에 반영한다. 레이크가 설정돼 있으면 차감한다.
- UI: 갱신 전후 스택을 보여 주고 수동 수정을 허용한다.
- 완료 기준: 사이드팟 3개 올인 시나리오에서 칩 보존 (전체 합 = 이전 합 - 레이크).

#### P1-5. 다른 스택 깊이 라이브러리
- P0-4 측정 후 결정. 후보는 150bb와 60bb이고 6-max SRP 시나리오부터 시작한다.

### P2. 테이블 설정 (블라인드, 앤티)

#### P2-1. TableConfig 도입
- 3-1 인터페이스를 구현한다. UI에 게임 유형, 블라인드, 앤티, BB 앤티 입력을 추가한다. 스택 입력은 칩과 BB 중 선택하고, 내부에는 BB로 저장한다.

#### P2-2. 엔진에 블라인드와 앤티 반영
- 변경: `preflop-machine.ts` `deriveBettingState`의 SB 0.5 고정값을 설정값으로 바꾸고, 앤티는 데드머니로 `pot` 시작값에 더한다. 액션 기여금(`contributions`)에는 넣지 않는다.
- 기존 호출부: `deriveBettingState`, `availableActions`, `validatePreflopAction`, `isBettingRoundComplete`, `nextPosition`. 각 함수에 선택 파라미터 `blinds?:BlindLevel`을 추가하고, 기본값은 현재 동작(0.5/1, 앤티 0)과 같게 한다.
- 완료 기준: 기존 `poker-engine.test.ts`, `preflop-context.test.ts` 전체 통과와 앤티 케이스 추가.

#### P2-3. 앤티 프리플랍 팩
- `tools/rangelab-preflop`에 앤티 옵션을 추가하고(게임 시작 팟에 데드머니), 6-max 앤티 팩(20/40/60bb, BB 앤티 1bb)을 생성한다.
- 앤티 팩이 없으면 앤티 없는 팩을 쓰고 `APPROX ANTE`로 표시한다.

### P3. 캐시 레이크

- dcfr-core 요청에 `rake:{percent,capChips}` (선택)를 추가해 `SubgameConfig.rake_pct`와 `rake_cap`으로 넘긴다. 엔진 기능은 이미 있다 (`cfr.rs:478-481`, `3330`).
- TexasSolver 경로는 레이크를 지원하지 않으므로 레이크가 있으면 dcfr 경로를 우선 사용하고 결과에 표시한다.
- 프리플랍 팩은 레이크 없이 계산된 것으로 표시한다 (no-flop-no-drop 근사).
- 완료 기준: 레이크 5%, 캡 3bb 리버 스팟에서 콜 빈도가 레이크 없을 때보다 감소한다 (방향성 테스트). 칩 보존 테스트.

### P4. 토너먼트

#### P4-1. 블라인드 레벨 관리
- `BlindLevel[]` 스케줄을 입력하고 "다음 레벨"로 올린다. 칩 스택은 그대로 두고 BB 환산값만 바뀐다.
- 핸드 기록에 레벨을 저장한다.

#### P4-2. ICM 계산기 (신규 `src/lib/icm/icm.ts`)
- 알고리즘: Malmuth-Harville. 플레이어 9명 이하는 정확 재귀(메모이제이션), 그 이상은 Monte Carlo.
- 인터페이스:
  ```ts
  export function icmEquity(stacks:number[],payouts:number[]):number[];
  export function chipEvToDollarEv(input:{stacksBefore:number[];outcomes:{prob:number;stacksAfter:number[]}[];payouts:number[];heroIndex:number}):number;
  ```
- 검증: 알려진 사례(3인 동일 스택이면 상금 합/3, 1인 칩리더 극단값)와 공개 계산기 결과 3건을 대조한다.

#### P4-3. 숏스택 푸시/폴드 ICM 차트
- 범위: 15bb 이하, 6-max, 오픈 푸시와 푸시 대응 콜.
- 계산: 169 핸드 클래스 대상 ICM 보상 기반 fictitious play (오프라인 스크립트), 결과는 `public/data/pushfold/`.
- UI: 토너먼트 모드에서 15bb 이하이면 푸시/폴드 차트를 우선 사용하고 `ICM $EV`로 표시한다.
- 15bb 초과 구간은 Chip EV 팩을 쓰고 `CHIP EV (NOT ICM)`으로 표시한다. 포스트플랍 ICM은 범위 밖이다.

### P5. Multiway (연구 과제)
- 현재: 3인 리버는 네이티브 CFR(최대 BR gain 표시), 3인 턴은 리버 체크다운 근사, 3인 플랍과 4인 이상은 MODEL EV.
- 다음 단계: P0-1과 같은 방식으로 3인 턴에 리버 베팅을 넣었을 때 시간을 측정한다. 3인 플랍은 사전 계산 라이브러리 방식만 검토한다.
- 평가 지표: 2인 exploitability 대신 플레이어별 최대 BR gain을 쓴다 (기존 `convergence.maxBrGain`).

## 5. 우선순위와 규모

| 순서 | 작업 | 규모 | 의존 |
| --- | --- | --- | --- |
| 1 | P0-3 교차 검증 테스트 (1, 3번) | 소 | 없음 |
| 2 | P0-1 뒤 스트리트 베팅 | 중 (Rust, 재빌드, 측정) | P0-3 |
| 3 | P0-2 스트리트별 사이즈 | 중 | P0-1 |
| 4 | P0-5 문서 정정 | 소 | P0-1 |
| 5 | P1-1, P1-2 프리플랍 유효 스택과 근사 표시 | 소 | 없음 (병행 가능) |
| 6 | P1-4 스택 자동 갱신 | 중 | 없음 |
| 7 | P0-4 플랍 라이브러리 재계산 측정 | 측정 1일 + CPU 계산 | P0-2 |
| 8 | P1-3 라이브러리 스택 허용 범위 | 소 | P0-4 결과 |
| 9 | P2 블라인드와 앤티 | 중 | 없음 |
| 10 | P3 레이크 | 소 | P0-1 |
| 11 | P4 토너먼트와 ICM | 대 | P2 |
| 12 | P5 Multiway | 연구 | P0-1 |

## 6. 검증 기준 요약

| 영역 | 기준 |
| --- | --- |
| Solver 정확성 | 해석해 게임 0.5%p 이내, TexasSolver 대조 빈도 3%p 이내 |
| 수렴 | exploitability: 리버 0.3%, 턴 1%, 라이브러리 플랍 0.5% 이하. 초과 시 UI 경고 (기존 1%/5% 기준 유지) |
| 엔진 | 칩 보존 (사이드팟, 레이크 포함), 기존 테스트 전체 통과 |
| ICM | 알려진 사례 일치, 상금 합 보존 |
| 성능 | 턴/리버 응답 5초, 실시간 플랍 10초 이내 (`SOLVER_MAX_BUDGET_MS` 기준) |
| 표시 | 근사 사용 시 3-2 라벨이 반드시 표시됨 |

## 7. 측정 기록 양식

모든 성능 수치는 다음 형식으로 `docs/SOLVER_INTEGRATION.md`에 기록한다: 날짜, 스레드 수, 레인지 종류, 보드, 트리(스트리트별 사이즈), 예산, 반복 횟수, exploitability, 벽시계 시간.

## 8. 작업 진행 규칙
- 작업 하나 단위로 브랜치를 만든다 (`feat/p0-1-later-street-tree` 등).
- Rust 변경 시 wasm과 네이티브를 같이 재빌드하고 sha256 파일을 갱신한다.
- 사전 계산 데이터(`public/data/flop-library`)는 gitignore이므로 생성 명령, 스펙 해시, 위치를 `docs/HANDOFF.md`에 기록한다.

## 9. 범위 밖
- Deep CFR와 신경망 전략 근사.
- 6~8인 프리플랍부터 리버까지의 완전 탐색.
- 포스트플랍 ICM.
- Python 재작성, CLI 전용 실행 환경.
