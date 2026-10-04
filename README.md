# Windows 本地单摆速度 Verlet 后端

这是一个只包含 API 与 CLI 的离线后端，用于对无阻尼理想单摆做速度 Verlet 固定步长积分，并核验离散轨迹的能量误差。项目使用 TypeScript、Node.js 内置 `node:sqlite` 和项目内 SQLite 文件；不需要 Docker、WSL、付费服务或外部在线 API。

角度以弧度表示，竖直向下为零，顺时针/逆时针方向由正负号区分。计算字段 `angle` 始终保持连续，不折回 `[-π, π]`；仅用展示字段 `displayAngle` 做圆周归一化，因此折返不会影响后续轨迹。

## 环境

- Windows PowerShell
- PowerShell 7 (`pwsh`) 用于 `npm run demo`
- Node.js `22.5+`（开发环境为 Node.js `25.5.0`）
- npm

## 构建、测试、启动与演示

```powershell
npm install
npm run build
npm test
npm start
npm run demo
```

默认数据库是项目内的 `data/pendulum.sqlite`。可以覆盖：

```powershell
$env:PENDULUM_DB = "E:\GSB\0314\B\data\my.sqlite"
```

HTTP 端口：

- 不设置 `PORT`：自动监听 `127.0.0.1` 的空闲端口，启动日志会输出端口。
- 设置 `PORT=8080`：尝试使用指定端口。

```powershell
$env:PORT = "8080"
npm start
```

## 数值方法

实际角加速度使用完整非线性动力学：

```text
a(θ) = -(g/L) sin(θ)
```

每个固定时间步严格执行：

```text
a_n = -(g/L) sin(θ_n)
ω_half = ω_n + 0.5 a_n dt
θ_{n+1} = θ_n + ω_half dt
a_{n+1} = -(g/L) sin(θ_{n+1})
ω_{n+1} = ω_half + 0.5 a_{n+1} dt
n ← n + 1
```

后半步使用新角度 `θ_{n+1}` 的加速度，不是旧角度加速度；实现也不是显式欧拉改名。小幅摆动和足以越过最高点的旋转状态使用同一套公式，不使用解析周期或椭圆积分推进。

展示时间总是：

```text
t_n = n dt
```

不通过浮点时间不断累加产生显示漂移。`sampleInterval` 只改变返回和保存的明细密度，内部每个积分步都会执行，不能跳过。

## 能量

每个保存点输出：

- 动能：`K = m L² ω² / 2`
- 势能：`U = mgL(1-cos θ)`
- 总能量：`E = K + U`
- 绝对偏差：`ΔE = E_n - E_0`
- 能量误差：
  - 初始总能量非零：`|ΔE| / |E_0|`
  - 初始总能量为零：`|ΔE|`，字段 `energyErrorKind=absolute`

离散速度 Verlet 不会强制每一步能量完全相同；本项目不重新缩放角速度。能量误差用于核验积分质量。能量守恒近似随步长减小而改善，但小幅摆动的线性周期只能作为有限精度参考，不能当成大幅摆动或旋转状态的真值。

## 参数与限制

所有物理输入必须是有限数，不能是 `NaN` 或 `Infinity`。

| 参数 | 规则 |
| --- | --- |
| `length` (L) | 正数，`1e-9 ~ 1e6` 米 |
| `mass` (m) | 正数，`1e-12 ~ 1e6` 千克 |
| `gravity` (g) | 正数，`1e-9 ~ 1e5` m/s² |
| `initialAngle` | 有限数，绝对值不超过 `1e6` rad |
| `initialAngularVelocity` | 有限数，绝对值不超过 `1e4` rad/s |
| `timeStep` | 正数，`1e-9 ~ 100` 秒 |
| `targetSteps` | 非负整数，最大 `100,000,000` |
| `sampleInterval` | 正整数，不能超过目标步数（目标为 0 时为 1） |
| 无量纲步长 | `sqrt(g/L)·dt <= 0.1` |

过粗步长、非正数、非有限数和超限值会返回 `400 INVALID_PARAMETER`。

## 运行状态

SQLite 保存：

- 固定配置：L、m、g、初始角状态、固定 `dt`、目标步数、采样间隔
- 当前连续角度、当前角速度、完成步数
- 初始总能量
- 积分器版本：`velocity-verlet-1`
- 已保存采样点

运行状态只有：

- `paused`：尚未达到目标步数。因本次推进预算结束时也保持暂停。
- `completed`：完成步数达到创建时的目标步数。

重启后只从数据库读取当前角度、角速度和步数继续，不根据显示时间或初态重新初始化。每次推进在 `BEGIN IMMEDIATE` 事务中同时更新运行状态和本次采样；事务失败会回滚，不会只写入半步或重复推进。

## HTTP API

### 健康检查

```http
GET /health
```

### 创建运行

```http
POST /api/runs
Content-Type: application/json

{
  "length": 1,
  "mass": 1,
  "gravity": 9.81,
  "initialAngle": 0.1,
  "initialAngularVelocity": 0,
  "timeStep": 0.001,
  "targetSteps": 6283,
  "sampleInterval": 100
}
```

创建时保存第 0 步。

### 推进

```http
POST /api/runs/{id}/advance
Content-Type: application/json

{ "steps": 1000 }
```

若请求步数超过剩余步数，只推进到目标并标记完成；否则未达目标时保持 `paused`。

### 暂停

```http
POST /api/runs/{id}/pause
```

预算停止本身已经保存为暂停；该接口用于显式确认暂停状态。已完成运行返回 `409 CONFLICT`。

### 查询状态

```http
GET /api/runs/{id}/state
```

### 查询指定已保存步

```http
GET /api/runs/{id}/steps/2000
```

若该步因采样间隔未保存，返回 `404 NOT_FOUND`。

### 导出轨迹

```http
GET /api/runs/{id}/trajectory
GET /api/runs/{id}/trajectory?format=csv
```

### 查看能量误差

```http
GET /api/runs/{id}/energy
```

### 同初态不同步长对照

该接口做临时计算，不创建持久运行：

```http
POST /api/runs/compare
Content-Type: application/json

{
  "config": {
    "length": 1,
    "mass": 1,
    "gravity": 9.81,
    "initialAngle": 0.1,
    "initialAngularVelocity": 0
  },
  "duration": 1,
  "coarseTimeStep": 0.01,
  "fineTimeStep": 0.005
}
```

## CLI

```powershell
node dist/cli/index.js import --config examples/small-angle.json
node dist/cli/index.js advance <runId> 1000
node dist/cli/index.js pause <runId>
node dist/cli/index.js state <runId>
node dist/cli/index.js step <runId> 2000
node dist/cli/index.js energy <runId>
node dist/cli/index.js export <runId> --out data/trajectory.csv
node dist/cli/index.js export <runId> --out data/trajectory.json
node dist/cli/index.js handcheck --config examples/small-angle.json
node dist/cli/index.js compare --config examples/small-angle.json --duration 1 --coarse-dt 0.01 --fine-dt 0.005
```

构建后也可以用 `npm link` 生成 `pendulum` 命令。

## 已包含的核验

测试文件 `test/pendulum.test.ts` 覆盖：

- 手算首步的当前加速度、半步速度、新角度、新加速度顺序
- 静止在最低点保持不动，并对零初始能量报告绝对偏差
- 小角度摆动以线性周期作有限精度参考
- 初速足够大时连续转过完整圆周，连续 `angle` 超过 `2π`
- 质量改变不影响角运动，但能量按质量比例改变
- 一次推进与分段推进、关闭并重新打开 SQLite 后续算完全一致
- 采样间隔不跳过内部积分步
- 达到目标才完成；预算停止为暂停
- 时间始终由步数乘步长得到
- 末态反转角速度后继续相同步数做时间反演检查，测试容差为 `1e-12 rad` 和 `1e-12 rad/s`
- 固定 1 秒内步长从 `0.01` 减半到 `0.005` 后能量误差显著下降
- 参数校验和无量纲步长限制

## 错误码

| HTTP 状态 | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_PARAMETER` | 参数缺失、非有限、非正、非整数或超限 |
| 404 | `NOT_FOUND` | 运行或指定采样步不存在、API 路径不存在 |
| 409 | `CONFLICT` | 已完成运行仍尝试推进或暂停 |
| 500 | `INTERNAL_ERROR` | 未预期内部错误 |

## 限制与合理假设

- 本项目只研究一个理想无阻尼单摆，不包含双摆、碰撞、控制器、摩擦、传感器或动画。
- 不解析解析周期，不用小角近似替代实际动力学。
- 长轨迹的保存点数量由目标步数除以采样间隔决定；如需节省空间，应增大 `sampleInterval`，内部步仍完整执行。
- Node.js 的 SQLite API 在当前 Node 版本会输出实验性警告；功能由项目测试和实际 CLI/API 演示验证。
