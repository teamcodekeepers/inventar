import { asc, desc, eq, gt, type AnyColumn } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { relationalCompat } from "@/db/relational-compat";
import { categories, items, orderLines, orders, partners } from "@/db/tenant-schema";
import { applyMovement } from "@/lib/stock";
import { closeConnectionsAfterAll, createItem, createTenant, type TestTenant } from "../support/fixtures";

vi.mock("@/lib/webhooks", () => ({ emit: vi.fn() }));
closeConnectionsAfterAll();

// MySQL поддържа LATERAL, така че тук оригиналните заявки на Drizzle са еталонът: слоят за MariaDB
// трябва да връща същото.
let t: TestTenant;
const actor = { id: 1, name: "Тест" };

beforeAll(async () => {
  t = await createTenant("relcompat");
  const [{ id: tools }] = await t.db.insert(categories).values({ name: "Инструменти" }).$returningId();
  await t.db.insert(categories).values({ name: "Празна" });
  const parent = await createItem(t.db, "none", { name: "Тениска", categoryId: tools, minQuantity: 5 });
  await createItem(t.db, "none", { name: "Тениска M", parentId: parent, variantLabel: "M" });
  await createItem(t.db, "none", { name: "Тениска L", parentId: parent, variantLabel: "L" });
  const drill = await createItem(t.db, "none", { name: "Бормашина", categoryId: tools });
  await createItem(t.db, "none", { name: "Без категория" });
  for (const quantity of [3, 4, 5]) await applyMovement(t.db, { actor, itemId: drill, type: "in", quantity, locationId: t.main, unitCost: 10 });
  await applyMovement(t.db, { actor, itemId: drill, type: "out", quantity: 2, locationId: t.main });

  const [{ id: partnerId }] = await t.db.insert(partners).values({ name: "Клиент" }).$returningId();
  await t.db.insert(partners).values({ name: "Без поръчки" });
  for (const n of ["1", "2"]) {
    const [{ id: orderId }] = await t.db.insert(orders).values({ type: "sales", number: `P-${n}`, partnerId, locationId: t.main }).$returningId();
    await t.db.insert(orderLines).values([
      { orderId, itemId: drill, quantity: 1, unitPrice: 50 },
      { orderId, itemId: parent, quantity: 2, unitPrice: 20 },
    ]);
  }
});

type Cols = Record<string, AnyColumn>;
type Run = (q: { findMany: (c: object) => Promise<unknown>; findFirst: (c: object) => Promise<unknown> }) => Promise<unknown>;

/** Изпълнява заявката веднъж през слоя и веднъж с оригиналните методи на Drizzle. */
async function both(table: keyof TestTenant["db"]["query"], run: Run) {
  const builder = t.db.query[table] as never;
  const native = relationalCompat.native;
  const viaCompat = await run(builder);
  const viaNative = await run({
    findMany: (c) => native.findMany!.call(builder, c as never) as Promise<unknown>,
    findFirst: (c) => native.findFirst!.call(builder, c as never) as Promise<unknown>,
  });
  return { viaCompat, viaNative };
}

describe("релационни заявки без LATERAL (MariaDB)", () => {
  it.each<[string, keyof TestTenant["db"]["query"], Run]>([
    ["one + many", "items", (q) => q.findMany({ with: { category: true, stockLevels: true }, orderBy: [asc(items.id)] })],
    ["самореференция с име (parent/variants)", "items", (q) => q.findMany({ with: { parent: true, variants: { orderBy: [asc(items.variantLabel)] } }, orderBy: [asc(items.id)] })],
    ["many с where, orderBy и limit за всеки родител", "items", (q) => q.findMany({ with: { movements: { where: (m: Cols) => gt(m.delta, 2), orderBy: (m: Cols) => [desc(m.id)], limit: 2 } }, orderBy: [asc(items.id)] })],
    ["вложени релации", "orders", (q) => q.findMany({ with: { partner: true, lines: { with: { item: { with: { category: true } } } } }, orderBy: [asc(orders.id)] })],
    ["many на празни родители", "partners", (q) => q.findMany({ with: { orders: { with: { lines: true } } }, orderBy: [asc(partners.id)] })],
    ["findFirst", "categories", (q) => q.findFirst({ where: eq(categories.name, "Инструменти"), with: { items: { orderBy: [desc(items.id)] } } })],
    ["findFirst без резултат", "categories", (q) => q.findFirst({ where: eq(categories.name, "няма"), with: { items: true } })],
  ])("%s — същият резултат като Drizzle", async (_name, table, run) => {
    const before = relationalCompat.relationQueries;
    const { viaCompat, viaNative } = await both(table, run);
    expect(viaCompat).toEqual(viaNative);
    if (viaNative) expect(relationalCompat.relationQueries).toBeGreaterThan(before);
  });

  it("работи в транзакция (tx.query)", async () => {
    const before = relationalCompat.relationQueries;
    const order = await t.db.transaction((tx) => tx.query.orders.findFirst({ where: eq(orders.number, "P-1"), with: { lines: { with: { item: true } } } }));
    expect(order?.lines).toHaveLength(2);
    expect(order?.lines.every((l) => l.item?.id === l.itemId)).toBe(true);
    expect(relationalCompat.relationQueries).toBeGreaterThan(before);
  });
});
