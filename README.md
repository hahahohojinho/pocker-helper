# RangeLab Poker Helper

6-max/8-max NLHE 테이블에서 액션을 입력하고 프리플랍 추천, 포스트플랍 Equity, 로컬 TexasSolver 빈도를 확인하는 개발 버전입니다.

## 현재 구현 상태

| 영역 | 상태 | 정확도 범위 |
| --- | --- | --- |
| 프리플랍 순서/유효성 | 구현 | 자동 폴드, 림프·오픈·콜·3/4/5-bet, 최소 레이즈, 숏 올인 재오픈 포함 |
| 팟/스택 | 구현 | 블라인드, 누적 기여금, 올인 메인·사이드 팟 포함 |
| 169 핸드 전략 | 기초 구현 | v2 데이터는 opener·callers·sizing별 조회, v1 wildcard 호환; 미적재 spot은 `baseline-v1` |
| 포스트플랍 | 구현 | 플랍·턴·리버 순서와 스트리트 간 상태 유지 |
| Equity | 구현 | 7-card hand ranking + Monte Carlo, 다중 상대 가중 레인지 지원 |
| 상대 레인지 | 기초 구현 | 프리플랍 액션·사이징 및 포스트플랍 made hand·draw·blocker 휴리스틱으로 자동 갱신; 직접 편집 가능 |
| Solver | 부분 구현 | TexasSolver heads-up OOP/IP root·중간 노드 preview 및 외부 counterfactual EV/multiway backend 계약. EV 미제공 시 Model EV로 구분 |

현재 추천과 자동 레인지는 휴리스틱 baseline입니다. 화면의 `NOT GTO`, `ACTION BASELINE`, `MODEL EV` 표시는 솔버 결과와 추정값을 구분하는 의도적인 표기입니다.

## 빠른 실행

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## 검증

```bash
npm test
npm run lint
npm run build
```

프리플랍 solve 데이터의 CSV 템플릿 생성, 정규 JSON 변환 및 검증은 `npm run strategy:data -- ...`로 수행합니다. 자세한 사용법은 [프리플랍 데이터 파이프라인 문서](docs/PREFLOP_DATA.md)를 참고하세요.

실행 중인 production 서버의 브라우저 smoke test는 `node scripts/e2e-smoke.mjs`로 수행합니다.

## 로컬 TexasSolver

실행 파일은 저장소에 포함하지 않습니다. PowerShell에서 경로와 로컬 API 허용 여부를 지정합니다.

```powershell
$env:TEXAS_SOLVER_PATH='C:\path\to\console_solver.exe'
$env:ALLOW_LOCAL_SOLVER_API='1'
npm run dev
```

자세한 계약과 제한은 [solver integration 문서](docs/SOLVER_INTEGRATION.md)를 참고하세요.

## 현재 남은 GTO 정확도 작업

- `baseline-v1`을 자체 solve 또는 정식 라이선스의 6-max 프리플랍 데이터로 교체
- 실제 multiway counterfactual solver 서비스 배포 및 운영 설정

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
