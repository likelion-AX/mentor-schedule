// 최소 서비스워커 — PWA 설치 가능 조건 충족 (네트워크는 브라우저 기본 처리)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* pass-through: 항상 최신, 캐시 꼬임 없음 */ });
