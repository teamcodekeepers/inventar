import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Тестовете вървят срещу истински MySQL с отделна контролна база и отделен префикс за клиентските
 * бази, така че никога не докосват данните за разработка.
 *
 *   TEST_DATABASE_URL  mysql://user:pass@host:port — сървър и потребител с право CREATE/DROP DATABASE
 *                      (по подразбиране: сървърът от CONTROL_DATABASE_URL в .env)
 *   TEST_DB_PREFIX     префикс на тестовите бази (по подразбиране inv_test_)
 */
try {
  process.loadEnvFile(".env");
} catch {
  // без .env: всичко идва от средата (CI)
}

const server = new URL(process.env.TEST_DATABASE_URL ?? process.env.CONTROL_DATABASE_URL ?? "mysql://root:root@localhost:3306");
server.pathname = "";
const prefix = process.env.TEST_DB_PREFIX ?? "inv_test_";
const admin = server.toString().replace(/\/$/, "");

const env = {
  NODE_ENV: "test" as const,
  CONTROL_DATABASE_URL: `${admin}/${prefix}control`,
  TENANT_DB_ADMIN_URL: admin,
  TENANT_DB_PREFIX: prefix,
  TENANT_DB_MODE: "auto",
  APP_DOMAIN: "inventar.test",
  DEMO_TENANT: "",
  APP_PROTOCOL: "https",
  APP_SECRET: "test-secret-not-for-production",
  SMTP_HOST: "",
  STORAGE_DIR: path.resolve("node_modules/.cache/test-storage"),
};
Object.assign(process.env, env); // и за globalSetup, който върви в главния процес

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve("src"),
      // server-only хвърля извън React Server Components; в тестовете е празен модул.
      "server-only": path.resolve("tests/support/empty.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    env,
    pool: "forks",
    // всеки файл създава и мигрира своя база; повече паралелни миграции претоварват MySQL
    maxWorkers: 6,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
