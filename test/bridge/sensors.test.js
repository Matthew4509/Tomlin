// GPU use and CPU heat (lib/sensors.js). Run: node test/sensors.test.js
// The LibreHardwareMonitor tree below follows its web server's data.json layout (computer > hardware > group >
// sensor, values like "47.0 °C"); it is written by hand, not captured from a running copy.
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const S = require('../../src/bridge/sensors');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };

const sensor = (Text, Value, id) => ({ id: 0, Text, Min: Value, Value, Max: Value, ImageURL: '', SensorId: id, Type: 'Temperature', Children: [] });
const lhm = cpuTemps => ({ id: 0, Text: 'Sensor', Min: 'Min', Value: 'Value', Max: 'Max', ImageURL: '', Children: [{ id: 1, Text: 'LAPTOP', ImageURL: 'images_icon/computer.png', Children: [
  { id: 2, Text: 'Generic Memory', ImageURL: 'images_icon/ram.png', HardwareId: '/ram', Children: [] },
  { id: 3, Text: 'Intel Core i5-6200U', ImageURL: 'images_icon/cpu.png', HardwareId: '/intelcpu/0', Children: [
    { id: 4, Text: 'Clocks', ImageURL: 'images_icon/clock.png', Children: [{ id: 5, Text: 'CPU Core #1', Value: '2394.5 MHz', Children: [] }] },
    { id: 6, Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Children: cpuTemps }] },
  { id: 9, Text: 'NVIDIA GeForce', ImageURL: 'images_icon/nvidia.png', HardwareId: '/gpu-nvidia/0', Children: [
    { id: 10, Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Children: [sensor('GPU Core', '91.0 °C', '/gpu-nvidia/0/temperature/0')] }] }] }] });

function serve(handler) {
  return new Promise(r => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => r(s)); });
}

(async () => {
  await check('GPU: each engine adds up over programs, the busiest engine is the figure (as Task Manager)', () => {
    const g = S.gpuFromLine('GPU 339 pid_1_luid_0x00000000_0x0000bc30_phys_0_eng_0_engtype_3d=20.5|pid_2_luid_0x00000000_0x0000bc30_phys_0_eng_0_engtype_3d=15|pid_2_luid_0x00000000_0x0000bc30_phys_0_eng_5_engtype_VideoDecode=30');
    assert.deepStrictEqual(g, { pct: 36, engine: '3d' });
  });
  await check('GPU: nothing busy = 0%, not "no reading"', () => assert.deepStrictEqual(S.gpuFromLine('GPU 339 '), { pct: 0, engine: '' }));
  await check('GPU: never above 100%', () => assert.strictEqual(S.gpuFromLine('GPU 2 pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3d=80|pid_2_luid_0x0_0x1_phys_0_eng_0_engtype_3d=70').pct, 100));
  await check('GPU: an engine type with a space is kept whole', () => assert.strictEqual(S.gpuFromLine('GPU 1 pid_1_luid_0x0_0x1_phys_0_eng_10_engtype_GDI Render=4').engine, 'GDI Render'));
  await check('GPU: an error line is not read as a figure', () => assert.strictEqual(S.gpuFromLine('ERR Windows has no GPU Engine counters on this PC.'), null));

  await check('heat: CPU Package wins; the GPU\'s 91 °C and "Distance to TjMax" are never taken', () => {
    const t = S.cpuTempFromLhm(lhm([sensor('CPU Core #1', '47.0 °C'), sensor('CPU Core #1 Distance to TjMax', '53.0 °C'), sensor('CPU Package', '49.0 °C'), sensor('Core Max', '48.0 °C')]));
    assert.deepStrictEqual(t, { c: 49, label: 'CPU Package', cpu: 'Intel Core i5-6200U' });
  });
  await check('heat: without a package reading, Core Max; without that, the hottest core', () => {
    assert.strictEqual(S.cpuTempFromLhm(lhm([sensor('CPU Core #1', '47.0 °C'), sensor('Core Max', '48.0 °C')])).label, 'Core Max');
    assert.deepStrictEqual(S.cpuTempFromLhm(lhm([sensor('CPU Core #1', '47.0 °C'), sensor('CPU Core #2', '55.0 °C'), sensor('Core #2 Distance to TjMax', '99.0 °C')])).c, 55);
  });
  await check('heat: old versions without SensorId/Type/HardwareId still read (found by the cpu icon)', () => {
    const tree = lhm([{ id: 7, Text: 'CPU Package', Value: '52.0 °C', ImageURL: '', Children: [] }]);
    delete tree.Children[0].Children[1].HardwareId;
    assert.strictEqual(S.cpuTempFromLhm(tree).c, 52);
  });
  await check('heat: comma decimals and Fahrenheit', () => {
    assert.strictEqual(S.parseTemp('52,5 °C'), 52.5);
    assert.strictEqual(Math.round(S.parseTemp('122.0 °F')), 50);
    assert.strictEqual(S.parseTemp('2394.5 MHz'), null);
  });
  await check('heat: a CPU with no temperature sensors (0 °C placeholder) gives nothing', () => assert.strictEqual(S.cpuTempFromLhm(lhm([sensor('CPU Package', '0.0 °C')])), null));

  await check('heat over HTTP: reads data.json from the port', async () => {
    const srv = await serve((req, res) => { res.writeHead(req.url === '/data.json' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(lhm([sensor('CPU Package', '61.0 °C')]))); });
    const t = await S.readLhm(srv.address().port); srv.close();
    assert.deepStrictEqual(t, { c: 61, label: 'CPU Package', cpu: 'Intel Core i5-6200U' });
  });
  await check('heat over HTTP: a password, another program, and nothing listening each say so', async () => {
    let srv = await serve((req, res) => { res.writeHead(401); res.end(); });
    assert(/password/.test((await S.readLhm(srv.address().port)).error)); srv.close();
    srv = await serve((req, res) => { res.writeHead(200); res.end('<html>hello</html>'); });
    assert(/not with LibreHardwareMonitor/.test((await S.readLhm(srv.address().port)).error));
    const port = srv.address().port; await new Promise(r => srv.close(r));
    assert.deepStrictEqual(await S.readLhm(port), { none: true });
  });

  if (process.platform === 'win32') {
    await check('GPU on this PC: a real reading arrives (0-100) with the card\'s name', async () => {
      let g = S.gpuStats();
      for (let i = 0; i < 40 && g.pct == null && !g.error; i++) { await new Promise(r => setTimeout(r, 250)); g = S.gpuStats(); }
      assert(!g.error, g.error);
      assert(typeof g.pct === 'number' && g.pct >= 0 && g.pct <= 100, JSON.stringify(g));
      assert(g.adapters.length > 0, 'no adapter name');
      S.stopGpu();
    });
    // Two things end it: its input closing, and Node on Windows putting children in a job that dies with it (a
    // reader that ignores its input was checked to die too, 27 Sep). This checks the result, not which one did it.
    await check('GPU reader ends when the Bridge is killed (no PowerShell left behind)', async () => {
      const child = spawn(process.execPath, ['-e', `const S=require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'bridge', 'sensors.js'))});S.gpuStats();setInterval(()=>{},1000)`], { stdio: 'ignore' });
      const readers = () => execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ParentProcessId -eq ${child.pid} -and $_.CommandLine -like '*gpu-sample.ps1*' }).Count`], { encoding: 'utf8' }).trim();
      let n = '0';
      for (let i = 0; i < 20 && n === '0'; i++) { await new Promise(r => setTimeout(r, 300)); n = readers(); }
      assert.strictEqual(n, '1', 'the reader never started');
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' }); // like the Bridge window being closed hard
      for (let i = 0; i < 20 && n !== '0'; i++) { await new Promise(r => setTimeout(r, 300)); n = readers(); }
      assert.strictEqual(n, '0', 'the PowerShell reader is still running after the Bridge died');
    });
  }

  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
