import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./control-schema";
import "./relational-compat"; // `with` без LATERAL — за MariaDB

/**
 * Сесиите на MySQL в UTC. mysql2 чете датите като UTC (timezone: "Z"), а стойностите по подразбиране
 * (CURRENT_TIMESTAMP) иначе са в часовата зона на сървъра.
 */
export function utcSessions(pool: mysql.Pool) {
  pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
}

const url = process.env.CONTROL_DATABASE_URL ?? "mysql://root:root@localhost:3307/inventory_control";

const g = globalThis as unknown as { __controlPool?: mysql.Pool };
const pool = g.__controlPool ?? mysql.createPool({ uri: url, connectionLimit: 10, timezone: "Z", charset: "utf8mb4_0900_ai_ci" });
// Един пул за процеса (и при HMR в dev, и между отделните бъндъли в production, напр. instrumentation).
if (!g.__controlPool) utcSessions(pool);
g.__controlPool = pool;

/** Контролна база: организации, потребители, сесии. */
export const controlDb = drizzle(pool, { schema, mode: "default" });
export type ControlDb = typeof controlDb;
