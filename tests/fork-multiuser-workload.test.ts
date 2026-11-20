const Module = require('node:module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fork-workload-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      powerMonitor: { on: () => {} },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX = '100000';
process.env.FLO_ORDER_READ_RATE_LIMIT_MAX = '100000';
process.env.FLO_WHATSAPP_SOCKET_DISABLED = '1';
process.env.JWT_SECRET = 'synthetic-fork-workload-only';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser,
  seedCategory, seedProduct, api, closeDatabase, now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { validateInventoryLedgerDatabase } = require('../main/db');
const { adjustProductStock } = require('../main/services/inventory');
const { stopScheduledOrderSweep } = require('../main/services/scheduled-orders');
const { stopKdsServer } = require('../main/kds-server');

function staff(db: any, id: string, role: string) {
  const email = `${id}@synthetic.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, email, bcrypt.hashSync('SyntheticOnly123!', 4), role, now(), now());
  return {
    userId: id,
    authHeader: {
      Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '2h' })}`,
    },
  };
}

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const cashiers = [staff(db, 'cashier-one', 'cashier'), staff(db, 'cashier-two', 'cashier')];
  const waiter = staff(db, 'waiter-one', 'server');
  const waveDelayMs = Number(process.env.FLO_WORKLOAD_WAVE_DELAY_MS || 0);
  assert.ok(Number.isInteger(waveDelayMs) && waveDelayMs >= 0 && waveDelayMs <= 30000);
  const batches = 3;
  const ordersPerBatch = 300;
  const totalOrders = batches * ordersPerBatch;
  const initialStock = totalOrders * 3;
  const put = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, value] of [
    ['country', 'PK'], ['currency', 'PKR'], ['timezone', 'Asia/Karachi'],
    ['multi_counter_enabled', 'true'], ['kds_enabled', 'false'],
    ['kot_printing_enabled', 'false'], ['auto_print_kot', 'false'],
    ['require_kitchen_delivered_before_settlement', 'false'],
    ['taxes_enabled', 'false'], ['cloud_services_disabled_by_user', 'true'],
    ['telemetry_enabled', 'false'], ['anonymous_data_consent', 'false'],
  ]) put.run(key, value, now());

  seedCategory(db, 'workload-category', 'Synthetic workload');
  seedProduct(db, 'workload-product', 'workload-category', 'Synthetic coffee', 250, {
    track_inventory: true,
    stock_quantity: 0,
  });
  adjustProductStock(db, {
    productId: 'workload-product', quantityDelta: initialStock,
    movementType: 'adjustment', referenceType: 'manual_adjustment',
    reason: 'Synthetic workload stock', actorUserId: owner.userId,
  });

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);
  const started = performance.now();
  const memory: Array<{ orders: number; heapUsed: number; rss: number }> = [];
  const latencies: number[] = [];
  let expectedQuantity = 0;
  let expectedRevenue = 0;
  let completed = 0;

  function sample() {
    if (typeof global.gc === 'function') global.gc();
    const current = process.memoryUsage();
    memory.push({ orders: completed, heapUsed: current.heapUsed, rss: current.rss });
  }

  async function order(index: number) {
    const began = performance.now();
    const quantity = 1 + index % 3;
    const creator = index % 2 === 0 ? waiter : cashiers[0];
    const cashier = cashiers[index % cashiers.length];
    const headers = { ...creator.authHeader, 'Idempotency-Key': `order-${index}` };
    const body = {
      type: 'takeaway', dispatch_policy: 'on_payment',
      items: [{ product_id: 'workload-product', quantity }],
    };
    const created = await api(baseUrl, '/api/orders', { method: 'POST', headers, body });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const orderId = created.data.order.id;
    if (index % 10 === 0) {
      const replay = await api(baseUrl, '/api/orders', { method: 'POST', headers, body });
      assert.equal(replay.status, 200, JSON.stringify(replay.data));
      assert.equal(replay.data.order.id, orderId, 'order retry must return the original order');
    }

    const bill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(orderId);
    assert.ok(bill, 'deferred order must have a bill');
    assert.equal(Number(bill.total), quantity * 250);
    const payment = {
      method: 'POST',
      headers: { ...cashier.authHeader, 'Idempotency-Key': `payment-${index}` },
      body: { payments: [{ method: 'cash', amount: Number(bill.total) }] },
    };
    const paid = index % 10 === 0
      ? await Promise.all([
        api(baseUrl, `/api/bills/${bill.id}/payments`, payment),
        api(baseUrl, `/api/bills/${bill.id}/payments`, payment),
      ])
      : [await api(baseUrl, `/api/bills/${bill.id}/payments`, payment)];
    for (const response of paid) {
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.bill.payment_status, 'paid');
      assert.equal(Number(response.data.bill.balance), 0);
    }
    const recorded = db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(bill.id);
    assert.equal(JSON.parse(recorded.payment_details || '[]').length, 1, 'payment retry must not duplicate money');
    expectedQuantity += quantity;
    expectedRevenue += Number(bill.total);
    completed++;
    latencies.push(performance.now() - began);
  }

  try {
    sample();
    for (let batch = 0; batch < batches; batch++) {
      for (let offset = 0; offset < ordersPerBatch; offset += 5) {
        const visibility = api(baseUrl, '/api/orders/awaiting-payment', { headers: manager.authHeader });
        await Promise.all(Array.from({ length: 5 }, (_, worker) => order(batch * ordersPerBatch + offset + worker)));
        const visible = await visibility;
        assert.equal(visible.status, 200, 'manager can observe orders while cashiers operate');
        if (waveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, waveDelayMs));
      }
      sample();
      assert.equal(validateInventoryLedgerDatabase(db), null, 'stock ledger must reconcile after each batch');
      assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
      assert.equal(db.pragma('foreign_key_check').length, 0);
      console.log(`Workload batch ${batch + 1}: ${completed} orders reconciled`);
    }

    const counts = db.prepare(`
      SELECT COUNT(*) AS orders, COUNT(DISTINCT order_number) AS unique_numbers FROM orders
    `).get();
    assert.equal(counts.orders, totalOrders);
    assert.equal(counts.unique_numbers, totalOrders);
    const bills = db.prepare(`
      SELECT COUNT(*) AS bills, SUM(total) AS revenue,
        SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid FROM bills
    `).get();
    assert.equal(bills.bills, totalOrders);
    assert.equal(bills.paid, totalOrders);
    assert.equal(Number(bills.revenue), expectedRevenue);
    assert.equal(Number(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('workload-product').stock_quantity), initialStock - expectedQuantity);

    const snapshotPath = path.join(testDir, 'verified-workload-backup.db');
    await db.backup(snapshotPath);
    const snapshot = new (require('better-sqlite3'))(snapshotPath, { readonly: true });
    try {
      assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM orders').get().count, totalOrders);
      assert.deepEqual(snapshot.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
      assert.equal(snapshot.pragma('foreign_key_check').length, 0);
    } finally {
      snapshot.close();
    }

    const heapGrowth = memory[memory.length - 1].heapUsed - memory[0].heapUsed;
    assert.ok(heapGrowth < 64 * 1024 * 1024, `backend retained heap grew by ${heapGrowth} bytes`);
    latencies.sort((a, b) => a - b);
    console.log('FORK_WORKLOAD_REPORT ' + JSON.stringify({
      users: ['server', 'cashier-one', 'cashier-two', 'manager'],
      batches, ordersPerBatch, totalOrders, concurrentOrderFlows: 5, waveDelayMs,
      elapsedMs: performance.now() - started,
      p95OrderFlowMs: latencies[Math.floor(latencies.length * 0.95)],
      expectedRevenue, expectedQuantity, heapGrowth, memory,
      limitations: ['Accelerated daily-sized batches; not elapsed business days', 'Backend process memory only', 'Printing and KDS disabled in this workload; covered by separate suites'],
    }));
  } finally {
    stopScheduledOrderSweep();
    await stopKdsServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
