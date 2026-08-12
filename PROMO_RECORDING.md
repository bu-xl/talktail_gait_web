# Promo / 화면녹화 세팅 인계

> **목적:** 배포용 서비스 모드로 되돌린 뒤에도, 아래 트리거 문장만으로  
> `dashboard_analysis` 데모 데이터를 front_web 리뷰 화면에 다시 꽂을 수 있게 한다.  
> **대상 독자:** Cursor Agent (또는 같은 작업을 하는 개발자).

---

## 트리거 (사용자가 이렇게 말하면)

다음을 **동일 의미**로 취급하고, 이 문서를 읽고 세팅을 복원한다.

- `영상 녹화를 하게 dashboard_analysis 폴더 안에 있는 ami_analysis로 세팅해줘`
- `jenny_analysis로 녹화 세팅해줘` / `프로모 ami` / `promo 녹화 모드`

**복원 후 확인 URL**

| 케이스 | URL |
|--------|-----|
| Ami | `http://localhost:5173/?promo=ami` |
| Jenny | `http://localhost:5173/?promo=jenny` (jenny 케이스 추가 후) |

`front_web`에서 `npm run dev` 필요.

---

## 필수 디렉터리 레이아웃

Vite가 `front_web/vite.config.ts`에서 **형제 폴더**를 서빙한다.

```
gait_project/
├── front_web/                 ← 이 앱 (본 문서 위치)
└── dashboard_analysis/
    ├── ami_analysis/
    │       ├── ami_origin.mp4          ← 2-1 촬영 원본
    │   ├── ami_pressboard.mp4      ← 1 · 압력패드
    │   └── 175433/                 ← AI 결과 세션
    │       ├── result_video/*.mp4
    │       ├── result_angle_pawy/*_angle_pawy.mp4
    │       ├── result_stride/*_stride.png
    │       ├── result_cyclogram/*_cyclogram.mp4   (리포트용)
    │       ├── result_derived/*_derived.json      (리포트용)
    │       └── result_keypoints/*_keypoints.json  (리포트용)
    └── jenny_analysis/
        ├── jenny_origin.mp4
        ├── jenny_pressboard.mp4
        └── 175517/
            └── (동일 구조)
```

`vite.config.ts`의 `serve-dashboard-analysis` 플러그인이  
`/dashboard_analysis/**` → `../dashboard_analysis/**` 로 매핑한다 (Range 지원 포함).

---

## GitHub / 집 PC clone 시 주의 (중요)

| 항목 | Git에 올라감? | 비고 |
|------|---------------|------|
| 본 문서 `PROMO_RECORDING.md` | ✅ | front_web 저장소에 커밋 |
| promo 코드 (`main.ts`, `reviewPanes.ts`, `index.html`, `vite.config.ts`) | ✅ | 커밋·푸시 필요 |
| `*_derived.json`, `*_keypoints.json`, `*_stride.png` | ⚠️ | monorepo에 두면 추적 가능. **mp4는 제외** |
| `foot2.gif` (`gait_project/foot2.gif`) | ⚠️ | gitignore에 없을 수 있음 — 없으면 집 PC에 별도 복사 |
| `*.mp4` / `*.mov` | ❌ | 루트 `.gitignore`에 `*.mp4` — **GitHub에 안 올라감** |

**집 PC에서 녹화하려면**

1. `front_web` (또는 monorepo)를 `git clone` / `pull`
2. `dashboard_analysis/ami_analysis/` (및 jenny) **영상 파일을 USB·클라우드 등으로 별도 복사**
3. 위 레이아웃대로 `gait_project/dashboard_analysis/...` 에 두기
4. `cd front_web && npm install && npm run dev`
5. `/?promo=ami` 접속

에이전트는 mp4가 없으면 **다운로드를 지어내지 말고**, 사용자에게 파일 복사를 요청한다.

---

## 화면 5섹션 ↔ 파일 매핑

| 섹션 | UI 라벨 | Ami 파일 | Jenny 파일 |
|------|---------|----------|------------|
| **1** | 압력패드 | `ai-server/results/<date>/<time>/result_pressure/<stem>_pressure.mp4` | 동일 규칙 |
| **2-1** | 촬영 영상 | `ami_origin.mp4` | `jenny_origin.mp4` |
| **2-2** | 스켈레톤 분석 | `175433/result_video/...mp4` | `175517/result_video/...mp4` |
| **3-1** | 각도 분석 | `..._angle_pawy.mp4` | `..._angle_pawy.mp4` |
| **3-2** | 보폭분석 | `..._stride.png` | `..._stride.png` |

**섹션 1:** `/api/ai-results/{date}/{time}/result_pressure/{stem}_pressure.mp4`  
(로컬 파일: `ai-server/results/.../result_pressure/..._pressure.mp4`).  
없으면 fallback `gait_project/foot2.gif` (`PROMO_PRESSURE_GIF`).

리포트/사이드용(5칸 밖): `result_cyclogram`, `result_derived`, `result_keypoints`.

---

## 코드에서 어디를 만지나 (복원 체크리스트)

에이전트는 아래가 **이미 있으면 재사용**, 없으면 동일 패턴으로 추가한다.

### 1. `src/app/main.ts` — `PROMO_CASES`

```ts
/** 아미·제니 공통 섹션1 */
const PROMO_PRESSURE_GIF = "/promo-assets/foot2.gif"; // ← gait_project/foot2.gif

ami: {
  date: "260807",
  time: "175433",
  stem: "analyzed-1366x768-18s-29p92fps-260807-175433",
  originUpload: "/dashboard_analysis/ami_analysis/ami_origin.mp4",
  resultsBase: "/dashboard_analysis/ami_analysis/175433",
  dog: {
    name: { ko: "아미", en: "Ami" },
    breed: { ko: "저먼 셰퍼드", en: "German Shepherd" },
    weightKg: 23,
    heightCm: null,
  },
},
```

압력(섹션1)은 `resultsBase`와 무관하게 항상  
`/api/ai-results/{date}/{time}/result_pressure/{stem}_pressure.mp4` 를 쓴다.

Jenny 추가 시:

```ts
jenny: {
  date: "260807",
  time: "175517",
  stem: "analyzed-1366x768-8s-29p83fps-260807-175517",
  originUpload: "/dashboard_analysis/jenny_analysis/jenny_origin.mp4",
  pressureUrl: PROMO_PRESSURE_GIF,
  resultsBase: "/dashboard_analysis/jenny_analysis/175517",
  dog: {
    name: { ko: "제니", en: "Jenny" },
    breed: { ko: "래브라도 리트리버", en: "Labrador Retriever" },
    weightKg: 19,
    heightCm: null,
  },
},
```

- `resultsBase`가 있으면 artifacts는 `/api/ai-results/...` 대신 **로컬** 경로 사용.
- `promoArtifactUrls()`가 `result_video` / `angle_pawy` / `stride` / `cyclogram` / `derived` / `keypoints` URL을 stem 규칙으로 조립.
- 부팅 시 `?promo=<id>` → `enterReview({ pressureUrl, originalUrl, artifacts, ... })`.

### 2. `src/ui/reviewPanes.ts`

- `setPressureMedia(url)`: 확장자가 mp4/webm/ogg면 video, 아니면 img(GIF).
- `setPressureGif`는 alias로 유지.

### 3. `index.html`

- `#wsBody1`에 `#wsPressureGif` + `#wsPressureVideo` + `.ws-media-controls[data-video="wsPressureVideo"]`.
- CSS: `.ws-body.has-media > img[src], .ws-body.has-media > video[src]` 만 표시.

### 4. `vite.config.ts`

- `serve-promo-assets`: `/promo-assets/foot2.gif` → `gait_project/foot2.gif`
- `serve-dashboard-analysis` + `server.fs.allow`에 project root / `dashboard_analysis`

### 5. 배포/서비스 모드로 되돌릴 때

- **프로모 전용 분기를 쓰지 않았다면:** `?promo=` 없이 쓰면 일반 서비스 동작.
- 녹화 끝나면 URL에서 `?promo=ami`만 빼도 됨.
- 코드에서 프로모를 걷어내야 하면: `PROMO_CASES`의 ami/jenny·`pressureUrl`/`resultsBase` 경로만 정리.  
  **이 문서와 vite 로컬 서빙은 남겨 두면** 다음에 다시 꽂기 쉽다.

---

## 에이전트 작업 순서 (트리거 수신 시)

1. **이 파일**(`front_web/PROMO_RECORDING.md`)을 읽는다.
2. `dashboard_analysis/<dog>_analysis/` 존재·필수 파일(특히 mp4) 확인.
3. `PROMO_CASES`에 해당 키가 있는지 확인; 없으면 위 템플릿으로 추가.
4. 섹션1 mp4 지원·vite 서빙이 빠졌으면 복구.
5. `npm run dev` 후 `/?promo=<ami|jenny>` 로 자산 HEAD/로드 확인.
6. 사용자에게 확인 URL만 짧게 안내.

**하지 말 것:** 실제 임상 API/백엔드에 데모 mp4를 업로드·커밋하라고 강요하지 않기.  
로컬 `/dashboard_analysis` 서빙이 기본.

---

## 반려견 메타 (UI 자동 채움)

| promo id | 이름 | 견종 | 체중 |
|----------|------|------|------|
| `ami` | 아미 / Ami | 저먼 셰퍼드 | 23 kg |
| `jenny` | 제니 / Jenny | 래브라도 리트리버 | 19 kg |

`applyPromoDogInfo()`가 언어 토글에 맞춰 name/breed 채움.

---

## 레거시

이전 프로모 키 `?promo=165529` / `165613` 은 `/api/ai-results/...` + `/uploads/..._origin.mp4` 백엔드 의존.  
**신규 녹화는 `ami` / `jenny` + 로컬 `dashboard_analysis`를 쓴다.**
