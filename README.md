# AI 음원 검수/선곡 도구 - GitHub Pages 정적 버전

이 폴더는 그대로 GitHub Pages에 업로드해서 쓰는 정적 웹 앱입니다. 서버 프로그램, Python, Node API, 데이터베이스가 필요 없습니다.

## 배포

GitHub 저장소에 이 폴더의 내용을 업로드한 뒤 GitHub Pages를 켜면 됩니다.

필수 파일:

- `index.html`
- `styles.css`
- `app.js`
- `vendor/*`
- `models/*`
- `.nojekyll`

GitHub Pages는 HTTPS로 제공되므로 Chrome/Edge에서 브라우저 폴더 마운트 기능을 사용할 수 있습니다.

## 동작 방식

1. `음원 폴더 마운트`로 mp3/wav/flac/m4a/ogg/aiff 폴더를 선택합니다.
2. `Suno txt 폴더 마운트`로 Suno txt 폴더를 선택합니다.
3. 앱이 같은 파일명 규칙의 `음원파일명.txt`를 자동 매칭합니다.
4. `미분석 분석`을 누르면 브라우저 안에서 Essentia wasm으로 BPM/Key를 분석합니다.
5. 분석 결과, 검수 판정, 별점, 메모, 대기열은 `JSON 내려받기`로 저장합니다.
6. 나중에 다시 접속하면 JSON을 업로드하고 폴더를 다시 마운트하면 같은 파일 ID에 상태가 복원됩니다.
7. `내보내기 폴더 마운트` 후 `마운트한 폴더로 대기열 복사`를 누르면 선택곡을 번호 붙여 복사합니다.

## 저장 정책

브라우저 보안 정책상 폴더 핸들과 실제 로컬 경로 문자열은 JSON에 저장하지 않습니다.

JSON에 저장되는 데이터:

- `analysisCache`: BPM, Key, Camelot, MusicNN 태그, 분석 시각
- `reviews`: 판정, 별점, 메모, 사용자 태그
- `queue`: 대기열 순서
- `trackSnapshots`: 파일명/상대 경로/크기/수정일 기반 스냅샷

트랙 ID는 `상대경로 + 파일명 + 파일크기 + 수정일`의 SHA-1입니다. 같은 폴더와 같은 파일을 다시 마운트하면 분석 캐시를 재사용합니다.

## 로컬 테스트

`file://`로 직접 열면 wasm/model fetch가 막힐 수 있습니다. 로컬 테스트는 이 폴더에서 간단한 정적 서버로 확인하세요.

```powershell
python -m http.server 8891
```

브라우저에서 `http://127.0.0.1:8891/`로 접속하면 됩니다. `localhost`/`127.0.0.1`은 브라우저 폴더 API가 허용되는 secure context 예외입니다.

## 브라우저

권장:

- Chrome
- Edge

Safari/Firefox는 File System Access API 지원이 제한될 수 있습니다.
