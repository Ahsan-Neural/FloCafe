import { expect, test } from '@playwright/test';
import { createNativeElectronHarness, type NativeElectronHarness } from './native-harness';

test.setTimeout(90_000);

let harness: NativeElectronHarness;

test.beforeEach(async ({}, testInfo) => {
  harness = await createNativeElectronHarness({ runtimeRelaunchAttempt: testInfo.title.includes('relaunch loop') });
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

test('a recently relaunched app stops a renderer relaunch loop before stability is established', async () => {
  let relaunches = 0;
  let exhausted = 0;
  harness.app.on('console', (message) => {
    if (message.text() === 'FORK_RELAUNCH_REQUESTED') relaunches++;
    if (message.text() === 'FORK_RELAUNCH_EXHAUSTED') exhausted++;
  });
  await harness.app.evaluate(({ app, dialog }) => {
    app.relaunch = () => { console.log('FORK_RELAUNCH_REQUESTED'); };
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args[args.length - 1] as { title?: string } | undefined;
      if (options?.title === 'Flo needs to restart') {
        console.log('FORK_RELAUNCH_EXHAUSTED');
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }
      return Reflect.apply(original, dialog, args);
    }) as typeof dialog.showMessageBox;
  });

  const recovered = harness.app.waitForEvent('window', { timeout: 30_000 });
  await harness.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('http://localhost:'));
    if (!window) throw new Error('POS window not found');
    window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
  });
  const page = await recovered;
  await page.waitForURL((url) => url.port === String(harness.ports.main), { timeout: 30_000 });
  harness.setActivePage(page);
  await expect(page.getByTestId('desktop-drag-surface')).toBeVisible();

  const closed = harness.app.waitForEvent('close', { timeout: 30_000 });
  await harness.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('http://localhost:'));
    if (!window) throw new Error('Recovered POS window not found');
    window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
  });
  await closed;
  expect(exhausted, 'restart budget must remain exhausted until the renderer is stable').toBe(1);
  expect(relaunches).toBe(0);
});
