/* Релационни заявки на Drizzle (`findMany`/`findFirst` с `with`), съвместими с MariaDB (Hostinger).
 *
 * Drizzle строи релациите с LEFT JOIN LATERAL (режим "default") или с производни таблици, които сочат
 * към външната заявка ("planetscale"). MySQL 8 поддържа и двете, MariaDB — нито едното. Тук основните
 * редове се четат без `with`, а всяка релация — с една заявка `WHERE ключ IN (…)`, и се закачат към
 * редовете. Резултатът е същият като на Drizzle, на MySQL и на MariaDB.
 *
 * Разлика: `limit`/`offset` вътре във `with` се прилагат след зареждането (за всеки родител), т.е. се
 * четат всички свързани редове на заредените родители. `columns` в заявки с `with` не се поддържа. */
import { and, getTableUniqueName, inArray, is, normalizeRelation, One, type Column, type Relation, type SQL } from "drizzle-orm";
import { RelationalQueryBuilder } from "drizzle-orm/mysql-core/query-builders/query";

type Row = Record<string, unknown>;
type Where = SQL | undefined | ((fields: Record<string, Column>, operators: unknown) => SQL | undefined);
type Config = { with?: Record<string, boolean | Config | undefined>; where?: Where; limit?: number; offset?: number; columns?: unknown; [k: string]: unknown };

/** Частните полета на RelationalQueryBuilder (същата сесия → работи и в транзакция). */
type Builder = {
  fullSchema: Record<string, unknown>;
  schema: Record<string, { columns: Record<string, Column>; relations: Record<string, Relation> }>;
  tableNamesMap: Record<string, string>;
  tableConfig: { tsName: string; columns: Record<string, Column>; relations: Record<string, Relation> };
  dialect: unknown;
  session: unknown;
  mode: unknown;
};
type Query = (this: Builder, config?: Config) => unknown;

/** За тестовете: брой заявки за релации и оригиналните методи на Drizzle (за сравнение на MySQL). */
export const relationalCompat = { relationQueries: 0, native: {} as { findMany?: Query; findFirst?: Query } };

const proto = RelationalQueryBuilder.prototype as unknown as { findMany: Query; findFirst: Query; __inventarCompat?: true };

function builderFor(b: Builder, tsName: string): Builder {
  const Ctor = RelationalQueryBuilder as unknown as new (...args: unknown[]) => Builder;
  return new Ctor(b.fullSchema, b.schema, b.tableNamesMap, b.fullSchema[tsName], b.schema[tsName], b.dialect, b.session, b.mode);
}

function columnKey(columns: Record<string, Column>, column: Column) {
  const key = Object.keys(columns).find((k) => columns[k] === column) ?? Object.keys(columns).find((k) => columns[k].name === column.name);
  if (!key) throw new Error(`relational-compat: колоната ${column.name} липсва`);
  return key;
}

const rowKey = (row: Row, keys: string[]) => keys.map((k) => String(row[k])).join("\u0000");

async function attach(b: Builder, rows: Row[], withConfig: NonNullable<Config["with"]>, findMany: Query) {
  for (const [name, sub] of Object.entries(withConfig)) {
    if (!sub) continue;
    const relation = b.tableConfig.relations[name];
    if (!relation) throw new Error(`relational-compat: няма релация ${b.tableConfig.tsName}.${name}`);
    const { fields, references } = normalizeRelation(b.schema as never, b.tableNamesMap, relation);
    const target = builderFor(b, b.tableNamesMap[getTableUniqueName(relation.referencedTable)]);
    const sourceKeys = fields.map((f) => columnKey(b.tableConfig.columns, f));
    const targetKeys = references.map((r) => columnKey(target.tableConfig.columns, r));
    const { limit, offset = 0, where, ...options }: Config = sub === true ? {} : sub;

    const values = [...new Set(rows.map((r) => r[sourceKeys[0]]).filter((v) => v !== null && v !== undefined))];
    let children: Row[] = [];
    if (values.length) {
      relationalCompat.relationQueries++;
      children = (await findMany.call(target, {
        ...options,
        where: (cols, ops) => and(inArray(cols[targetKeys[0]], values), typeof where === "function" ? where(cols, ops) : where),
      })) as Row[];
    }

    const groups = new Map<string, Row[]>();
    for (const child of children) {
      const key = rowKey(child, targetKeys);
      const list = groups.get(key);
      if (list) list.push(child);
      else groups.set(key, [child]);
    }
    for (const row of rows) {
      const list = groups.get(rowKey(row, sourceKeys)) ?? [];
      row[name] = is(relation, One) ? (list[0] ?? null) : list.slice(offset, limit === undefined ? undefined : offset + limit);
    }
  }
}

if (!proto.__inventarCompat) {
  const { findMany, findFirst } = proto;
  relationalCompat.native = { findMany, findFirst };
  // Без `with` — оригиналната заявка (prepare, toSQL и т.н. остават); с `with` — Promise със същия резултат.
  proto.findMany = function (this: Builder, config?: Config) {
    if (!config?.with) return findMany.call(this, config);
    const { with: withConfig, ...base } = config;
    return (async () => {
      const rows = (await findMany.call(this, base)) as Row[];
      if (rows.length) await attach(this, rows, withConfig, proto.findMany);
      return rows;
    })();
  };
  proto.findFirst = function (this: Builder, config?: Config) {
    if (!config?.with) return findFirst.call(this, config);
    const { with: withConfig, ...base } = config;
    return (async () => {
      const row = (await findFirst.call(this, base)) as Row | undefined;
      if (row) await attach(this, [row], withConfig, proto.findMany);
      return row;
    })();
  };
  proto.__inventarCompat = true;
}
