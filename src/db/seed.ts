/* Демонстрационни данни.  pnpm db:seed
   Създава: организация demo (demo.<APP_DOMAIN>, база inv_demo) и vtora (празна).
   Вход: admin@demo.bg / demo1234 (собственик), sklad@demo.bg / demo1234 (служител)
   TENANT_DB_MODE=manual (споделен хостинг): само demo, в свободна база от пула — веднъж, върху празни бази. */
import { addDays, format, subDays } from "date-fns";
import { eq, isNotNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "node:path";
import { hashPassword } from "../lib/auth-crypto";
import { controlDb } from "./control";
import { databasePool, memberships, organizations, plans, users } from "./control-schema";
import { dropTenantDatabase, getTenantDb, provisionTenant, tenantDbName, type TenantDb } from "./tenant";
import * as t from "./tenant-schema";

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const today = new Date();
// без CREATE/DROP DATABASE: базите идват от пула и се пазят
const manual = process.env.TENANT_DB_MODE === "manual";

async function resetControl() {
  await migrate(controlDb, { migrationsFolder: path.join(process.cwd(), "drizzle", "control") });
  if (manual) {
    const [used] = await controlDb.select({ id: databasePool.id }).from(databasePool).where(isNotNull(databasePool.assignedOrganizationId)).limit(1);
    if (used) throw new Error("В пула вече има заета база. В режим manual демо данните се зареждат само веднъж, върху празни бази.");
  }
  await controlDb.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  const tables = ["rate_limits", "password_resets", "sessions", "memberships", "database_pool", "users", "organizations"];
  for (const table of manual ? tables.filter((x) => x !== "database_pool") : tables) {
    await controlDb.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await controlDb.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function createOrg(name: string, subdomain: string) {
  if (!manual) await dropTenantDatabase(tenantDbName(subdomain));
  const [pro] = await controlDb.select({ id: plans.id }).from(plans).where(eq(plans.code, "pro"));
  const [{ id }] = await controlDb.insert(organizations).values({ name, subdomain, dbName: tenantDbName(subdomain), planId: pro?.id ?? null, subscriptionStatus: "active" }).$returningId();
  const [org] = await controlDb.select().from(organizations).where(eq(organizations.id, id));
  return provisionTenant(org);
}

async function seedDemo(db: TenantDb, admin: { id: number; name: string }, worker: { id: number; name: string }) {
  await db.insert(t.settings).values([
    { key: "lowStockAlerts", value: "true" },
    { key: "windowDays", value: "30" },
    { key: "deadStockDays", value: "90" },
  ]);

  const [{ id: mainId }, { id: shopId }] = await db
    .insert(t.locations)
    .values([
      { name: "Основен склад", code: "MAIN", address: "София, бул. Европа 10", isDefault: true },
      { name: "Магазин Център", code: "SHOP1", address: "София, ул. Витоша 25" },
    ])
    .$returningId();

  const [{ id: electronics }, { id: apparel }, { id: food }, { id: office }] = await db
    .insert(t.categories)
    .values([
      { name: "Електроника", color: "#4f46e5", description: "Устройства, аксесоари и кабели." },
      { name: "Облекло", color: "#db2777", description: "Дрехи с размери и цветове." },
      { name: "Храни и напитки", color: "#16a34a", description: "Бързооборотни стоки със срок на годност." },
      { name: "Офис консумативи", color: "#f59e0b", description: "Хартия, пишещи средства и консумативи." },
    ])
    .$returningId();

  await db.insert(t.fieldDefinitions).values([
    { categoryId: electronics, name: "Марка", type: "text", sortOrder: 0 },
    { categoryId: electronics, name: "Гаранция (месеци)", type: "number", sortOrder: 1 },
    { categoryId: apparel, name: "Материя", type: "text", sortOrder: 0 },
    { categoryId: food, name: "Съхранение", type: "select", options: JSON.stringify(["Стайна температура", "Хладилно", "Замразено"]), sortOrder: 0 },
  ]);
  const fields = await db.select().from(t.fieldDefinitions);
  const f = (name: string) => fields.find((x) => x.name === name)!.id;

  await db.insert(t.items).values([
    { sku: "EL-MISHKA-01", barcode: "3800100000011", name: "Безжична мишка", categoryId: electronics, minQuantity: 10, unitCost: 12.5, unitPrice: 24.9 },
    { sku: "EL-KLAV-01", barcode: "3800100000028", name: "Механична клавиатура", categoryId: electronics, minQuantity: 10, unitCost: 48, unitPrice: 89, tracking: "serial" },
    { sku: "EL-USBC-2M", barcode: "3800100000035", name: "USB-C кабел 2 м", categoryId: electronics, minQuantity: 40, unitCost: 2.1, unitPrice: 7.9 },
    { sku: "EL-HUB-7", barcode: "3800100000042", name: "USB хъб 7 порта", categoryId: electronics, minQuantity: 5, unitCost: 19, unitPrice: 39 },
    { sku: "OB-TEE-CHER", name: "Тениска черна", categoryId: apparel, minQuantity: 0, unitCost: 4.2, unitPrice: 14.9 },
    { sku: "OB-SUIT-SIV-L", barcode: "3800100000066", name: "Суитшърт сив", categoryId: apparel, minQuantity: 15, unitCost: 15.8, unitPrice: 44.9 },
    { sku: "HR-KAFE-1K", barcode: "3800100000073", name: "Кафе на зърна 1 кг", categoryId: food, minQuantity: 10, unit: "пакет", unitCost: 9.4, unitPrice: 17.9, tracking: "lot" },
    { sku: "HR-VODA-05", barcode: "3800100000080", name: "Минерална вода 0,5 л", categoryId: food, minQuantity: 120, unit: "бут.", unitCost: 0.22, unitPrice: 0.9, tracking: "lot" },
    { sku: "OF-A4-500", barcode: "3800100000097", name: "Копирна хартия А4, 500 л.", categoryId: office, minQuantity: 12, unit: "пакет", unitCost: 3.6, unitPrice: 6.5 },
    { sku: "OF-HIM-SIN", barcode: "3800100000103", name: "Химикалка синя", categoryId: office, minQuantity: 50, unitCost: 0.18, unitPrice: 0.6 },
    { sku: "OF-TONER-85A", barcode: "3800100000110", name: "Тонер касета 85A", categoryId: office, minQuantity: 4, unitCost: 41, unitPrice: 69 },
  ]);
  const rows = await db.select().from(t.items);
  const item = (sku: string) => rows.find((r) => r.sku === sku)!;
  const tee = item("OB-TEE-CHER");

  await db.insert(t.items).values(
    ["S", "M", "L", "XL"].map((size, i) => ({
      parentId: tee.id,
      variantLabel: size,
      sku: `${tee.sku}-${size}`,
      barcode: `38001000002${i}0`,
      name: tee.name,
      categoryId: apparel,
      minQuantity: 5,
      unitCost: 4.2,
      unitPrice: 14.9,
    })),
  );
  const variants = await db.select().from(t.items).where(eq(t.items.parentId, tee.id));
  const variantM = variants.find((v) => v.variantLabel === "M")!;

  await db.insert(t.itemFieldValues).values([
    { itemId: item("EL-MISHKA-01").id, fieldId: f("Марка"), value: "Logi" },
    { itemId: item("EL-MISHKA-01").id, fieldId: f("Гаранция (месеци)"), value: "24" },
    { itemId: item("EL-KLAV-01").id, fieldId: f("Марка"), value: "Keychron" },
    { itemId: tee.id, fieldId: f("Материя"), value: "100% памук" },
    { itemId: item("HR-KAFE-1K").id, fieldId: f("Съхранение"), value: "Стайна температура" },
  ]);

  const totals = new Map<number, number>();
  async function stockIn(itemId: number, locationId: number, qty: number, daysAgo: number, reason: string, lot?: { lotNumber: string; expiryDate?: string; serial?: boolean }) {
    const before = totals.get(itemId) ?? 0;
    const after = before + qty;
    totals.set(itemId, after);
    await db.insert(t.stockLevels).values({ itemId, locationId, quantity: qty }).onDuplicateKeyUpdate({ set: { quantity: sql`${t.stockLevels.quantity} + ${qty}` } });
    let lotId: number | null = null;
    if (lot) {
      if (lot.serial) {
        for (let i = 0; i < qty; i++) {
          const serial = `${lot.lotNumber}${String(i + 1).padStart(3, "0")}`;
          await db.insert(t.lots).values({ itemId, locationId, lotNumber: serial, serialNumber: serial, quantity: 1 });
        }
      } else {
        const [l] = await db.insert(t.lots).values({ itemId, locationId, lotNumber: lot.lotNumber, expiryDate: lot.expiryDate ?? null, quantity: qty }).$returningId();
        lotId = l.id;
      }
    }
    await db.update(t.items).set({ quantity: after }).where(eq(t.items.id, itemId));
    await db.insert(t.stockMovements).values({ itemId, locationId, lotId, userId: admin.id, userName: admin.name, type: "in", delta: qty, quantityAfter: after, reason, createdAt: subDays(today, daysAgo) });
  }
  async function stockOut(itemId: number, locationId: number, qty: number, daysAgo: number, reason: string) {
    const before = totals.get(itemId) ?? 0;
    const after = before - qty;
    totals.set(itemId, after);
    await db.update(t.stockLevels).set({ quantity: sql`${t.stockLevels.quantity} - ${qty}` }).where(sql`${t.stockLevels.itemId} = ${itemId} and ${t.stockLevels.locationId} = ${locationId}`);
    await db.update(t.items).set({ quantity: after }).where(eq(t.items.id, itemId));
    await db.insert(t.stockMovements).values({ itemId, locationId, userId: worker.id, userName: worker.name, type: "out", delta: -qty, quantityAfter: after, reason, createdAt: subDays(today, daysAgo) });
  }

  await stockIn(item("EL-MISHKA-01").id, mainId, 40, 60, "Начална наличност");
  await stockIn(item("EL-MISHKA-01").id, shopId, 20, 60, "Начална наличност");
  await stockIn(item("EL-KLAV-01").id, mainId, 8, 45, "Начална наличност", { lotNumber: "KB-2026-", serial: true });
  await stockIn(item("EL-USBC-2M").id, mainId, 150, 60, "Начална наличност");
  await stockIn(item("EL-HUB-7").id, mainId, 5, 60, "Начална наличност");
  for (const v of variants) await stockIn(v.id, mainId, v.variantLabel === "M" ? 30 : 12, 50, "Начална наличност");
  await stockIn(variantM.id, shopId, 16, 50, "Начална наличност");
  await stockIn(item("OB-SUIT-SIV-L").id, mainId, 17, 50, "Начална наличност");
  await stockIn(item("HR-KAFE-1K").id, mainId, 25, 40, "Начална наличност", { lotNumber: "KF-2605", expiryDate: iso(addDays(today, 120)) });
  await stockIn(item("HR-KAFE-1K").id, mainId, 10, 10, "Доставка", { lotNumber: "KF-2609", expiryDate: iso(addDays(today, 20)) });
  await stockIn(item("HR-VODA-05").id, mainId, 480, 30, "Начална наличност", { lotNumber: "VD-0426", expiryDate: iso(addDays(today, 365)) });
  await stockIn(item("OF-A4-500").id, mainId, 36, 60, "Начална наличност");
  await stockIn(item("OF-HIM-SIN").id, mainId, 210, 60, "Начална наличност");
  await stockIn(item("OF-HIM-SIN").id, shopId, 90, 60, "Начална наличност");
  await stockIn(item("OF-TONER-85A").id, mainId, 4, 60, "Начална наличност");
  for (let d = 28; d >= 1; d -= 3) {
    await stockOut(item("EL-MISHKA-01").id, shopId, 1, d, `Продажба №${1000 + d}`);
    await stockOut(item("EL-USBC-2M").id, mainId, 4, d, `Продажба №${1100 + d}`);
    await stockOut(variantM.id, shopId, 1, d, `Продажба №${1200 + d}`);
    await stockOut(item("OF-HIM-SIN").id, shopId, 5, d, `Продажба №${1300 + d}`);
  }
  await stockOut(item("EL-HUB-7").id, mainId, 5, 2, "Продажба №1051");
  await stockOut(item("OF-TONER-85A").id, mainId, 1, 3, "Инвентаризация: една повредена");

  const [{ id: techSupply }, { id: beans }, { id: officePoint }] = await db
    .insert(t.partners)
    .values([
      { type: "supplier", name: "ТехСъплай ООД", email: "orders@techsupply.bg", phone: "+359 2 123 4567", leadTimeDays: 5, eik: "123456786", vatNumber: "BG123456786", vatRegistered: true, address: "гр. София, ул. Индустриална 12" },
      { type: "supplier", name: "Кафе Братя ЕООД", email: "sales@kafebratya.bg", leadTimeDays: 3 },
      { type: "customer", name: "Офис Пойнт ООД", email: "office@officepoint.bg", phone: "+359 88 765 4321" },
      { type: "both", name: "Студио Норд", email: "hello@studionord.bg" },
    ])
    .$returningId();

  const [{ id: po1 }, { id: po2 }, { id: so1 }] = await db
    .insert(t.orders)
    .values([
      { type: "purchase", number: "ПЗ-2026-001", partnerId: techSupply, locationId: mainId, status: "partial", orderDate: iso(subDays(today, 6)), expectedDate: iso(addDays(today, 3)), createdBy: admin.id },
      { type: "purchase", number: "ПЗ-2026-002", partnerId: beans, locationId: mainId, status: "confirmed", orderDate: iso(subDays(today, 1)), expectedDate: iso(addDays(today, 2)), createdBy: admin.id },
      { type: "sales", number: "ПР-2026-001", partnerId: officePoint, locationId: mainId, status: "confirmed", orderDate: iso(subDays(today, 2)), expectedDate: iso(subDays(today, 1)), notes: "Клиентът помоли за доставка преди обяд.", createdBy: worker.id },
    ])
    .$returningId();
  await db.insert(t.orderLines).values([
    { orderId: po1, itemId: item("EL-HUB-7").id, quantity: 30, fulfilledQuantity: 10, unitPrice: 19 },
    { orderId: po1, itemId: item("EL-KLAV-01").id, quantity: 12, fulfilledQuantity: 0, unitPrice: 48 },
    { orderId: po2, itemId: item("HR-KAFE-1K").id, quantity: 40, unitPrice: 9.4 },
    { orderId: so1, itemId: item("OF-A4-500").id, quantity: 10, unitPrice: 6.5 },
    { orderId: so1, itemId: item("OF-HIM-SIN").id, quantity: 100, unitPrice: 0.6 },
  ]);

  const [{ id: sh1 }, { id: sh2 }, { id: sh3 }, { id: sh4 }] = await db
    .insert(t.shipments)
    .values([
      { reference: "ПЗ-2026-001/1", direction: "inbound", status: "delivered", locationId: mainId, orderId: po1, partnerId: techSupply, carrier: "Спиди", trackingNumber: "80014600003", expectedDate: iso(subDays(today, 4)), deliveredAt: subDays(today, 4), createdBy: admin.id },
      { reference: "ПЗ-2026-001/2", direction: "inbound", status: "in_transit", locationId: mainId, orderId: po1, partnerId: techSupply, carrier: "Спиди", trackingNumber: "80014600117", expectedDate: iso(addDays(today, 3)), createdBy: admin.id },
      { reference: "ПР-2026-001/1", direction: "outbound", status: "pending", locationId: mainId, orderId: so1, partnerId: officePoint, expectedDate: iso(subDays(today, 1)), createdBy: worker.id },
      { reference: "ВХ-0042", direction: "inbound", status: "pending", locationId: shopId, partner: "Доставка от ЕТ Иванов", expectedDate: iso(addDays(today, 1)), createdBy: worker.id },
    ])
    .$returningId();
  await db.insert(t.shipmentLines).values([
    { shipmentId: sh1, itemId: item("EL-HUB-7").id, quantity: 10 },
    { shipmentId: sh2, itemId: item("EL-HUB-7").id, quantity: 20 },
    { shipmentId: sh2, itemId: item("EL-KLAV-01").id, quantity: 12, lotNumber: Array.from({ length: 12 }, (_, i) => `KB-2026-1${String(i + 1).padStart(2, "0")}`).join(",") },
    { shipmentId: sh3, itemId: item("OF-A4-500").id, quantity: 10 },
    { shipmentId: sh3, itemId: item("OF-HIM-SIN").id, quantity: 100 },
    { shipmentId: sh4, itemId: item("EL-MISHKA-01").id, quantity: 10 },
  ]);
  await stockIn(item("EL-HUB-7").id, mainId, 10, 4, "Пратка ПЗ-2026-001/1");
  await db.update(t.stockMovements).set({ shipmentId: sh1 }).where(eq(t.stockMovements.reason, "Пратка ПЗ-2026-001/1"));

  const [{ id: summer }, { id: starter }] = await db
    .insert(t.collections)
    .values([
      { name: "Лято 2026", color: "#f97316", description: "Сезонна линия облекло." },
      { name: "Комплект за нов служител", color: "#0ea5e9", description: "Всичко, което новият колега получава в първия ден." },
    ])
    .$returningId();
  await db.insert(t.collectionItems).values([
    { collectionId: summer, itemId: tee.id },
    { collectionId: summer, itemId: item("OB-SUIT-SIV-L").id },
    { collectionId: starter, itemId: item("EL-MISHKA-01").id },
    { collectionId: starter, itemId: item("EL-KLAV-01").id },
    { collectionId: starter, itemId: item("EL-USBC-2M").id },
    { collectionId: starter, itemId: item("OF-HIM-SIN").id },
  ]);

  await db.insert(t.calendarEvents).values([
    { title: "Месечна инвентаризация", date: iso(addDays(today, 5)), type: "reminder", notes: "Основен склад и магазин." },
    { title: "Посещение на доставчик: ТехСъплай", date: iso(addDays(today, 8)), type: "event" },
    { title: "Краен срок за ценова листа Q4", date: iso(addDays(today, 14)), type: "deadline" },
  ]);
  return rows.length + variants.length;
}

async function main() {
  await resetControl();
  const [{ id: adminId }, { id: workerId }] = await controlDb
    .insert(users)
    .values([
      { email: "admin@demo.bg", name: "Админ Демо", passwordHash: hashPassword("demo1234"), isPlatformAdmin: true },
      { email: "sklad@demo.bg", name: "Иван Складов", passwordHash: hashPassword("demo1234"), canCreateOrganizations: false },
    ])
    .$returningId();

  const demo = await createOrg("Демо Трейдинг ЕООД", "demo");
  const vtora = manual ? null : await createOrg("Втора фирма ООД", "vtora");
  await controlDb.insert(memberships).values([
    { userId: adminId, organizationId: demo.id, role: "owner" },
    ...(vtora ? [{ userId: adminId, organizationId: vtora.id, role: "owner" as const }] : []),
    { userId: workerId, organizationId: demo.id, role: "staff" },
  ]);

  const count = await seedDemo(getTenantDb(demo), { id: adminId, name: "Админ Демо" }, { id: workerId, name: "Иван Складов" });
  if (vtora) await getTenantDb(vtora).insert(t.locations).values({ name: "Основен склад", code: "MAIN", isDefault: true });

  const domain = process.env.APP_DOMAIN ?? "localhost:3000";
  const orgs = [demo, vtora].filter((o) => o !== null);
  console.log(`Заредени: ${orgs.length} организации (${orgs.map((o) => o.dbName).join(", ")}), 2 потребители, ${count} артикула в demo.`);
  console.log(`Вход: http://${process.env.DEMO_TENANT ? "" : "demo."}${domain}/login  ·  admin@demo.bg / demo1234  ·  sklad@demo.bg / demo1234`);
  console.log(`Портал: http://${domain}/portal`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
