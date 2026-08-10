/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// 퍼센트 인코딩이 깨진 URL(예: /apic/%EC%82… 가 잘려 %E 로 끝나는 경우)은 vite 내부
// 미들웨어가 decodeURI에서 던져 500 "URI malformed" 페이지가 뜬다. 한글 경로
// (/apic/사내%20API, /t/계좌/… 등)를 수동 입력하다 깨지는 사고를 홈 리다이렉트로 흡수한다.
function malformedUriGuard(): Plugin {
  return {
    name: "malformed-uri-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        try {
          decodeURI(req.url ?? "");
          next();
        } catch {
          res.statusCode = 302;
          res.setHeader("Location", "/");
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [malformedUriGuard(), react()],
  server: {
    port: 5173,
    proxy: {
      // 프론트 dev 서버 → FastAPI 백엔드 (/api/ 하위만 — /apic 등 SPA 경로 제외)
      "^/api/": "http://localhost:8000",
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
