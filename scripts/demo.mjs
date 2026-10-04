// 端到端演示：静止最低点、小角度往复、连续圆周、分段/重启一致性、旧记录重启可读。
// 直接以子进程方式调用编译后的 CLI，数据写入 data/demo。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'dist', 'src', 'cli.js');
const demoData = join(root, 'data', 'demo');
rmSync(demoData, { recursive: true, force: true });

function run(args) {
  return execFileSync(process.execPath, ['--no-warnings', cli, ...args], {
    cwd: root,
    env: { ...process.env, PENDULUM_DATA_DIR: demoData },
    encoding: 'utf8',
  });
}

function section(title) {
  console.log(`\n==================== ${title} ====================`);
}

function create(args) {
  const out = run(['create', ...args]);
  return JSON.parse(out).id;
}

// 1. 静止最低点
section('1. 静止在最低点（100 步后角度与角速度应仍为 0）');
const still = create(['--L', '1', '--m', '1', '--g', '9.81', '--theta0', '0', '--omega0', '0', '--dt', '0.01', '--totalSteps', '100']);
console.log(run(['advance', still, '--maxSteps', '100']).trim().split('\n').slice(-12).join('\n'));

// 2. 小角度往复
section('2. 小角度往复（线性近似周期 T≈2.006s，观察能量偏差）');
const small = create(['--config', 'examples/config.small.json']);
console.log(run(['advance', small, '--maxSteps', '630']).trim().split('\n').slice(0, 8).join('\n'));
console.log('...');
console.log(run(['energy', small]).trim().split('\n').slice(-5).join('\n'));

// 3. 连续圆周
section('3. 初速 6.5 rad/s（>sqrt(4g/L)≈6.264）连续转过完整圆周');
const rot = create(['--config', 'examples/config.rotation.json']);
run(['advance', rot, '--maxSteps', '2000']);
const rotEnd = JSON.parse(run(['get', rot]));
console.log(`末态连续 theta=${rotEnd.state.theta.toFixed(4)} rad ≈ ${(rotEnd.state.theta / (2 * Math.PI)).toFixed(2)} 圈, omega=${rotEnd.state.omega.toFixed(4)}`);

// 4. 一次推进 vs 分段 + 重启
section('4. 一次推进 与 暂停/重启分段推进 一致性');
const a = create(['--L', '1', '--m', '2', '--g', '9.81', '--theta0', '0.3', '--omega0', '0.4', '--dt', '0.005', '--totalSteps', '300', '--sampleInterval', '300']);
run(['advance', a, '--maxSteps', '300']);
const b = create(['--L', '1', '--m', '2', '--g', '9.81', '--theta0', '0.3', '--omega0', '0.4', '--dt', '0.005', '--totalSteps', '300', '--sampleInterval', '300']);
run(['advance', b, '--maxSteps', '120']);
run(['pause', b]);
// 模拟重启：新进程执行 resume 再推进
run(['resume', b]);
run(['advance', b, '--maxSteps', '180']);
const ea = JSON.parse(run(['get', a]));
const eb = JSON.parse(run(['get', b]));
console.log('一次推进:', ea.state);
console.log('分段重启:', eb.state);
console.log('角度差:', Math.abs(ea.state.theta - eb.state.theta), ' 角速度差:', Math.abs(ea.state.omega - eb.state.omega));

// 5. 旧记录重启可读
section('5. 旧记录重启可读（list 展示数据库中持久化的运行）');
console.log(run(['list']).trim());

// 6. 步长对照
section('6. 同初态步长对照（dt 减半，能量误差应约降至 1/4）');
console.log(run(['compare', '--L', '1', '--m', '1', '--g', '9.81', '--theta0', '0.4', '--omega0', '0.3', '--dt', '0.01', '--tEnd', '2']));

// 7. 导出轨迹
section('7. 导出轨迹 CSV');
console.log(run(['export', small, '--out', 'data/demo/small.csv']).trim());
