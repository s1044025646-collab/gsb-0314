# 单摆速度 Verlet 步进与能量误差核验后端

无阻尼单摆的**离线数值步进服务**：输入摆长、质量、重力加速度、初始角度/角速度、固定时间步长与目标步数，
返回角度、角速度与能量随离散时间的变化。只包含 HTTP API 与 CLI，无前端、无动画。

- 运行环境：Windows 本地的 Node.js（建议 **Node 22.5+ / 实测 Node 25**，使用内置 `node:sqlite`）
- 语言：TypeScript（ESM，编译到 `dist/`）
- 存储：SQLite（`node:sqlite`，WAL 模式），数据文件位于项目内 `data/pendulum.db`
- 不依赖 Docker、WSL、付费服务或任何外部在线 API

## 物理模型与方法

- 单个理想单摆，无阻尼、无摩擦、无碰撞、无控制器。
- 角度以**弧度**表示，**竖直向下为零**，逆时针为正；角度在积分中**保持连续、不折回**到 ±π。
  归一化到 `[-π, π)` 的显示角度另由 `theta_wrapped` 字段给出，不参与后续轨迹计算。
- 角加速度：`α(θ) = -(g/L)·sin(θ)`，不使用小角近似替代真实动力学；小幅摆动与越过最高点的旋转状态使用同一公式。

### 速度 Verlet（kick-drift-kick）

对每个固定步长 `dt`：

1. 半步角速度：`ω½ = ω_n + α(θ_n)·dt/2`
2. 更新角度：`θ_{n+1} = θ_n + ω½·dt`
3. 后半步角速度：`ω_{n+1} = ω½ + α(θ_{n+1})·dt/2`

第 3 步的加速度**必须取自新角度** `θ_{n+1}`；本实现不是显式欧拉换名（测试中显式比较了两者结果）。
积分器版本以 `velocity-verlet-1` 记录在每个运行中，续算沿用同一状态与步长。

### 能量与误差

- 动能 `K = ½ m L² ω²`
- 势能 `U = m g L (1 - cos θ)`
- 总能量 `E = K + U`
- 偏差：`(E_n - E_0)/E_0`（相对）；当 `|E_0| < 1e-12`（如静止于最低点）时改报**绝对偏差** `E_n - E_0`，避免除零。

离散速度 Verlet **不会使每一步能量严格相同**：能量误差为 O(dt²) 的有界振荡，本服务**不**通过重新缩放角速度强行守恒。
步长减半后，较短固定时间内的最大能量偏差约降至 1/4（`/api/compare`、`compare` 命令及测试验证）。

### 时间与采样

- 规定时间恒为 `t = n·dt`（步数乘步长），不做浮点累加，避免展示漂移。
- `sampleInterval` 只影响**返回与落库的明细密度**，内部积分步一个都不跳过；第 0 步与目标步始终采样。
- 达到 `totalSteps` 才标记 `completed`；因计算预算（`maxSteps`）停止标记为 `paused`。
- 重启后从保存的 `θ, ω, n` 与固定参数继续，**不按显示时刻重新初始化**。

## 参数校验、上限与错误码

所有物理参数必须为有限数；`L、m、g、dt` 必须为正。上限：

| 项目 | 上限 | 说明 |
| --- | --- | --- |
| 无量纲步长 `sqrt(g/L)·dt` | `0.25` | 过粗步长明确拒绝（错误字段 `dt`） |
| `|omega0|` | `1e6 rad/s` | |
| `|theta0|` | `1e6 rad` | |
| `totalSteps` / `maxSteps` | `1e7` | 非负/正整数 |
| `sampleInterval` | — | `>=1` 的整数 |

错误码（HTTP 状态）：

- `INVALID_PARAMETER` / `INVALID_BODY`（400）
- `RUN_NOT_FOUND` / `SAMPLE_NOT_FOUND`（404）
- `RUN_COMPLETED`（409，完成后再推进/暂停/重启）
- `INTERNAL`（500）

SQLite 以 `BEGIN IMMEDIATE` 事务原子保存运行状态与本次采样：中途失败整体回滚，不会重复推进或丢失半步状态。

## 构建、测试、启动、演示

```powershell
npm install
npm run build      # tsc 编译到 dist/
npm test           # 编译 + node --test（物理手算、存储、API）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口；PORT 环境变量可指定）
npm run demo       # 三个物理场景 + 分段/重启一致性 + 步长对照 + 导出
```

可配置项：

- `PORT=8080 npm start`：固定端口；不设则自动选择空闲端口并打印实际地址。
- `PENDULUM_DATA_DIR`：数据目录（默认项目内 `./data`）。

## CLI

```powershell
npm run --silent -- cli create --config examples/config.small.json
npm run --silent -- cli list
npm run --silent -- cli get <runId>
npm run --silent -- cli advance <runId> --maxSteps 100
npm run --silent -- cli pause <runId>
npm run --silent -- cli resume <runId>
npm run --silent -- cli step <runId> --n 100
npm run --silent -- cli samples <runId> --limit 10
npm run --silent -- cli energy <runId>
npm run --silent -- cli export <runId> --out data/traj.csv
npm run --silent -- cli compare --L 1 --m 1 --g 9.81 --theta0 0.4 --omega0 0.3 --dt 0.01 --tEnd 2
```

`create` 也支持直接用 `--L --m --g --theta0 --omega0 --dt --totalSteps --sampleInterval` 传参；
配置文件与命令行参数同时给出时，命令行优先。终端输出为制表符分隔数值表（n、t、连续 θ、归一化 θ、ω、K、U、E、偏差）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runs` | 导入配置并创建运行（第 0 步采样落库） |
| GET | `/api/runs` | 列出全部运行 |
| GET | `/api/runs/:id` | 查询运行状态 |
| POST | `/api/runs/:id/advance` | 批量推进，body `{"maxSteps": N}` |
| POST | `/api/runs/:id/pause` | 暂停 |
| POST | `/api/runs/:id/resume` | 重启继续（沿用保存状态） |
| GET | `/api/runs/:id/samples?limit=N` | 已保存采样（轨迹导出用） |
| GET | `/api/runs/:id/steps/:n` | 查询指定已保存步 |
| GET | `/api/runs/:id/energy` | 能量与逐采样偏差 |
| POST | `/api/compare` | 同初态 `dt` 与 `dt/2` 对照，body 含 `tEnd` |

创建运行请求示例：

```json
{ "L": 1, "m": 1, "g": 9.81, "theta0": 0.1, "omega0": 0, "dt": 0.01, "totalSteps": 630, "sampleInterval": 10 }
```

PowerShell 调用示例：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:<port>/api/runs -Method Post -ContentType 'application/json' `
  -Body '{"L":1,"m":1,"g":9.81,"theta0":0.1,"omega0":0,"dt":0.01,"totalSteps":100}'
```

## 演示场景与核验结论

1. **静止在最低点**：`θ0=ω0=0`，任意步数后 `θ=ω=0`，能量偏差为绝对偏差且为零量级。
2. **小角度往复**：`θ0=0.1`，一个线性近似周期 `T=2π√(L/g)≈2.006 s` 后角度回到初值附近。
   线性周期仅作**有限精度参考**，不当作大幅摆动真值；不解析椭圆积分。
3. **连续圆周**：`ω0=6.5 > √(4g/L)≈6.264`（越过最高点阈值），连续 θ 单调增长超过多个 `2π`，
   `theta_wrapped` 仅用于显示。
4. **质量不影响运动**：`m` 改变 3 倍，θ、ω 轨迹相同，能量按质量成比例（3 倍）。
5. **一次推进 vs 分段 + 重启**：末态 θ、ω 与采样步集合完全一致（差值 ~1e-15，见测试）。
6. **时间反演**：积分 N 步后将末态角速度取反再积分 N 步，回到初态；测试容差 `1e-11`（`θ` 与 `ω`）。

## 旧记录重启可读

状态与采样持久保存在 `data/pendulum.db`。进程退出后重新执行 `cli list` / `cli get <id>` 可读回旧记录，
`cli resume <id>` 后继续 `advance` 即从原 θ、ω、n 续算（测试中通过重新打开数据库文件模拟进程重启）。

## 限制与合理假设

- 仅单个理想单摆；不实现双摆、碰撞、控制器、阻尼/摩擦与真实传感器采集。
- 不推导解析周期/椭圆积分；周期参考仅用线性近似并注明精度。
- `compare` 的 `tEnd` 通过 `round(tEnd/dt)` 对齐到整数步；粗细网格终止时刻为同一 `n·dt`。
- 服务监听 `127.0.0.1`，仅用于本地使用，未实现鉴权与远程部署。
