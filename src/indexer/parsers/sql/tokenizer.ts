/**
 * SQL statement tokenizer — pure, linear-time, state-based scanner.
 *
 * 한 패스로 `;` (그리고 MSSQL dialect 감지 시 `GO` 줄)을 statement 경계로 잘라
 * `{ text, startLine, endLine, separator }[]`를 반환한다.
 *
 * 안전성:
 * - 모든 스캔은 선형 시간 (nested quantifier 없음, regex도 쓰지 않음).
 * - 빈 입력 → 빈 배열.
 * - soft time-cap 초과 시 조기 종료 (`timedOut=true` 반환).
 */

export interface SqlStatement {
  text: string;
  startLine: number; // 1-based
  endLine: number;
  /** true: `GO` 구분자로 끊김 (MSSQL), false: `;` 혹은 파일 끝 */
  goSeparated: boolean;
}

export interface TokenizeResult {
  statements: SqlStatement[];
  /** `GO` 배치 구분자를 1회라도 만났는가 (MSSQL 힌트) */
  sawGoBatch: boolean;
  /** `DELIMITER` 지시문을 1회라도 만났는가 (MySQL 힌트) */
  sawDelimiter: boolean;
  /** tokenize가 time-cap으로 조기 종료됐는가 */
  timedOut: boolean;
}

export interface TokenizeOptions {
  /** MSSQL dialect 확정 시에만 `^GO$` 줄을 경계로 사용. 미확정이면 감지만 하고 끊지는 않음. */
  enableGoSeparator?: boolean;
  /** soft time-cap. scan 루프 반복마다 체크하지 않고, 대략 1K문자마다 점검. 기본 200ms. */
  timeCapMs?: number;
}

const DEFAULT_TIME_CAP_MS = 200;

/** 줄 전체(앞뒤 공백 제외)가 `GO`(대소문자 무시)인지. */
function isGoLine(line: string): boolean {
  const t = line.trim();
  if (t.length !== 2) return false;
  return (t.charCodeAt(0) | 0x20) === 0x67 /* g */ && (t.charCodeAt(1) | 0x20) === 0x6f /* o */;
}

/** 해당 위치의 dollar-tag를 읽는다: `$$` 또는 `$ident$`. 매칭 안 되면 null. */
function readDollarTag(src: string, i: number): string | null {
  if (src.charCodeAt(i) !== 0x24 /* $ */) return null;
  let j = i + 1;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    // tag body: [A-Za-z0-9_]
    const isIdent =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f;
    if (isIdent) {
      j++;
      continue;
    }
    if (c === 0x24) {
      // $tag$ (tag 가능 길이 0 → `$$`)
      return src.slice(i, j + 1);
    }
    return null;
  }
  return null;
}

/** `DELIMITER <token>` 지시문을 현재 줄에서 읽어 새 구분자를 반환. 매칭 안 되면 null. */
function parseDelimiterDirective(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 10) return null;
  // 대소문자 무시로 "delimiter" prefix 확인 (선형 비교, regex 없음)
  const head = trimmed.slice(0, 9).toLowerCase();
  if (head !== "delimiter") return null;
  const rest = trimmed.slice(9).trim();
  if (rest.length === 0) return null;
  // 첫 공백 전까지를 구분자로 취급
  const end = rest.search(/\s/);
  const delim = end === -1 ? rest : rest.slice(0, end);
  return delim.length > 0 ? delim : null;
}

/** 주어진 위치부터 `delim` 문자열이 그대로 나타나는지. */
function matchAt(src: string, i: number, pat: string): boolean {
  if (pat.length === 0) return false;
  if (i + pat.length > src.length) return false;
  for (let k = 0; k < pat.length; k++) {
    if (src.charCodeAt(i + k) !== pat.charCodeAt(k)) return false;
  }
  return true;
}

export function tokenizeSql(source: string, opts: TokenizeOptions = {}): TokenizeResult {
  const result: TokenizeResult = {
    statements: [],
    sawGoBatch: false,
    sawDelimiter: false,
    timedOut: false,
  };
  if (source.length === 0) return result;

  const timeCapMs = opts.timeCapMs ?? DEFAULT_TIME_CAP_MS;
  const deadline = Date.now() + timeCapMs;
  const enableGo = opts.enableGoSeparator ?? true;

  // 현재 statement 누적 상태
  let chunkStart = 0;
  let chunkStartLine = 1;
  let line = 1;
  // DELIMITER 지시문으로 변경 가능한 기본 구분자
  let delimiter: string = ";";

  const len = source.length;
  let i = 0;
  let nextTimeCheck = 1024;

  while (i < len) {
    // 주기적 time-cap 체크
    if (i >= nextTimeCheck) {
      if (Date.now() > deadline) {
        result.timedOut = true;
        // 남은 내용을 버리고 현재까지만 반환 (안정성 우선)
        break;
      }
      nextTimeCheck = i + 4096;
    }

    const c = source.charCodeAt(i);

    // 줄 시작 감지 — DELIMITER / GO 라인 처리
    if (i === 0 || source.charCodeAt(i - 1) === 0x0a /* \n */) {
      // 현재 줄 추출 (\n 또는 EOF 까지)
      let lineEnd = source.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = len;
      const curLine = source.slice(i, lineEnd);

      // GO batch separator
      if (isGoLine(curLine)) {
        result.sawGoBatch = true;
        if (enableGo) {
          // 현재까지 누적된 statement를 flush
          const text = source.slice(chunkStart, i).trim();
          if (text.length > 0) {
            result.statements.push({
              text,
              startLine: chunkStartLine,
              endLine: line,
              goSeparated: true,
            });
          }
          // GO 라인 자체를 건너뜀
          i = lineEnd + (lineEnd < len ? 1 : 0);
          line++;
          chunkStart = i;
          chunkStartLine = line;
          continue;
        }
      }

      // DELIMITER 지시문
      const newDelim = parseDelimiterDirective(curLine);
      if (newDelim !== null) {
        result.sawDelimiter = true;
        // 지시문 직전까지 누적 flush (DELIMITER 자체는 내보내지 않음)
        const text = source.slice(chunkStart, i).trim();
        if (text.length > 0) {
          result.statements.push({
            text,
            startLine: chunkStartLine,
            endLine: line,
            goSeparated: false,
          });
        }
        delimiter = newDelim;
        i = lineEnd + (lineEnd < len ? 1 : 0);
        line++;
        chunkStart = i;
        chunkStartLine = line;
        continue;
      }
    }

    // 줄바꿈 카운트
    if (c === 0x0a /* \n */) {
      line++;
      i++;
      continue;
    }

    // -- line comment
    if (c === 0x2d /* - */ && i + 1 < len && source.charCodeAt(i + 1) === 0x2d) {
      const nl = source.indexOf("\n", i + 2);
      if (nl === -1) {
        i = len;
      } else {
        i = nl; // \n 자체는 위 케이스에서 처리
      }
      continue;
    }

    // /* block comment */ (중첩 허용)
    if (c === 0x2f /* / */ && i + 1 < len && source.charCodeAt(i + 1) === 0x2a /* * */) {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        const cc = source.charCodeAt(i);
        if (cc === 0x0a) line++;
        if (cc === 0x2f && i + 1 < len && source.charCodeAt(i + 1) === 0x2a) {
          depth++;
          i += 2;
          continue;
        }
        if (cc === 0x2a && i + 1 < len && source.charCodeAt(i + 1) === 0x2f) {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }

    // 'single quote' string (SQL standard: '' escape)
    if (c === 0x27 /* ' */) {
      i++;
      while (i < len) {
        const cc = source.charCodeAt(i);
        if (cc === 0x0a) line++;
        if (cc === 0x27) {
          if (i + 1 < len && source.charCodeAt(i + 1) === 0x27) {
            // '' escape
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // "double quote" identifier (standard) with "" escape
    if (c === 0x22 /* " */) {
      i++;
      while (i < len) {
        const cc = source.charCodeAt(i);
        if (cc === 0x0a) line++;
        if (cc === 0x22) {
          if (i + 1 < len && source.charCodeAt(i + 1) === 0x22) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // `backtick` identifier (MySQL) with `` escape
    if (c === 0x60 /* ` */) {
      i++;
      while (i < len) {
        const cc = source.charCodeAt(i);
        if (cc === 0x0a) line++;
        if (cc === 0x60) {
          if (i + 1 < len && source.charCodeAt(i + 1) === 0x60) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // [bracket] identifier (MSSQL) with ]] escape; never spans lines meaningfully
    if (c === 0x5b /* [ */) {
      i++;
      while (i < len) {
        const cc = source.charCodeAt(i);
        if (cc === 0x0a) line++;
        if (cc === 0x5d /* ] */) {
          if (i + 1 < len && source.charCodeAt(i + 1) === 0x5d) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // $tag$ ... $tag$ (PostgreSQL)
    if (c === 0x24 /* $ */) {
      const tag = readDollarTag(source, i);
      if (tag) {
        i += tag.length;
        // 동일 tag 재등장까지 스캔
        while (i < len) {
          const cc = source.charCodeAt(i);
          if (cc === 0x0a) line++;
          if (cc === 0x24 && matchAt(source, i, tag)) {
            i += tag.length;
            break;
          }
          i++;
        }
        continue;
      }
      // 단순 $ 기호는 그냥 소비
      i++;
      continue;
    }

    // delimiter 매칭 (일반적으로 ';' 1글자, DELIMITER로 변경 시 다중 문자 가능)
    if (c === delimiter.charCodeAt(0) && matchAt(source, i, delimiter)) {
      const text = source.slice(chunkStart, i).trim();
      if (text.length > 0) {
        result.statements.push({
          text,
          startLine: chunkStartLine,
          endLine: line,
          goSeparated: false,
        });
      }
      i += delimiter.length;
      // 공백/줄바꿈 skip해서 다음 chunk 시작 위치 잡기
      while (i < len) {
        const cc = source.charCodeAt(i);
        if (cc === 0x20 || cc === 0x09 /* tab */ || cc === 0x0d /* \r */) {
          i++;
          continue;
        }
        if (cc === 0x0a) {
          line++;
          i++;
          continue;
        }
        break;
      }
      chunkStart = i;
      chunkStartLine = line;
      continue;
    }

    i++;
  }

  // 잔여 내용 flush
  if (chunkStart < len && !result.timedOut) {
    const text = source.slice(chunkStart).trim();
    if (text.length > 0) {
      result.statements.push({
        text,
        startLine: chunkStartLine,
        endLine: line,
        goSeparated: false,
      });
    }
  }

  return result;
}
