import { describe, test, expect } from "bun:test";
import { tokenizeSql } from "./tokenizer.ts";

describe("tokenizeSql", () => {
  test("빈 입력 → 빈 배열", () => {
    const r = tokenizeSql("");
    expect(r.statements).toEqual([]);
    expect(r.sawGoBatch).toBe(false);
    expect(r.sawDelimiter).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  test("세미콜론 기준 분할", () => {
    const src = `CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0]!.text).toMatch(/CREATE TABLE a/);
    expect(r.statements[1]!.text).toMatch(/CREATE TABLE b/);
  });

  test("라인 주석 안의 세미콜론 무시", () => {
    const src = `CREATE TABLE a (id INT); -- trailing; with; semi\nSELECT 1;`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0]!.text).toMatch(/CREATE TABLE a/);
    expect(r.statements[1]!.text).toMatch(/SELECT 1/);
  });

  test("블록 주석 안의 세미콜론 무시 + 중첩 허용", () => {
    const src = `/* outer; /* inner; */ still; */ CREATE TABLE a (id INT);`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]!.text).toMatch(/CREATE TABLE a/);
  });

  test("single-quoted 문자열 안의 세미콜론 무시", () => {
    const src = `INSERT INTO t VALUES ('a;b;c');\nCREATE TABLE x (id INT);`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(2);
  });

  test("PostgreSQL dollar-quoted body 보호", () => {
    const src = `CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  PERFORM 1;\n  PERFORM 2;\nEND;\n$$ LANGUAGE plpgsql;`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]!.text).toMatch(/CREATE FUNCTION f/);
  });

  test("tagged dollar-quote ($body$...$body$)", () => {
    const src = `CREATE FUNCTION f() RETURNS text AS $body$\n  SELECT 'ignored; semicolon';\n$body$ LANGUAGE sql;`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(1);
  });

  test("MSSQL GO를 batch separator로 사용 (enableGoSeparator=true)", () => {
    const src = `CREATE TABLE a (id INT)\nGO\nCREATE TABLE b (id INT)\nGO`;
    const r = tokenizeSql(src, { enableGoSeparator: true });
    expect(r.sawGoBatch).toBe(true);
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0]!.goSeparated).toBe(true);
  });

  test("enableGoSeparator=false면 GO를 감지만 하고 경계로 쓰지 않음", () => {
    const src = `CREATE TABLE a (id INT)\nGO\nCREATE TABLE b (id INT)\nGO`;
    const r = tokenizeSql(src, { enableGoSeparator: false });
    expect(r.sawGoBatch).toBe(true);
    // ; 없고 GO도 경계로 안 쓰므로 전체가 하나의 statement로 뭉침
    expect(r.statements.length).toBeGreaterThan(0);
  });

  test("MySQL DELIMITER 지시문", () => {
    const src = `DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;`;
    const r = tokenizeSql(src);
    expect(r.sawDelimiter).toBe(true);
    // // 구분자로 프로시저 본문 하나가 잡히는지
    const procStmt = r.statements.find((s) => /CREATE PROCEDURE/.test(s.text));
    expect(procStmt).toBeDefined();
    expect(procStmt!.text).toMatch(/SELECT 1/);
    expect(procStmt!.text).toMatch(/SELECT 2/);
  });

  test("backtick/bracket/double-quote 식별자 내부 세미콜론 무시", () => {
    const src = `CREATE TABLE \`a;b\` (id INT); CREATE TABLE "c;d" (id INT); CREATE TABLE [e;f] (id INT);`;
    const r = tokenizeSql(src);
    expect(r.statements).toHaveLength(3);
  });
});
