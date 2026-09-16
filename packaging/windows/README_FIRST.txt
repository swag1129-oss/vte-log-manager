VTE Log Manager v11 - Windows 배포판
====================================

랩 Dropbox와 같이 쓰기 (A222 멤버)
----------------------------------
1. ZIP 파일을 마우스 오른쪽 버튼으로 눌러 "압축 풀기"를 선택합니다.
2. INSTALL_WINDOWS.cmd를 더블클릭합니다. 바탕화면에 "VTE Log Manager" 바로가기가 생깁니다.
3. 바로가기로 앱을 열고 위쪽의 "폴더 선택"을 누릅니다.
4. Dropbox 안의 아래 폴더를 선택하고 읽기/쓰기 권한을 허용합니다.
   Dropbox > NEXT LAB > Log > A222 > VTE log > VTE_MANAGER
5. 폰에서 쓰는 웹앱(PWA)과 같은 파일을 읽고 씁니다. 폰에서 저장한 로그와 프리셋도 그대로 보입니다.

혼자 쓰기 (Dropbox 없이)
------------------------
- 압축을 푼 폴더의 START_VTE_WINDOWS.cmd를 더블클릭하고, "폴더 선택"에서 같은 폴더의 VTE_DATA를 고릅니다.
- 설치했다면 "내 문서 > VTE Log Data" 폴더를 고릅니다.

설치 위치: %LOCALAPPDATA%\VTE Log Manager
데이터 위치(혼자 쓰기): %USERPROFILE%\Documents\VTE Log Data

v9에서 바뀐 점
--------------
- Calibration/툴링 탭이 여러 재료 툴링 로그를 재료별로 정확히 읽습니다 (v10 수정 포함).
- Structure 탭에서 "프리셋으로 저장"을 누르면 Presets 폴더에 저장되고 폰 앱에서 불러올 수 있습니다.
- 폰 앱에서 저장한 로그(작성자, 시작/끝 시각, 공증착 표시 포함)를 그대로 읽습니다.
- 기존 로그 파일 형식은 그대로입니다. v9/v10으로 만든 파일을 바꿀 필요가 없습니다.

중요 사항
---------
- Microsoft Edge 또는 Google Chrome이 필요합니다. 별도의 Python 설치는 필요 없습니다.
- 인터넷 연결 없이 사용할 수 있습니다.
- Firefox에서는 폴더 읽기/쓰기 기능이 동작하지 않습니다.
- 브라우저가 폴더 접근 권한을 물으면 반드시 허용해야 저장할 수 있습니다.
- 여러 사람이 같은 파일을 동시에 편집하면 Dropbox 충돌 사본이 생길 수 있습니다.

문제 해결
---------
- 검은 창에서 파일을 찾을 수 없다고 나오면 ZIP 내부에서 바로 실행한 것입니다.
  ZIP을 완전히 압축 해제한 뒤 다시 실행하세요.
- 화면은 열리지만 Excel 기능이 안 되면 app\vendor\xlsx.full.min.js 파일이 있는지 확인하세요.
- 저장이 안 되면 앱을 다시 열고 "폴더 선택"에서 쓰기 권한을 다시 허용하세요.

배포판 정보
-----------
- VTE Log Manager: v11
- Windows 패키지 작성일: @@DATE@@
- Excel 처리 라이브러리: SheetJS Community Edition 0.20.3 (Apache-2.0)
- 제3자 라이선스: app\third_party_licenses\SheetJS_LICENSE.txt
