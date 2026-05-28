# KHP-IC204（L0）TsFile 端侧能力 — PRD 与工程规格

| 项目 | 说明 |
|------|------|
| 文档版本 | v0.2 |
| 日期 | 2026-05-28 |
| **当前实现 Profile** | **家用极简 `HOME_MINIMAL`**（§4.0） |
| 端侧产品 | `khp_esp32_ic204`（L0，ESP32 + KaihongOS mini / LiteOS-M） |
| 对端 | L2：`khdvk_rk3568_a`（RK3568）；联调期 Windows 宿主机 |
| 技术路线 | **方案 A**：C 轻量 TsFile Reader/Writer，**字节级兼容 IoTDB 1.3** 可导入的 `.tsfile` |
| 代码落位（规划） | `extension/IoTDB/liteos_m`（L0）、`extension/IoTDB/standard`（L2/标准侧）；**暂不实现** `liteos_a`（L1） |
| 参考 | [IoTDB 存储引擎](https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=177051877)、[TsFile Format](https://cwiki.apache.org/confluence/display/IOTDB/TsFile+Format)、[TsFile API](https://iotdb.apache.org/UserGuide/V1.2.x/API/Programming-TsFile-API.html) |

---

## 1. 背景与目标

### 1.1 背景

L0 适配器（IC204）当前以 JSON/逐点方式上报物模型数据，带宽与 Flash 占用高，挤压端侧算力空间。Apache IoTDB 的 **TsFile** 为面向 IoT 的列式时序文件格式，可在端侧聚合、压缩后传输，由 L2 解析并转换为数字孪生平台数据契约再上云。

### 1.2 目标

1. 在资源受限的 LiteOS-M 上实现 **TsFile 读写库**（非完整 IoTDB 存储引擎）。
2. 按可配置 **时间窗口** 滚动生成 `.tsfile`（**当前：900 s**），经 **以太网 Socket**（现阶段）传至 Windows/L2；后续切换 **软总线**（TLS 由传输层承担，TsFile 本体不加密）。
3. L2 可 **直接查询** 端侧 TsFile 内容；L2 亦可 **控制 L0**（读/写/滚动策略等）。
4. 支撑 **分布式物模型**：L0/L2 各自处理不同量级物模型，互相通信时按设备层级负载均衡；端侧完成 **聚合与异常检测**，TsFile 携带 **算子结果测点**。
5. MVP 验收：生成 **1 个可被 IoTDB 1.3 导入** 的 `.tsfile`；相对 JSON 上报，L2 侧 **压缩率降低 ≥ 60%**。

### 1.3 非目标（当前阶段）

- 不在 L0 实现 IoTDB 完整 LSM/MemTable/文件合并引擎。
- 不实现墓碑删除/modification file（仅 **滚动刷新 + 追加**）。
- TsFile 文件级加密（依赖传输层 TLS）。
- L1 `liteos_a` 移植。
- L2 侧 IoTDB 服务部署（联调期以 Windows + 简单收发识别 TsFile 魔数/类型为主）。

---

## 2. 系统架构

```text
┌─────────────────────────────────────────────────────────────────┐
│ L0: khp_esp32_ic204 (LiteOS-M)                                   │
│  传感器/物模型 → 聚合/异常检测 → TsFile Writer/Reader (C)        │
│       ↓ 本地队列(≤5min)  滚动 .tsfile  Flash 池                   │
│       ↓ ETH Socket (现) / SoftBus (后) + TLS                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ L2: RK3568 (standard 侧，后续)                                    │
│  接收 TsFile → 解析 → 数字孪生契约 → 云 Topic                      │
│  控制 L0：查询/触发滚动/读回测点等（经软总线，Socket 阶段可模拟）   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                     数字孪生平台 / 云
```

### 2.1 数据流与职责

| 阶段 | 行为 |
|------|------|
| 采集 | 物模型属性 ID 映射为 TsFile `device path` + `measurement`（路径规范 v0.1 由本规格附录定义） |
| 端侧计算 | 聚合、异常检测，结果作为独立 **算子结果测点** 写入同一 Aligned Chunk Group |
| 落盘 | 窗口封口（**当前 900 s**）→ 追加写 `.tsfile` → 入本地发送队列 |
| 传输 | 断点续传 + 重传；**无应用层 ACK**（依赖软总线可靠语义；Socket 阶段可实现简化确认供联调） |
| L2 | 解析 TsFile → 转数字孪生契约 → 既有 **Topic** 上云 |

---

## 3. 功能需求（PRD）

### 3.1 TsFile 能力

| ID | 需求 | 优先级 |
|----|------|--------|
| F-01 | C 库实现 **Writer**：生成 IoTDB 1.3 可导入的标准 `.tsfile` | P0 |
| F-02 | C 库实现 **Reader**：按时间/测点读取 Chunk/Page（供 L2 控制查询与 L0 自检） | P0 |
| F-03 | 支持 **Aligned Chunk Group**（多测点共享时间戳） | P0 |
| F-04 | **当前实现**：**4～6 × FLOAT @ 1/60Hz**（窗内 15 点）；扩展预留 BOOL/INT32/INT64/DOUBLE/TEXT；厂站 Profile 见 §4.1 | P0/P1 |
| F-05 | 仅 **滚动新文件 + 文件内追加**，无删除/墓碑 | P0 |
| F-06 | 编码/压缩可配置裁剪（如 PLAIN + 可选 RLE；压缩 SNAPPY/LZ4 子集或关闭） | P0 |
| F-07 | 字节级与 **IoTDB 1.3 TsFile** 兼容（Magic、版本、索引区、Chunk 布局对齐官方格式） | P0 |
| F-08 | 算子结果测点与原始测点同文件、同 device 对齐写入 | P1 |

### 3.2 传输与队列

| ID | 需求 | 优先级 |
|----|------|--------|
| T-01 | 现阶段：**ETH Socket** 与 Windows 互通；帧内标识 payload 为 **TsFile**（魔数 + 长度 + 分片序号） | P0 |
| T-02 | 后续：**软总线** 承载同一帧格式，复用安全/TLS 能力 | P1 |
| T-03 | **断点续传**：按字节偏移/分片序号续传 | P0 |
| T-04 | **失败重传** + **本地发送队列**；**无应用层 ACK** | P0 |
| T-05 | 队列与未确认文件 **最长缓存 5 min**，超时丢弃或滚动覆盖（策略可配置，默认覆盖最旧） | P0 |
| T-06 | 触发条件：**时间窗口封口上传**（**当前 900 s**）；传输 **256 B/分片**，单体文件见 §4.0 | P0 |

### 3.3 L2 控制 L0

| ID | 需求 | 优先级 |
|----|------|--------|
| C-01 | L2 可请求 L0：查询指定时间范围 TsFile/测点、触发封口、查询队列状态 | P1（Socket 阶段定义简单命令字） |
| C-02 | 命令通道与数据通道可同 Socket 不同 opcode，后续映射软总线 | P1 |

### 3.4 物模型与分布式语义

| ID | 需求 | 说明 |
|----|------|------|
| M-01 | 时序路径对齐 **物模型属性 ID** | v0.1 命名见 §7 |
| M-02 | 物模型 JSON 仍可作为 L0→L2/云的控制与配置面 | TsFile 承载高频时序面 |
| M-03 | **分布式物模型**：L0/L2 按层级处理不同粒度；互相通信时可下发/上报不同量级模型 | 架构约束，TsFile 为时序载荷 |
| M-04 | 端侧 **聚合 + 异常检测** 结果写入 TsFile | 作为独立 measurement |

---

## 4. 场景 Profile、TsFile 规格与资源占用

### 4.0 当前实现基线：`HOME_MINIMAL`（家庭燃气智控 · 极简）

> **代码与联调均按本 Profile 实施**；厂站 Profile 仅作后续扩展参考（§4.1）。

| 参数 | 规格值 | 说明 |
|------|--------|------|
| 场景 | 家庭燃气智控器（极简） | 浓度/阀状态/报警/电池等 |
| 测点数 `N_float` | **4～6**（实现取 **6**） | Aligned，共享时间戳 |
| 滚动窗口 | **900 s**（15 min） | `KH_TSFILE_WINDOW_SEC=900` |
| 采样间隔 | **60 s**（1 点/分钟） | 窗内点数 `N_t = 15` |
| Chunk 模式 | **Aligned** | PLAIN + 无压缩（MVP） |
| **单体 `.tsfile` 上限** | **2 KB** | 规划值；实测裸数据约 0.4～0.7 KB，含索引留足余量 |
| **传输分片** | **256 B** | 2 KB 文件 ≈ **8～10 片**（含帧头） |
| **Flash 配额** | **32 KB** | 路径 `/extflash/tsfile/`；约可轮转 **10～12** 个 2 KB 级文件 |
| 最大并发文件数 | **12**（建议） | 在 32 KB Flash 内可配置 |
| 队列缓存 | **≤ 900 s** | 与窗口一致；超时覆盖最旧待传 |
| 告警/关阀 | **不走 TsFile** | 秒级小帧 / 物模型 Topic |

**体积估算（6 测点，900 s，60 s 间隔，PLAIN/NONE）：**

```text
N_t = 900 / 60 = 15
裸数据 = 8×N_t + 4×N_t×N_float = 120 + 360 = 480 B  （N_float=6）
单体文件 ≈ 480 × (1.2～1.4) ≈ 0.6～0.7 KB（典型）
规划上限 2 KB（含路径字符串、索引、算子测点预留）
```

**示例测点（6 路，物模型 propertyId 对齐）：**

| measurement | 含义 |
|-------------|------|
| `ch4_ppm` | 燃气浓度 |
| `valve_state` | 阀状态（0/1 作 FLOAT 或 P1 改 BOOL） |
| `alarm_level` | 报警等级 |
| `battery_pct` | 电池电量 |
| `flow_instant` | 瞬时流量（可选） |
| `rssi` | 信号强度（可选） |

---

### 4.1 两类应用场景对照（规格 + 占用 KB）

| 项 | **Profile A：`HOME_MINIMAL`**（当前实现） | **Profile B：`STATION_STD`**（燃气厂站 · 参考） |
|----|------------------------------------------|-----------------------------------------------|
| 典型设备 | 家庭燃气智控器、IC204 接家用传感器 | 调压站/门站边缘网关 |
| 测点数 | **4～6**（实现 6） | **15～30**（关键运行包） |
| 滚动窗口 | **900 s**（15 min） | **300 s**（5 min） |
| 采样间隔 | **60 s** | **1 s**（1 Hz）或 **5 s** |
| 窗内点数 `N_t` | **15** | **300**（5 min @ 1 Hz） |
| Aligned | 是 | 是 |
| 编码/压缩 | PLAIN / NONE | PLAIN / NONE（后续可选 LZ4） |
| **裸数据（KB）** | **≈ 0.47～0.59**（4～6 点） | **≈ 26.4**（20 点@1Hz×5min） |
| **单体 `.tsfile`（KB）** | **0.6～0.7 典型，上限 2** | **17～21**（10 点）/ **30～38**（20 点）/ **43～55**（30 点） |
| **传输分片** | **256 B** | **256 B**（大文件约 70～150 片） |
| **Flash 配额（KB）** | **32** | **64～128**（推荐） |
| 并发文件数 | 10～12 | 3～5（文件大） |
| 队列缓存 | 900 s | 300～900 s |
| 上报节奏 | 15 min 一包 TsFile + 告警直传 | 5 min 一包 + 安全量秒级旁路 |
| RAM 池（32 KB 档 40%） | **≈ 13 KB** 足够 | 建议 **128 KB+** 设备或 **≥ 51 KB** 池 |

**Profile B 常用档位速查（5 min 窗口，PLAIN/NONE，Aligned）：**

| 测点数 | 采样 | N_t | 裸数据 | 单体文件（约） |
|--------|------|-----|--------|----------------|
| 10 | 1 Hz | 300 | 14.4 KB | **17～21 KB** |
| 20 | 1 Hz | 300 | 26.4 KB | **30～38 KB** |
| 30 | 1 Hz | 300 | 38.4 KB | **43～55 KB** |
| 20 | 5 s | 60 | 5.3 KB | **6～8 KB** |

**Profile A 扩展档位（仍属家用，非当前实现）：**

| 测点数 | 窗口 | 间隔 | N_t | 单体文件（约） |
|--------|------|------|-----|----------------|
| 10 | 900 s | 60 s | 15 | **0.8～1.5 KB** |
| 10 | 300 s | 60 s | 5 | **0.4～0.8 KB** |
| 10 | 300 s | 1 Hz | 300 | **17～21 KB**（插电极端，一般不选） |

---

### 4.2 通用体积公式

```text
N_t      = 窗口(秒) / 采样间隔(秒)
裸数据 B = 8×N_t + 4×N_t×N_float          # Aligned：1 列 INT64 时间 + N_float 列
文件 KB  ≈ 裸数据 × (1.2～1.4) / 1024     # PLAIN、无压缩
分片数   ≈ ceil(文件大小 / 256)            # 传输分片，非文件上限
```

---

### 4.3 存储与传输（当前 `HOME_MINIMAL`）

| 参数 | 值 | 备注 |
|------|-----|------|
| TsFile 专用 Flash | **32 KB** | `/extflash/tsfile/` |
| 单体 `.tsfile` 上限 | **2 KB** | Seal 时校验；超限返回错误 |
| 传输分片 payload | **256 B** | §6.3 帧格式；**非**单体文件大小 |
| 最大并发文件数 | **12** | 32 KB ÷ 2 KB 量级，留元数据余量 |
| 滚动策略 | **900 s** 封口；满配额覆盖最旧 **待传** 文件 | 无墓碑 |

**256 B 分片约定（已关闭 O-01）：** 仅用于 ETH/Socket **断点续传**；接收端按 `offset` 重组为完整 `.tsfile` 后送 IoTDB 1.3 `import`。

---

### 4.4 内存（固定内存池 · 当前实现）

| 设备档位 | 典型 RAM | TsFile 池上限（**40%**） |
|----------|----------|-------------------------|
| 低频（IC204 默认） | 32 KB | **≈ 12.8 KB** |
| 高频传感器 | ≥ 500 KB | **≥ 200 KB** |

**`HOME_MINIMAL` 池内划分：**

| 子池 | 大小 | 说明 |
|------|------|------|
| 写缓冲 | 2 KB | 与单体文件上限一致 |
| 读缓冲 | 1 KB | Reader 切片 |
| 发送队列元数据 | 1 KB | ≤12 文件 × 状态/偏移/分片号 |
| 路径/Schema | 0.5 KB | ≤6 measurement 名 |
| 协议帧缓冲 | 1 KB | 256 B payload + 帧头 |
| 保留 | ~7 KB 内余量 | 对齐、临时统计 |

> 切换到 `STATION_STD` 时通过 `kh_tsfile_config.h` 切换 `KH_TSFILE_PROFILE` 并放大写缓冲与 Flash。

---

### 4.5 数据类型（全量规划）

BOOL, INT32, INT64, FLOAT, DOUBLE, TEXT 均纳入类型系统；**当前仅启用 FLOAT**（`valve_state` 等可用 0/1.0 表示，P1 再改 BOOL）。

---

## 5. 性能指标（验收基线）

### 5.1 当前实现：`HOME_MINIMAL`（6 点 × 900 s × 60 s 间隔）

在 **ESP32 @ 240MHz、Aligned、PLAIN/NONE** 条件下：

| 指标 | 目标值 | 测量方法 |
|------|--------|----------|
| 单窗口（900 s）封口写盘 | ≤ **50 ms** | 窗结束 → 2 KB 内 `.tsfile` 可读 |
| 每分钟写入路径 | ≤ **10 ms** | `KhTsFileWriteAligned` 单次 |
| Writer CPU 均摊 | ≤ **2%** | 15 点/15 min |
| Reader 读满窗 15 点/测点 | ≤ **30 ms** | L2 控制查询 |
| Socket 传满 2 KB（≈10 片×256 B） | ≤ **200 ms** | 100BASE-T |
| 断点续传恢复 | ≤ **300 ms** | 掐断后续传 |
| 压缩率 vs JSON | **≥ 40%** 体积下降 | 同等 6 点×15 点 JSON 对象 vs `.tsfile` |
| 重传成功率 | ≥ **99%**（实验室） | 人为丢片 |
| 内存池峰值 | ≤ RAM **40%** | 静态池 |

### 5.2 参考：`STATION_STD`（厂站 20 点 × 5 min × 1 Hz）

| 指标 | 目标值 |
|------|--------|
| 封口写盘 | ≤ **200 ms**（~35 KB 文件） |
| Reader 读 300 点/测点 | ≤ **100 ms** |
| 压缩率 vs JSON | **≥ 60%** |
| Flash | 64～128 KB 档 |

---

## 6. 技术规格（Engineering Spec）

### 6.1 兼容性与版本

| 项 | 规格 |
|----|------|
| 目标 IoTDB 版本 | **1.3.x**（TsFile 导入） |
| 兼容策略 | **冻结子集 + 官方 Magic/版本号**；新 TsFile 特性通过 capability 位声明 |
| 对齐格式 | [TsFile Format](https://cwiki.apache.org/confluence/display/IOTDB/TsFile+Format) 中 Aligned Chunk Group、ChunkHeader、Page |

### 6.2 Writer/Reader 模块划分（`extension/IoTDB/liteos_m`）

```text
extension/IoTDB/liteos_m/
├── include/
│   ├── kh_tsfile.h           # 对外 API
│   ├── kh_tsfile_types.h     # TSDataType / 编码枚举
│   └── kh_tsfile_config.h    # KH_TSFILE_PROFILE, WINDOW_SEC, 池/Flash 宏
├── core/
│   ├── writer/               # 封口、追加、索引写
│   ├── reader/               # 按时间/测点查询
│   ├── encode/               # PLAIN, (RLE)
│   ├── compress/             # NONE, (LZ4/SNAPPY 可选)
│   ├── aligned/              # 时间戳列 + 值列 + null bitmap
│   └── io/                   # extflash 抽象
├── transport/
│   ├── kh_tsfile_frame.h     # 魔数 KHTF / 分片头
│   └── eth_socket.c            # 现阶段
└── BUILD.gn
```

`extension/IoTDB/standard/`（L2）：接收、重组、IoTDB 导入适配、数字孪生契约转换、后续软总线服务端。

### 6.3 传输帧格式（Socket / 软总线通用）

| 偏移 | 长度 | 字段 | 说明 |
|------|------|------|------|
| 0 | 4 | magic | `0x4B 0x48 0x54 0x46`（"KHTF"）或复用 TsFile 文件 magic 作通道标识 |
| 4 | 1 | version | 0x01 |
| 5 | 1 | type | 0=数据分片, 1=控制命令, 2=心跳 |
| 6 | 2 | flags | bit0 断点续传, bit1 最后一片 |
| 8 | 4 | file_id | 滚动文件 ID |
| 12 | 4 | offset | 文件内偏移 |
| 16 | 2 | len | 本片长度 |
| 18 | N | payload | TsFile 字节或控制 JSON |

> 联调期 Windows 工具：识别 magic → 落盘 `.tsfile` → 调用 IoTDB 1.3 `import` 验证。

### 6.4 本地队列状态机

```text
EMPTY → ACCUMULATING → SEALED → QUEUED → SENDING → DONE
                              ↘ FAILED → RETRY (≤N) → DROP/TOMBSTONE(仅元数据)
```

- **SEALED**：窗口到时（**当前 900 s**）或 L2 手动封口。
- **缓存上限**：与窗口一致（**当前 900 s**）；最旧 SEALED/FAILED 超时 → **覆盖**（默认）。
- **无 ACK**：发送侧重传基于超时；接收侧仅校验 magic/长度/CRC（可选 CRC16 占 2B，不视为业务 ACK）。

### 6.5 API 草案（C）

```c
/* 初始化：绑定内存池、Flash 路径、窗口秒数 */
int KhTsFileInit(const KhTsFileConfig *cfg);

/* 写入：同一 device 下多 measurement，共享 timestamp_ms */
int KhTsFileWriteAligned(const char *device_path,
                         int64_t timestamp_ms,
                         const KhMeasurement *points, int count);

/* 封口：生成当前窗口 .tsfile，返回 file_id */
int KhTsFileSeal(uint32_t *file_id);

/* 读：L2 查询 */
int KhTsFileReadRange(uint32_t file_id,
                      const char *measurement,
                      int64_t start_ms, int64_t end_ms,
                      KhTsFileCursor *cursor);

/* 传输：取下一发送分片 */
int KhTsFileTxNext(KhTsFileTxSlice *slice);
```

### 6.6 编码/压缩默认（MVP）

| 类型 | encoding | compression |
|------|----------|-------------|
| FLOAT（原始） | PLAIN | NONE |
| FLOAT（聚合 avg 等） | PLAIN | NONE |
| TEXT（P1） | PLAIN | NONE |
| 后续优化 | RLE（同值多） | LZ4（若 ROM 允许） |

### 6.7 与 khp_esp32_ic204 集成

| 集成点 | 说明 |
|--------|------|
| 产品配置 | `vendor/kaihong/khp_esp32_ic204/config.json` 增加 `kh_iotdb_tsfile` 组件（后续） |
| 存储路径 | `init_lite_data_path` → `/extflash/tsfile/` |
| 网络 | 现有 Ethernet Demo / `communication_task_lite` 扩展 |
| 依赖 | `utils_lite` 文件接口、mbedtls（仅传输层，已由系统使用） |

---

## 7. 时序路径与物模型映射（v0.1）

在物模型属性 ID 未冻结前，采用可配置前缀：

```text
root.{productId}.{deviceId}.{propertyId}
```

| 字段 | 来源 | 示例 |
|------|------|------|
| productId | `const.khos.productId` | `OH00007T` |
| deviceId | 设备唯一标识 | `ic204-001` |
| propertyId | 物模型属性 ID | `temperature` |
| 算子测点 | 约定后缀 | `{propertyId}_avg`, `{propertyId}_anomaly` |

**Aligned 约定**：同一 `device_path` 下各 measurement 共享窗内时间戳列（**当前每 60 s 一个戳，共 15 个**）；缺测不写 null（省略该列当次采样）。

---

## 8. 里程碑与交付物

| 阶段 | 交付 | 验收 |
|------|------|------|
| M0 可行性 | PC/L0 生成 `HOME_MINIMAL` `.tsfile`，IoTDB 1.3 import | 导入成功 |
| M1 Writer | **6×FLOAT，900 s 窗，60 s 间隔**，Seal ≤2 KB | 6×15=90 点/测点 |
| M2 传输 | Windows Socket，**256 B 分片** 重组 | CRC 一致 |
| M3 Reader | L0 读回 + L2 控制（模拟） | 读回误差 0 |
| M4 队列 | 断点续传/重传/**900 s** 缓存，Flash 32 KB | 掐断恢复 |
| M5 算子测点 | P1：聚合/异常检测 measurement | L2 解析 |
| M6 压缩率 | JSON 对比（6 点×15 点） | ≥40% |
| M7 SoftBus | 替换 Socket，帧格式不变 | 同 M2 |
| M8 厂站 | 切换 `STATION_STD` Profile | 按 §4.1 Profile B |

---

## 9. 测试要点

1. **兼容性**：IoTDB 1.3 CLI/API `import` 生成的文件。
2. **压力**：连续 24h 滚动（15 min/文件）不溢出 **32 KB** Flash 池。
3. **内存**：池水位不超过 40%；无 malloc 碎片（仅静态池）。
4. **异常**：Seal 中断电 → 下次启动丢弃未完成文件或标记损坏。
5. **对比**：同等数据 JSON line-delimited vs TsFile 体积。

---

## 10. 开放问题

| # | 问题 | 状态 |
|---|------|------|
| O-01 | 256 B = **传输分片**；单体文件 **2 KB** | **已关闭** |
| O-02 | Socket 联调端口、Windows 工具仓库位置 | M2 前 |
| O-03 | 算子测点清单与异常检测算法接口 | M5 前 |
| O-04 | 数字孪生 Topic 字段映射表（L2 standard） | 与 L2 并行 |
| O-05 | IoTDB 1.3 具体 patch 版本与 import 命令 | M0 |
| O-06 | `STATION_STD` 切换时机与 RK3568 Flash | M8 前 |

---

## 11. 文档修订记录

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| v0.1 | 2026-05-28 | — | 根据 L0/L2 需求澄清初稿 |
| v0.2 | 2026-05-28 | — | 增加家用/厂站两档 Profile；当前实现 `HOME_MINIMAL`（6 点/900 s/60 s/2 KB/32 KB Flash/256 B 分片） |

---

## 附录 A：需求追溯矩阵

| 用户澄清项 | 本文档章节 |
|------------|------------|
| L2=RK3568 | §1, §2 |
| 暂无 IoTDB，先 Socket 标识 TsFile | §3.2, §6.3 |
| L2 可查询，先 ETH→Windows | §2, §3.3 |
| 读写兼备 | §3.1 F-01/F-02 |
| 滚动+追加 | §3.1 F-05 |
| 字节级兼容 | §3.1 F-07, §6.1 |
| 物模型属性 ID | §7 |
| 当前 4～6 点 / 900 s / 60 s | §4.0 |
| 家用/厂站 Profile 与 KB | §4.1 |
| Aligned | §3.1 F-03 |
| 全类型规划 | §4.5 |
| 900 s 窗口 / 256 B 分片 / 2 KB 文件 | §4.0, §4.3 |
| 断点续传/重传/队列/无ACK | §3.2, §6.4 |
| TLS 不传文件加密 | §1.3 |
| Flash 32 KB / 12 文件 | §4.3 |
| 内存池 40% | §4.4 |
| 厂站 20 点×5 min 体量 | §4.1 Profile B |
| 可裁剪编码压缩 | §3.1 F-06, §6.6 |
| IoTDB 1.3 + Windows 联调 | §6.1, §8 M0 |
| 分布式物模型/端侧聚合 | §3.4 |
| 算子结果测点 | §3.4 M-04 |
| 数字孪生 Topic | §2.1 |
| 验收：import + 压缩率 60% | §1.2, §5 |
| 方案 A，C 库 | §1, §6.2 |
| 代码 extension/IoTDB/* | §6.2 |
