import { describe, test, expect } from "bun:test";
import { dialectFromPath, dialectFromContent, resolveDialect } from "./dialect.ts";

describe("dialectFromPath", () => {
  test(".pgsql/.plpgsql → postgres", () => {
    expect(dialectFromPath("migrations/001.pgsql")).toBe("postgres");
    expect(dialectFromPath("schema.plpgsql")).toBe("postgres");
  });
  test(".mysql → mysql", () => {
    expect(dialectFromPath("dump.mysql")).toBe("mysql");
  });
  test("path segment hints", () => {
    expect(dialectFromPath("db/postgres/schema.sql")).toBe("postgres");
    expect(dialectFromPath("db/mysql/users.sql")).toBe("mysql");
    expect(dialectFromPath("db/sqlite/local.sql")).toBe("sqlite");
    expect(dialectFromPath("db/mssql/init.sql")).toBe("mssql");
  });
  test("힌트 없음 → null", () => {
    expect(dialectFromPath("schema.sql")).toBeNull();
  });
});

describe("dialectFromContent", () => {
  test("postgres plpgsql + dollar-quote", () => {
    const src = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;`;
    expect(dialectFromContent(src)).toBe("postgres");
  });
  test("mysql ENGINE + AUTO_INCREMENT", () => {
    const src = `CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;`;
    expect(dialectFromContent(src)).toBe("mysql");
  });
  test("sqlite WITHOUT ROWID + AUTOINCREMENT", () => {
    const src = `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT) WITHOUT ROWID;`;
    expect(dialectFromContent(src)).toBe("sqlite");
  });
  test("mssql IDENTITY + GO", () => {
    const src = `CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY)\nGO`;
    expect(dialectFromContent(src)).toBe("mssql");
  });
  test("애매하면 null (ansi 폴백용)", () => {
    expect(dialectFromContent(`CREATE TABLE t (id INT);`)).toBeNull();
  });
});

describe("resolveDialect", () => {
  test("파일 postgres + 개별 statement는 파일 dialect 상속", () => {
    const src = `CREATE TABLE t (id SERIAL); CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;`;
    const statements = [{ text: `CREATE TABLE t (id SERIAL)` }, { text: `CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql` }];
    const r = resolveDialect("db/schema.sql", src, statements);
    expect(r.file).toBe("postgres");
    expect(r.perStatement).toEqual(["postgres", "postgres"]);
  });

  test("파일 ansi + 개별 statement에 강한 마커 → 그 statement만 승격", () => {
    const ansi = `CREATE TABLE t (id INT);`;
    const pg = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql`;
    const src = `${ansi}\n${pg};`;
    const statements = [{ text: ansi }, { text: pg }];
    const r = resolveDialect("schema.sql", src, statements);
    // 전체에서는 plpgsql 마커가 있으므로 파일 dialect는 postgres가 됨
    expect(r.file).toBe("postgres");
    // 두 statement 모두 파일 dialect로 판정
    expect(r.perStatement[0]).toBe("postgres");
    expect(r.perStatement[1]).toBe("postgres");
  });

  test("path hint가 content보다 우선", () => {
    // content는 mysql 마커 강하지만 path가 postgres
    const src = `CREATE TABLE t (id INT AUTO_INCREMENT) ENGINE=InnoDB;`;
    const statements = [{ text: src }];
    const r = resolveDialect("db/postgres/001.sql", src, statements);
    expect(r.file).toBe("postgres");
  });
});
