import { expect, test } from '@playwright/test';
import { createNativeElectronHarness, type NativeElectronHarness } from './native-harness';

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let harness: NativeElectronHarness;

test.beforeEach(async () => {
  harness = await createNativeElectronHarness();
  await harness.authenticateDashboard();
});

test.afterEach(async () => {
  await harness?.close();
});

for (const failure of ['renderer-crash', 'simulated-oom'] as const) {
  test(`${failure} recovers automatically and preserves saved settings`, async () => {
    const originalPid = harness.app.process().pid;
    const saved = await harness.page.evaluate(async () => {
      const response = await fetch('/api/settings/business_name', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ value: 'Crash recovery preserved this store' }),
      });
      return response.status;
    });
    expect(saved).toBe(200);

    await harness.app.evaluate(({ dialog }) => {
      Reflect.set(globalThis, '__forkCrashDialogCount', 0);
      const original = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = ((...args: unknown[]) => {
        const options = args[args.length - 1] as { title?: string } | undefined;
        if (options && 'title' in options && options.title === 'App Crashed') {
          Reflect.set(globalThis, '__forkCrashDialogCount', Reflect.get(globalThis, '__forkCrashDialogCount') + 1);
          return Promise.resolve({ response: 0, checkboxChecked: false });
        }
        return Reflect.apply(original, dialog, args);
      }) as typeof dialog.showMessageBox;
    });

    const recoveredWindow = harness.app.waitForEvent('window', { timeout: 30_000 });
    await harness.app.evaluate(({ BrowserWindow }, failure) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('http://localhost:'));
      if (!window) throw new Error('POS window not found');
      if (failure === 'simulated-oom') {
        window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
      } else {
        window.webContents.forcefullyCrashRenderer();
      }
    }, failure);
    const page = await recoveredWindow;
    await page.waitForURL((url) => url.port === String(harness.ports.main), { timeout: 30_000 });
    harness.setActivePage(page);
    await expect(page.getByTestId('desktop-drag-surface')).toBeVisible();
    await harness.authenticateDashboard();

    expect(await harness.app.evaluate(() => Reflect.get(globalThis, '__forkCrashDialogCount')), 'recovery must not require a crash dialog').toBe(0);
    expect(harness.app.process().pid).toBe(originalPid);
    expect(await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((candidate) => candidate.webContents.getURL().startsWith('http://localhost:')).length)).toBe(1);
    expect(await page.evaluate(async () => window.electronAPI?.getStatus())).toMatchObject({
      server: 'running',
      kdsServer: 'running',
      serverApp: 'running',
    });
    const persisted = await page.evaluate(async () => {
      const response = await fetch('/api/settings/business_name', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      return { status: response.status, body: await response.json() };
    });
    expect(persisted.status).toBe(200);
    expect(persisted.body.setting.value).toBe('Crash recovery preserved this store');
  });
}
