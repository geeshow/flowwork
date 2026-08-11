/** 라인 단위 diff — conflict 해결 화면의 좌우 비교용.
 *
 * LCS(최장 공통 부분열) 기반. 워크플로우 JSON은 수백 라인 수준이라
 * O(n·m) DP로 충분하다. 삭제/추가 연속 구간은 좌우로 짝지어(mod) 정렬한다.
 */

export interface DiffCell {
  no: number; // 1-base 라인 번호
  text: string;
}

export interface DiffRow {
  type: "same" | "del" | "add" | "mod";
  left?: DiffCell;
  right?: DiffCell;
}

export function diffLines(aText: string, bText: string): DiffRow[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS 길이 테이블
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 역추적하며 same/del/add 수집, del·add 연속 구간은 mod로 짝짓기
  const rows: DiffRow[] = [];
  let dels: DiffCell[] = [];
  let adds: DiffCell[] = [];

  const flush = () => {
    const k = Math.max(dels.length, adds.length);
    for (let x = 0; x < k; x++) {
      const left = dels[x];
      const right = adds[x];
      rows.push({
        type: left && right ? "mod" : left ? "del" : "add",
        left,
        right,
      });
    }
    dels = [];
    adds = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      rows.push({ type: "same", left: { no: i + 1, text: a[i] }, right: { no: j + 1, text: b[j] } });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels.push({ no: i + 1, text: a[i] });
      i++;
    } else {
      adds.push({ no: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) dels.push({ no: i + 1, text: a[i++] });
  while (j < m) adds.push({ no: j + 1, text: b[j++] });
  flush();

  return rows;
}
