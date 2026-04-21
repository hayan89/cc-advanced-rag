import { describe, test, expect } from "bun:test";
import { extractFeatureTags } from "./features.ts";

describe("extractFeatureTags", () => {
  test("빈 입력 → 빈 배열", () => {
    expect(extractFeatureTags("postgres", "")).toEqual([]);
  });

  test("postgres plpgsql + dollar-quoted + returning", () => {
    const src = `CREATE FUNCTION f() RETURNS TABLE(x INT) AS $$ BEGIN RETURN QUERY SELECT 1 RETURNING *; END $$ LANGUAGE plpgsql;`;
    const tags = extractFeatureTags("postgres", src);
    expect(tags).toContain("sql-feature:plpgsql");
    expect(tags).toContain("sql-feature:dollar-quoted");
    expect(tags).toContain("sql-feature:returning");
  });

  test("postgres jsonb + uuid + serial", () => {
    const src = `CREATE TABLE users (id UUID PRIMARY KEY, counter BIGSERIAL, data JSONB);`;
    const tags = extractFeatureTags("postgres", src);
    expect(tags).toContain("sql-feature:uuid");
    expect(tags).toContain("sql-feature:serial");
    expect(tags).toContain("sql-feature:jsonb");
  });

  test("mysql engine-innodb + auto-increment", () => {
    const src = `CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255)) ENGINE=InnoDB CHARACTER SET utf8mb4;`;
    const tags = extractFeatureTags("mysql", src);
    expect(tags).toContain("sql-feature:engine-innodb");
    expect(tags).toContain("sql-feature:auto-increment");
    expect(tags).toContain("sql-feature:charset-utf8mb4");
  });

  test("sqlite without-rowid + autoincrement", () => {
    const src = `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT) WITHOUT ROWID;`;
    const tags = extractFeatureTags("sqlite", src);
    expect(tags).toContain("sql-feature:autoincrement");
    expect(tags).toContain("sql-feature:without-rowid");
  });

  test("mssql identity + nvarchar + bracket-ident", () => {
    const src = `CREATE TABLE [dbo].[users] (id INT IDENTITY(1,1), name NVARCHAR(50));`;
    const tags = extractFeatureTags("mssql", src);
    expect(tags).toContain("sql-feature:identity");
    expect(tags).toContain("sql-feature:nvarchar");
    expect(tags).toContain("sql-feature:bracket-ident");
  });

  test("공통 feature: foreign-key + unique + check", () => {
    const src = `CREATE TABLE orders (
      id INT PRIMARY KEY,
      user_id INT REFERENCES users(id),
      code TEXT UNIQUE,
      qty INT CHECK (qty > 0)
    );`;
    const tags = extractFeatureTags("ansi", src);
    expect(tags).toContain("sql-feature:foreign-key");
    expect(tags).toContain("sql-feature:unique");
    expect(tags).toContain("sql-feature:check");
  });

  test("최대 8개로 cap", () => {
    const src = `CREATE TABLE t (id UUID, data JSONB, counter SERIAL) PARTITION BY RANGE (id);
      CREATE EXTENSION foo;
      USING gin (data);
      GENERATED ALWAYS AS (1) STORED;
      RETURNING *;
      CREATE TRIGGER tr ON t AFTER INSERT;`;
    const tags = extractFeatureTags("postgres", src);
    expect(tags.length).toBeLessThanOrEqual(8);
  });
});
