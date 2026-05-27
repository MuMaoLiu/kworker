# OHSL (OpenHarmony Subsystem for Linux) 技术架构与实现路径

本文档旨在规划于 **OpenHarmony 6.1** PC 系统上实现类似 WSL 的功能（简称 KHSL），允许开发者在系统上直接运行本地化的 Linux 环境，用于编译和开发系统源码。此功能专为创客类/开发者 PC 产品设计。

## 1. 核心架构映射 (WSL vs OHSL)

将 WSL 的组件架构映射到 OpenHarmony 的技术栈：

| 功能模块 | WSL (Windows) | OHSL (OpenHarmony PC) | 架构说明 |
| :--- | :--- | :--- | :--- |
| **底层虚拟化** | Hyper-V (Utility VM) | **KVM + Stratovirt / QEMU** | 宿主机内核基于 Linux，可直接使用 KVM，配合轻量级 VMM (如华为开源的 Stratovirt) 实现轻量级虚拟机。 |
| **宿主机后台服务** | `wslservice.exe` | **OHSL Manager (SystemAbility)** | 编写 OpenHarmony 的系统服务，负责管理 Linux VM 的生命周期、资源分配及状态监控。 |
| **命令行入口** | `wsl.exe` | **`ohsl` 命令行工具** | 宿主机侧的 CLI，通过 IPC 调用 OHSL SA 来启动/进入 Linux 环境。 |
| **Guest 初始化** | `init` (PID 1) | **定制的 `ohsl-init`** | 在 Linux 虚拟机内作为 PID 1 运行，负责挂载、网络桥接、启动 Shell 等自动化配置。 |
| **文件跨系统共享 (Host->VM)** | 9P Protocol (`plan9`) | **Virtio-fs** | 相比 9P 性能更好，适合高并发编译场景，将 OpenHarmony 的代码目录挂载到 Linux VM 内。 |
| **本地化文件浏览 (VM->Host)** | `\\wsl$\...` (P9rdr.sys) | **File Access Provider (ExtensionAbility) + 9P/Virtio-fs** | 接入 OpenHarmony 的用户文件访问框架，使 Linux 内的文件能在本地文件管理器中直接可见，无需 Samba。 |
| **互操作性 (Interop)** | `binfmt_misc` | **Virtio-serial / Vsock** | 用于 OpenHarmony 和 Linux VM 之间的命令互传与终端输入输出转发。 |
| **终端应用 (UI)** | Windows Terminal | **ArkTS Terminal App** | 基于 ArkUI 开发的系统级终端应用，作为开发者进入 OHSL 的原生图形化入口。 |

## 2. 阶段性实现路径与功能检验清单

本项目采用敏捷开发策略，前期以 CLI 和服务器版本为主，后期逐步完善 GUI 和原生体验。以下为各阶段的实现目标与检验标准（Checklist）：

### 阶段一：虚拟化底座与基础运行 (MVP - CLI First)
**目标**：在 OpenHarmony 上拉起轻量级 Linux 虚拟机，并利用现有的 VSCode 终端能力进行交互，暂不开发独立的桌面终端应用。
- [ ] **内核支持**：确认并开启 OpenHarmony 6.1 PC 版内核的 KVM 模块支持。
- [ ] **VMM 集成**：在系统中交叉编译并集成 `Stratovirt` (或 `QEMU`)。
- [ ] **镜像制作**：构建精简的 Ubuntu/Debian rootfs，预装编译依赖 (`hb`, `ninja`, `gn`, `clang` 等)。
- [ ] **基础拉起与 VSCode 接入**：通过底层命令行成功启动 Linux 镜像，并验证可通过 OpenHarmony 上运行的 VSCode 集成终端直接接入该 Linux 环境。

### 阶段二：双向无缝文件共享（核心痛点突破）
**目标**：实现宿主机与 Linux VM 之间的高性能文件共享，且支持在 OpenHarmony 文件管理器中原生浏览 Linux 文件。
- [ ] **宿主机到 VM (Virtio-fs)**：配置 Virtio-fs，将 OpenHarmony 侧的开发目录挂载到 Linux VM 内部（如 `/mnt/workspace`），并进行编译 I/O 性能测试。
- [ ] **VM 到宿主机 (原生浏览)**：开发 OpenHarmony 的 `File Access Provider` (ExtensionAbility)。
- [ ] **文件管理器集成**：通过该 Provider 对接 VM 内部的 9P 或 Virtio-fs 服务，实现在 OpenHarmony 自带的文件管理器中直接浏览、读写 Linux 系统文件（类似 `\\wsl$\` 体验，无需 Samba）。

### 阶段三：系统服务与生命周期管理
**目标**：实现 OHSL 的自动化管理与无缝交互体验。
- [ ] **OHSL Manager (SA) 开发**：开发系统服务，负责监听请求并管理 VM 的启停。
- [ ] **`ohsl` CLI 工具开发**：开发类似 `wsl` 的命令行工具。
- [ ] **终端转发 (Vsock)**：实现基于 Vsock 的终端输入输出转发，用户在终端输入 `ohsl` 即可无缝进入 Linux bash/zsh。
- [ ] **生命周期管控**：实现 VM 的后台保活、优雅关机以及异常恢复机制。

### 阶段四：原生 ArkTS 终端应用开发 (GUI 完善)
**目标**：开发类似 Windows Terminal 的系统级应用，提供完美的桌面端开发者体验。
- [ ] **ArkUI 界面开发**：开发支持多标签页、自定义主题、字体设置的终端 UI。
- [ ] **PTY/TTY 对接**：实现 ArkTS 应用与底层伪终端的交互。
- [ ] **OHSL 深度集成**：在终端应用中内置 OHSL 启动配置，实现一键打开 Linux 子系统标签页。

### 阶段五：网络与环境融合
**目标**：实现网络的互通与 Guest 内部的“秒级启动、无感接入”。
- [ ] **虚拟网络配置**：创建 TAP/TUN 设备，配置 NAT/桥接，确保 Linux VM 能访问外网。
- [ ] **`ohsl-init` 进程开发**：编写 Guest 内部的 PID 1 初始化进程，自动完成挂载、网络 IP 分配。
- [ ] **环境融合**：实现 `ohsl-init` 自动拉起用户 Shell。

## 3. 关键技术挑战与优化方向

1. **I/O 性能瓶颈**：编译源码涉及海量文件读写。必须深度优化 Virtio-fs 的 DAX (Direct Access) 机制，避免跨系统拷贝的性能损耗。
2. **File Access Framework 适配**：将 Linux 的 POSIX 文件权限、软链接等特性完美映射到 OpenHarmony 的文件访问框架中，保证在文件管理器中操作不破坏 Linux 侧的权限。
3. **内存动态回收**：编译时需要大量内存，空闲时需释放。需实现类似 WSL 的动态内存管理，当 Linux VM 内存空闲时，自动将 Page Cache 归还给宿主机。