/**
 * 도메인 전용 색상.
 *
 * 임의의 색을 허용한다(네이티브 컬러 피커). 색은 "배경"이 아니라 작업 영역의
 * 테두리와 작업명 앞 불릿에만 쓰므로, 어떤 색을 골라도 글자 가독성에는 영향이 없다.
 * 아래 PRESET_COLORS는 빠른 선택을 위한 기본 팔레트일 뿐, 강제는 아니다.
 */
export const PRESET_COLORS = [
  "#4c8dff",
  "#35c07f",
  "#f2b544",
  "#f0616d",
  "#a986ff",
  "#2fb8c6",
  "#ff77c8",
  "#8b97a6",
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHex(color: string): boolean {
  return HEX.test(color);
}

/** 아직 색을 지정하지 않은 도메인용 결정적 기본 색상. */
export function fallbackColor(domain: string): string {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return PRESET_COLORS[h % PRESET_COLORS.length];
}

/** 도메인 → 색상 매핑을 받아 색을 돌려준다 (미지정이면 fallback). */
export function colorForDomain(domain: string, colors: Record<string, string>): string {
  const c = colors[domain];
  return c && isValidHex(c) ? c : fallbackColor(domain);
}
