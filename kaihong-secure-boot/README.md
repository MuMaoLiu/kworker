# KaihongOS 安全启动（OHVB / HVB）技术文档

> **目标平台**：RK3568（khdvk_rk3568_a）  
> **操作系统**：KaihongOS / OpenHarmony 6.1 L2  
> **文档版本**：v1.0  
> **更新日期**：2026-05-25

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [01-方案概述.md](./01-方案概述.md) | 背景、目标、核心结论 |
| [02-现状分析.md](./02-现状分析.md) | 当前 RK3568 启动链与代码仓缺口 |
| [03-架构设计.md](./03-架构设计.md) | 四级信任链、模块划分、与 AVB 关系 |
| [04-分阶段落地路线.md](./04-分阶段落地路线.md) | Phase 0–4 实施计划与验收标准 |
| [05-Phase0改动清单.md](./05-Phase0改动清单.md) | 开发态软校验的具体文件级改动 |
| [06-运维与管理.md](./06-运维与管理.md) | 无 BIOS 场景下的策略管理入口 |
| [07-风险与约束.md](./07-风险与约束.md) | 风险、应对、v1.0 交付范围 |

---

## 一句话定义

**OHVB（OpenHarmony Verified Boot）** 在 KaihongOS 上的落地路径，是直接基于 OpenHarmony 官方 **HVB（Harmony Verified Boot）** 增强实现，而非从零造轮子。从芯片上电到系统分区挂载，全程签名 + 校验 + 防回滚；**v1.0 不包含 BIOS 安全启动菜单**。

---

## 对标关系

| 能力 | Android | iOS | KaihongOS（本方案） |
|------|---------|-----|---------------------|
| 验签协议 | AVB 2.0 | Apple Secure Boot | **HVB 1.0**（libhvb） |
| 根校验表 | vbmeta | AMFI / IMG4 | **RVT 分区** |
| 运行时防篡改 | dm-verity | 只读系统 + AMFI | **dm-verity + fstab hvb** |
| 防回滚 | rollback_index | SEP 安全计数 | **RPMB + rollback_index** |
| 设备锁 | device lock | Activation Lock | **OTP/TEE lock_state** |
| 管理界面 | fastboot / 设置 | 无 | **CLI + 产线脚本 + fastboot**（无 BIOS） |

---

## 相关代码路径（OpenHarmony 仓）

```
base/startup/hvb/                          # 官方 HVB 库与 hvbtool
base/startup/hvb/tools/kh_hvbtool.py       # Kaihong 扩展工具
base/startup/hvb/tools/hvb_sign.py         # 镜像签名脚本
device/board/kaihong/khdvk_rk3568_a/       # RK3568 板级配置
device/soc/rockchip/tools/uboot/rk356x/  # U-Boot + HVB 集成
  ├── cmd/bootkhp.c                        # Kaihong 启动命令（含 hvb_verify）
  └── lib/hvb/                             # U-Boot 侧 HVB 实现
extension/security/tee/optee_sdk/          # OP-TEE（OTP/RPMB/设备锁）
```

---

## v1.0 交付范围

**包含：**

- HVB 全分区验签（boot / system / vendor / sys-prod / chip-prod 等）
- RVT 分区 + 构建签名流水线
- dm-verity 运行时只读保护
- RPMB 防回滚 + 设备锁
- 产线 provisioning CLI

**不包含（明确排除）：**

- BIOS 安全启动菜单
- BIOS 内开关 / 配置安全策略项

BIOS 可视化管理可在 v2.0 作为运维 UI 叠加，底层 API 不变。
