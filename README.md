# RangeLab Poker Helper

6-max/8-max NLHE 테이블에서 액션을 입력하면 프리플랍 솔브 전략, 포스트플랍 솔버 빈도와 EV, 상대 성향 기반 조언을 보여주는 로컬 학습용 도구입니다.

## 현재 구현 상태

| 영역 | 상태 | 정확도 범위 |
| --- | --- | --- |
| 프리플랍 순서/유효성 | 구현 | 자동 폴드, 림프·오픈·콜·3/4/5-bet, 최소 레이즈, 숏 올인 재오픈 포함 |
| 팟/스택 | 구현 | 블라인드, 누적 기여금, 올인 메인·사이드 팟 포함 |
| 프리플랍 전략 | 구현 | 6-max·8-max × 20/40/60/100/150bb 솔브 팩(`public/data/preflop`, 4-bet 대응까지). 팩에 없는 spot은 내장 100bb RFI 데이터, 그다음 `baseline-v1` 휴리스틱 |
| 포스트플랍 | 구현 | 플랍·턴·리버 순서와 스트리트 간 상태 유지 |
| Equity | 구현 | 7-card hand ranking + Monte Carlo, 다중 상대 가중 레인지 지원 |
| 상대 레인지 | 기초 구현 | 프리플랍 액션·사이징 및 포스트플랍 made hand·draw·blocker 휴리스틱으로 자동 갱신; 직접 편집 가능 |
| Heads-up Solver | 구현 | 브라우저 DCFR(WASM) 또는 네이티브 adapter(멀티스레드)로 모든 스트리트·노드를 풀고 액션별 Solver EV와 수렴도 표시. 턴/리버 4.5초 예산 |
| 플랍 라이브러리 | 구현(로컬 데이터) | 6-max 100bb SRP·3-bet 팟 17개 시나리오 × 1,755 플랍 사전 계산(exploitability 0.5% 이하). 데이터는 gitignore(`public/data/flop-library`), `scripts/build-flop-library.mjs`로 생성 |
| Multiway | 부분 구현 | 3인 리버는 네이티브 3인 CFR, 3인 턴은 리버 체크다운 근사. 그 외는 MODEL EV 휴리스틱 또는 외부 counterfactual backend |
| 상대 성향 / EXPLOIT | 구현 | 로컬 SQLite 핸드 기록과 통계, 아이소 레이즈·플랍 c-bet 조언(기준값은 휴리스틱) |

화면의 `NOT GTO`, `ACTION BASELINE`, `MODEL EV`, `EXPLOIT` 표시는 솔버 결과와 추정값을 구분하는 의도적인 표기입니다.

## 빠른 실행

```bash
git submodule update --init   # Rust 도구(tools/)를 빌드할 때만 필요
npm ci
npm run dev                   # http://127.0.0.1:3000
```

Node 22.5 이상이 필요합니다(`node:sqlite`).

## 검증

```bash
npm test
npm run lint
npm run build
```

프리플랍 solve 데이터의 CSV 템플릿 생성, 정규 JSON 변환 및 검증은 `npm run strategy:data -- ...`로 수행합니다. 자세한 사용법은 [프리플랍 데이터 파이프라인 문서](docs/PREFLOP_DATA.md)를 참고하세요.

오픈소스 6-max MCCFR 생성기는 고정된 DCFR-SOLVER submodule을 사용합니다. 모델의 정확도 경계, Windows 빌드 및 변환 절차는 [DCFR 프리플랍 통합 문서](docs/DCFR_PREFLOP.md)를 참고하세요.

실행 중인 production 서버의 브라우저 smoke test는 `node scripts/e2e-smoke.mjs`로 수행합니다.

## 브라우저 Solver

Heads-up 스팟은 별도 설치 없이 브라우저에서 풀립니다(`public/solver/rangelab_dcfr_wasm.wasm`). 모듈을 다시 빌드하려면 Rust와 `wasm32-unknown-unknown` 타깃을 설치한 뒤 `npm run solver:wasm`을 실행합니다. `DCFR_ADAPTER_PATH`로 네이티브 adapter를 지정하면 같은 요청을 서버에서 멀티스레드로 풀어 플랍이 수 배 빨라집니다. 자세한 내용은 [solver integration 문서](docs/SOLVER_INTEGRATION.md)를 참고하세요.

## 로컬 TexasSolver

실행 파일은 저장소에 포함하지 않습니다. PowerShell에서 경로와 로컬 API 허용 여부를 지정합니다.

```powershell
$env:TEXAS_SOLVER_PATH='C:\path\to\console_solver.exe'
$env:ALLOW_LOCAL_SOLVER_API='1'
npm run dev
```

자세한 계약과 제한은 [solver integration 문서](docs/SOLVER_INTEGRATION.md)를 참고하세요.

## 상대 성향 기록 (로컬 SQLite)

`npm run dev`로 실행하면 테이블 화면에 "상대 플레이어 배정" 패널이 나타납니다. 좌석에 상대를 지정하고 핸드를 끝까지 입력한 뒤 "핸드 저장"을 누르면, 액션과 쇼다운 결과가 로컬 DB에 쌓이고 좌석마다 성향(VPIP/PFR/3-bet, TAG/LAG/니트 등)이 표시됩니다. "다음 핸드"를 누르면 버튼과 함께 배정이 한 칸 회전합니다.

- Node 22.5 이상의 내장 `node:sqlite`를 씁니다. 실행 시 `ExperimentalWarning`이 한 번 출력되며, 숨기려면 `$env:NODE_OPTIONS='--disable-warning=ExperimentalWarning'`.
- DB 위치: 기본 `%LOCALAPPDATA%\RangeLab\rangelab.sqlite` (저장소 밖). `RANGELAB_DB_PATH`로 변경.
- `npm run dev` / `npm start`는 `127.0.0.1`에만 바인딩합니다. 같은 네트워크의 다른 기기에서 접속하려면 `npm run dev:lan`을 쓰고 `RANGELAB_ALLOWED_HOSTS`(쉼표 구분, 예: PC의 LAN IP)를 지정하세요. 이 경우 같은 네트워크의 누구나 기록 API에 접근할 수 있습니다.
- 프로덕션 빌드(`npm start`)에서는 `$env:ALLOW_LOCAL_PROFILE_API='1'`이 필요합니다.

## 상대 성향 기반 조언 (EXPLOIT, GTO 아님)

GTO 추천 카드는 그대로 두고, 그 아래에 주황색 "EXPLOIT" 카드가 따로 나타납니다.

- **아이소 판단(프리플랍)**: 앞에서 림프가 나오고 Hero 차례일 때 Fold / Over-limp(BB는 Check) / Iso raise의 MODEL EV를 비교합니다. 림퍼의 림프·PFR·"림프 후 레이즈에 폴드/콜/리레이즈" 기록과 뒤에 남은 플레이어의 3-bet·콜드콜 기록을 씁니다.
- **플랍 c-bet**: Hero가 프리플랍 마지막 레이저이고 플랍에서 아직 베팅이 없을 때, 상대의 c-bet 폴드율과 프리플랍 성향으로 조정한 레인지로 사이즈별 EV를 계산합니다(버튼으로 실행).
- 표본이 최소 기준보다 적은 통계는 반영하지 않고 기준값을 씁니다. 이 경우 카드에 "기준 모델"로 표시됩니다. 근거 통계(x/n, 수축 후 값, 기준값)와 가정은 카드의 "근거 통계"에서 볼 수 있습니다.
- 모델은 한 스트리트 근사이고 상수 일부는 휴리스틱입니다. 기록이 쌓이면 `src/lib/exploit`의 기준값을 보정할 수 있습니다.

## 현재 남은 GTO 정확도 작업

- 플랍 라이브러리 확장: 림프 팟, 4-bet 팟, 100bb 외 스택, 8-max
- 플랍 multiway solver (현재 로컬은 3인 리버, 3인 턴은 근사) 및 4인 이상 multiway
- EXPLOIT 기준값을 기록된 핸드로 보정
