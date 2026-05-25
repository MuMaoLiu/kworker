# KHSL 隔离式 Ubuntu 开发环境技术架构设计

**版本**: v1.0
**目标硬件**: RK3568 (aarch64)
**操作系统**: OpenHarmony / KaihongOS
**Guest OS**: Ubuntu 22.04 LTS (arm64)

---

## 1. 背景与目标

为了在 OpenHarmony 设备上提供类似 WSL (Windows Subsystem for Linux) 的原生 Linux 开发体验，本项目基于 KHSL (Kaihong Subsystem for Linux) 架构，在 RK3568 开发板上引入 Ubuntu 22.04 arm64 根文件系统。
目标是实现环境隔离、空间可控、网络互通，并对齐 WSL2 的虚拟磁盘管理体验。

## 2. WSL 挂载机制分析与 KHSL 选型

### 2.1 WSL 机制简析
- **WSL1**: 直接将 Linux 根文件系统解压在 Windows NTFS 分区的特定目录下，通过 LXSS 驱动拦截系统调用。无独立块设备，文件碎片多。
- **WSL2**: 使用 Hyper-V 虚拟机，将 Linux 根文件系统存放在一个动态扩容的 **`ext4.vhdx` (虚拟磁盘文件)** 中，通过 Linux 内核原生的块设备挂载。这种方式对文件系统权限 (UID/GID/Socket/Symlink) 的兼容性最完美，且与宿主机的存储物理隔离。

### 2.2 KHSL 存储架构选型 (对齐 WSL2)
根据设备当前的存储情况（`/data` 用户数据分区剩余 10GB），我们采用 **虚拟磁盘镜像 (ext4 img) + Loop 设备挂载** 的方案：
- **不直接解压到 `/data` 目录**：避免 OpenHarmony 宿主机的权限管理（如 SELinux、DAC）与 Ubuntu 内部的 `dpkg`/`apt` 权限发生冲突，同时避免海量小文件造成的文件系统碎片。
- **采用 4GB ext4 镜像文件**：在 `/data` 分区下创建一个 4GB 的 `.img` 文件，格式化为 `ext4`，通过 `losetup` 挂载。这完全等价于 WSL2 的 `ext4.vhdx` 机制。

## 3. 整体技术架构

### 3.1 逻辑层级

```mermaid
flowchart TB
  subgraph Host [OpenHarmony 宿主环境]
    KHSL[khsl CLI]
    Daemon[kh_term_daemon]
    DataDir[/data/khsl/]
  end

  subgraph Storage [存储层 (虚拟磁盘)]
    IMG[ubuntu-22.04-arm64.img <br> 4GB ext4]
    Loop[dev/block/loopX]
  end

  subgraph Isolate [隔离与挂载层]
    MNT[mount -t ext4]
    Bind[bind mount: /proc, /sys, /dev, /dev/pts]
    NS[unshare mount namespace]
  end

  subgraph Guest [Ubuntu 22.04 环境]
    RootFS[Ubuntu Base Rootfs]
    Shell[/bin/bash]
    Apt[apt / gcc / nodejs]
  end

  KHSL --> |触发进入| Daemon
  Daemon --> NS
  DataDir --> |承载| IMG
  IMG --> |losetup| Loop
  Loop --> MNT
  MNT --> RootFS
  NS --> Bind
  Bind --> |chroot| Shell
```

### 3.2 资源与空间预算
- **宿主存储路径**: `/data/khsl/`
- **虚拟磁盘文件**: `/data/khsl/ubuntu-22.04-arm64.img`
- **磁盘空间分配**: 固定分配 **4GB** (当前 `/data` 剩余 10G，4G 预算充足且安全)。
- **内存 (RAM) 分配**: 当前设备总内存 1.9G，剩余可用约 600M。KHSL 环境内进程与宿主共享内核内存，建议在业务层面**将 KHSL 环境的峰值内存使用控制在 200MB 以内**（可通过 cgroup 限制，或仅做轻量级编译/调试），避免触发宿主机的 OOM Killer。
- **Rootfs 来源**: `ubuntu-base-22.04.5-base-arm64.tar.gz` (已下载至宿主机，体积约 27MB，解压后约 100MB+，剩余空间留给 apt 安装编译工具链)。
- **网络**: 设备直连外网，无需配置复杂的内网穿透或离线源。Ubuntu 内部直接绑定宿主的 DNS 配置即可解析公网域名。

## 4. 核心实施流程

### 阶段一：环境初始化 (Import / Install)
*对标 `wsl --import` 过程，仅需执行一次。*
1. **创建虚拟磁盘**:
   ```bash
   dd if=/dev/zero of=/data/khsl/ubuntu-22.04-arm64.img bs=1M count=4096
   mkfs.ext4 /data/khsl/ubuntu-22.04-arm64.img
   ```
2. **挂载并解压 Rootfs**:
   ```bash
   mkdir -p /data/khsl/rootfs
   mount -o loop /data/khsl/ubuntu-22.04-arm64.img /data/khsl/rootfs
   tar -xpf ubuntu-base-22.04.5-base-arm64.tar.gz -C /data/khsl/rootfs
   ```

### 阶段二：运行时挂载与隔离 (Run / Enter)
*KHSL 守护进程或 Helper 在启动 Ubuntu shell 前的准备工作。*
1. **挂载根文件系统**: `mount -o loop /data/khsl/ubuntu-22.04-arm64.img /data/khsl/rootfs` (若未挂载)。
2. **挂载伪文件系统 (Bind Mounts)**:
   - `/proc` -> `/data/khsl/rootfs/proc`
   - `/sys` -> `/data/khsl/rootfs/sys`
   - `/dev` -> `/data/khsl/rootfs/dev`
   - `/dev/pts` -> `/data/khsl/rootfs/dev/pts` (保证终端 PTY 正常工作)
3. **网络配置**:
   - 将宿主的 DNS 配置文件覆盖或 bind 到 `/data/khsl/rootfs/etc/resolv.conf`，确保 `apt update` 正常解析。
4. **进入环境**:
   - 使用 `chroot /data/khsl/rootfs /bin/bash` 进入环境。
   - (进阶) 使用 `unshare -m` 创建独立的 Mount Namespace，防止 bind mounts 污染 OpenHarmony 宿主的全局挂载表。

### 阶段三：KHSL CLI 整合
在 `khsl` 命令行中增加对 Ubuntu 环境的识别：
- 默认执行 `khsl` 时，检测 `/data/khsl/rootfs` 是否就绪，就绪则直接 chroot 进入 Ubuntu。
- 透传环境变量 (如 `TERM`, `KHSL_USER`)。

## 5. 安全与权限 (SELinux & DAC)
- `/data/khsl/ubuntu-22.04-arm64.img` 文件的 owner 需为 `root` 或特定的系统服务账户。
- `losetup` 和 `mount` 动作需要 `CAP_SYS_ADMIN` 权限，建议由 `kh_term_daemon` (以 root 运行) 完成挂载准备，再通过 `setuid` 降权或直接派生 root shell。
- **SELinux**: 需要在 `sepolicy` 中允许 `khttyd` 或 KHSL 相关的 domain 对 `/data/khsl/` 目录的 file/dir 读写权限，以及 `loop_device` 的挂载权限。

## 6. 评审点总结
1. **存储方案**: 采用 4GB ext4 img + loop 挂载，对齐 WSL2 体验，避免碎片化，是否同意？
2. **网络方案**: 依赖设备直连外网，直接使用 Ubuntu 官方 ports 源，是否同意？
3. **特权操作**: 镜像挂载与 chroot 需要 root 权限，计划由 `kh_term_daemon` 统一接管这些特权操作，是否同意？