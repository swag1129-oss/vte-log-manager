# VTE Log Manager 모바일(PWA) 계획서 — 초안

상태: 구현 중 (2026-09-16 사용자 지시). 단계마다 사용자 확인 후 다음 단계 진행.
- 1단계 완료 2026-09-16: core 분리, PC v11 빌드, v10과 결과 동일 검증 (전체 데이터 스냅샷 IDENTICAL, 쓰기 동등성, 렌더링 DOM 동일). 사용자 확인 완료
- 2단계 완료 2026-09-17: 읽기 전용 PWA (Dropbox PKCE 로그인, IndexedDB 캐시, 로그 열람, calibration 조회+모니터 두께 계산), GitHub Pages 배포. 실기기(폰) 로그인·동기화 확인 완료 2026-09-17 (Dropbox scope 누락은 Submit 후 재로그인으로 해결)
작성: 2026-09-16

## 확정된 결정
- 형태: PWA(웹앱). iOS, Android, PC 브라우저에서 같은 코드로 동작
- 호스팅: GitHub Pages (사용자 GitHub 계정). 별도 서버 없음
- Dropbox: 랩 공용 계정 1개. 권한은 Full Dropbox (2026-09-16 변경: 랩 멤버만 쓰므로 전체 권한 허용). 데이터 이동 없음
- 작성자: 앱 설치(첫 실행) 때 이름을 입력해 기기에 저장. 설정에서 변경 가능
- 모바일 기능: 증착/툴링 로그 입력, calibration 조회, 로그 열람, **증착 구조 프리셋**
- 모바일에서 제외: Structure 계산(PC 전용 유지)
- 프리셋: PC와 모바일 모두 생성·편집 가능 (2026-09-16 결정)
- 과거 로그: 모바일에서도 수정 가능. 저장 시 rev 확인, 수정자·수정시각 메타 기록. 이전 버전은 Dropbox 버전 기록으로 복구 (2026-09-16 결정)
- GitHub 저장소: 공개 (2026-09-16 결정)

## 데이터 위치
- 현재 위치 그대로: `Dropbox/NEXT LAB/Log/A222/VTE log/VTE_MANAGER/` (`Process_General`, `Process_Tooling`, `Calibration`, `Structures`)
- 새로 `VTE_MANAGER/Presets/` 추가
- 앱 설정에 루트 경로 1개를 저장. 코드는 이 경로 밖의 읽기·쓰기를 막음(실수로 다른 폴더 건드리는 것 방지)
- PC 앱은 지금처럼 같은 폴더 선택

## 프리셋
- 기존 Structure 파일 열이 프리셋에 필요한 정보와 같음
  - 열: `mode, mat1, src1, tf1, vol1, mat2..3, thick, rate, mask`
- 따라서 프리셋 = `Presets/<이름>.xlsx`, Structure와 같은 양식
- PC에서 만든 Structure 파일을 "프리셋으로 복사"할 수 있음
- 모바일 흐름: 프리셋 선택 → 레이어 목록 자동 생성(재료·소스·TF·마스크·목표두께·레이트, 공증착 비율 포함) → 최신 calibration ratio로 필요한 모니터 두께 자동 계산 → 레이어마다 실제 측정값만 입력
- 프리셋 관리: PC와 모바일 모두에서 생성, 편집, 삭제, "현재 로그를 프리셋으로 저장" 지원. 저장 시 rev 확인

## 모바일 화면
1. 첫 실행: Dropbox 로그인(PKCE), 작성자 이름 입력
2. 홈: 새 로그(빈 로그 / 프리셋에서), 이어쓰기(업로드 안 된 초안), 최근 로그
3. 로그 입력: 레이어 카드를 한 장씩 표시
   - Start: 압력·파워·온도·레이트, 시간 자동 기록
   - End: 압력·파워·온도, 모니터 두께
   - 공증착은 재료별 칸
   - 툴링 로그는 실측 두께 칸(나중에 입력 가능)
4. 업로드: v10 양식 xlsx 생성 → rev 확인 후 저장
5. Calibration 조회: 재료 → TF/소스별 최신 ratio와 이력, 실측 추가 입력
6. 로그 열람: 날짜·재료 검색, 상세 보기

## 파일 양식 변경점(v11)
- 메타 칸 추가(1행 W열 이후, 파서에 영향 없는 위치): `Author`, `Device`, `Created At`, `App` (PC/Mobile + 버전), `Preset`
- 새 파일명에 시간 추가: `재료목록_general_v11_HHMM.xlsx` (같은 날 같은 재료 충돌 방지)
- 레이어 Start/End 시각 기록 칸 추가(W열 이후)
- 기존 v7/v9/v10/fromExcel 파일 읽기는 그대로 유지

## 코드 구조
- `core/`: 파싱, calibration, xlsx 생성, 프리셋 (v10 로직 추출)
- `storage/`: `LocalFolderAdapter`(PC, File System Access), `DropboxAdapter`(모바일/PC 공통)
- `ui/desktop`, `ui/mobile`
- 서비스 워커(앱 캐시), IndexedDB(파일 캐시, 초안, 업로드 대기열)

## 동기화 / 충돌
- 첫 실행 때 전체 목록과 xlsx를 받아 캐시. 이후에는 `list_folder/continue` 커서로 변경분만 받음
- 저장: 기존 파일은 `update` 모드 + rev로 저장하고, 충돌 시 "다른 이름으로 저장 / 비교"를 띄움. 새 파일은 `add` 모드(자동 이름변경 금지)
- 오프라인: 초안은 기기에 저장, 업로드는 대기열에 넣었다가 온라인이 되면 재시도하고 결과를 알림

## 보안
- Full Dropbox 권한: 기기 분실 시 해당 토큰으로 랩 Dropbox 전체 접근 가능(랩 멤버 사용 전제로 수용). 앱 코드에서 VTE_MANAGER 경로 밖 접근 차단
- 기기 분실 시 Dropbox 설정에서 앱 연결 해제 → 모든 기기 재로그인 필요(공용 계정이라 기기별 해제 불가)
- 앱 키는 공개돼도 되는 값. 비밀키 없음

## 검증 계획
- core 분리 전후 결과 동일: 기존 테스트 2개 + 전체 데이터 스캔 결과를 스냅샷으로 비교
- Dropbox 어댑터: 목록/다운로드/업로드/rev 충돌/오프라인 대기열 모의 테스트
- 실기기: iPhone Safari(홈 화면 추가), Android Chrome, PC Chrome
- 모바일에서 저장한 파일이 PC v11에서 똑같이 읽히는지 왕복 테스트

## 단계 (각 단계 끝에 사용자 확인)
0. 사용자 작업: Dropbox 개발자 앱 등록(Full Dropbox, 랩 계정), GitHub 공개 저장소 생성
1. core 분리 + PC v11 + 동일성 검증
2. 읽기 전용 PWA(로그 열람, calibration 조회) 실기기 테스트
3. 입력, 초안, 업로드, rev 충돌, 프리셋
4. 오프라인 대기열, Windows 배포판, 매뉴얼, 멤버 안내

## 남은 질문
- 없음 (구현 지시 대기)
