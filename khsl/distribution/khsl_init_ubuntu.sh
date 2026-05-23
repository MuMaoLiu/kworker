#!/system/bin/sh
# KHSL Ubuntu 环境初始化脚本 (在设备端执行)
# 对应架构设计文档中的 阶段一：环境初始化 (Import / Install)

set -e

KHSL_DATA_DIR="/data/khsl"
IMG_FILE="${KHSL_DATA_DIR}/ubuntu-22.04-arm64.img"
ROOTFS_DIR="${KHSL_DATA_DIR}/rootfs"
# 兼容两种可能的文件名
TARBALL_1="/data/khsl-ubuntu-22.04-arm64.tar.gz"
TARBALL_2="/data/ubuntu-jammy-wsl-arm64-ubuntu22.04lts.rootfs.tar.gz"

if [ -f "$TARBALL_1" ]; then
    TARBALL="$TARBALL_1"
elif [ -f "$TARBALL_2" ]; then
    TARBALL="$TARBALL_2"
else
    # 尝试查找 /data 下的任意 ubuntu wsl tar.gz
    TARBALL=$(ls /data/*ubuntu*.tar.gz 2>/dev/null | head -n 1)
fi

echo "[KHSL] Starting Ubuntu 22.04 LTS (WSL version) arm64 environment initialization..."

if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
    echo "[Error] Cannot find rootfs tarball in /data/"
    echo "Please push khsl-ubuntu-22.04-arm64.tar.gz to /data/ first."
    exit 1
fi

echo "[KHSL] Using tarball: $TARBALL"

mkdir -p "$KHSL_DATA_DIR"

if [ -f "$IMG_FILE" ]; then
    echo "[KHSL] Virtual disk image already exists: $IMG_FILE, skipping creation."
    # 如果镜像存在，但我们想要确保它是健康的，这里不再强制重新格式化
    # 但如果用户手动删除了 rootfs 目录，我们需要确保它被重新解压
else
    echo "[KHSL] 1. Creating 4GB virtual disk image..."
    # 使用 dd 创建 4GB 稀疏文件或全零文件 (这里用 4096M)
    dd if=/dev/zero of="$IMG_FILE" bs=1M count=4096
    
    echo "[KHSL] 2. Formatting as ext4..."
    # OpenHarmony 环境中可能没有 mkfs.ext4，尝试使用 mke2fs
    if command -v mkfs.ext4 >/dev/null 2>&1; then
        mkfs.ext4 -F "$IMG_FILE"
    elif command -v mke2fs >/dev/null 2>&1; then
        mke2fs -t ext4 -F "$IMG_FILE"
    else
        echo "[Error] Neither mkfs.ext4 nor mke2fs found. Cannot format the image."
        echo "Please format the image manually or ensure ext4 tools are available."
        exit 1
    fi
    # 标记需要重新解压
    FORCE_EXTRACT=1
fi

mkdir -p "$ROOTFS_DIR"

# 检查是否已经挂载
if mount | grep -q "$ROOTFS_DIR"; then
    echo "[KHSL] $ROOTFS_DIR is already mounted."
else
    echo "[KHSL] 3. Mounting virtual disk to $ROOTFS_DIR..."
    
    # 直接尝试最简单的挂载方式，因为 OpenHarmony 的 mount 命令通常能自己处理 loop
    echo "[KHSL] Trying direct mount..."
    if mount -t ext4 -o loop "$IMG_FILE" "$ROOTFS_DIR"; then
        echo "[KHSL] Direct mount successful."
    else
        echo "[Error] Direct mount failed. Trying manual loop setup..."
        
        # 寻找空闲的 loop 设备
        LOOP_DEV=""
        for i in 0 1 2 3 4 5 6 7 8 9; do
            # Check if the loop device is already in use
            if ! losetup "/dev/loop$i" >/dev/null 2>&1 && ! losetup "/dev/block/loop$i" >/dev/null 2>&1; then
                # Use /dev/block/loopX as it's more common in OpenHarmony
                LOOP_DEV="/dev/block/loop$i"
                break
            fi
        done
        
        if [ -n "$LOOP_DEV" ]; then
            echo "[KHSL] Using loop device: $LOOP_DEV"
            if [ ! -e "$LOOP_DEV" ]; then
                echo "[KHSL] Creating device node $LOOP_DEV..."
                LOOP_NUM=$(echo "$LOOP_DEV" | grep -o '[0-9]*')
                mknod "$LOOP_DEV" b 7 "$LOOP_NUM" || true
            fi
            echo "[KHSL] Attaching image to $LOOP_DEV..."
            losetup "$LOOP_DEV" "$IMG_FILE"
            echo "[KHSL] Mounting $LOOP_DEV to $ROOTFS_DIR..."
            mount -t ext4 "$LOOP_DEV" "$ROOTFS_DIR"
        else
            echo "[Error] Could not find or create a free loop device."
            exit 1
        fi
    fi
fi

# 检查是否已经解压过 (简单判断 bin/bash 是否存在)
if [ -z "$FORCE_EXTRACT" ] && [ -f "${ROOTFS_DIR}/bin/bash" ]; then
    echo "[KHSL] Rootfs seems already extracted, skipping."
else
    echo "[KHSL] 4. Extracting Rootfs to virtual disk..."
    tar -xpf "$TARBALL" -C "$ROOTFS_DIR"
    echo "[KHSL] Extraction completed."
fi

# 基础网络配置 (复制宿主机的 resolv.conf)
echo "[KHSL] 5. Configuring basic network DNS..."
# 删除可能存在的软链接，确保写入实体文件
rm -f "${ROOTFS_DIR}/etc/resolv.conf"
# 优先拷贝宿主机的 DNS 配置，确保内网/特定网络下能正常解析
if [ -f "/etc/resolv.conf" ]; then
    cp /etc/resolv.conf "${ROOTFS_DIR}/etc/resolv.conf"
else
    echo "nameserver 114.114.114.114" > "${ROOTFS_DIR}/etc/resolv.conf"
    echo "nameserver 8.8.8.8" >> "${ROOTFS_DIR}/etc/resolv.conf"
fi

echo "[KHSL] 5.5 Configuring /etc/hosts..."
# 修复 sudo: unable to resolve host localhost 警告
echo "127.0.0.1 localhost" > "${ROOTFS_DIR}/etc/hosts"
echo "::1 localhost ip6-localhost ip6-loopback" >> "${ROOTFS_DIR}/etc/hosts"

echo "[KHSL] 6. Configuring APT sources (USTC mirror)..."
# 备份官方源（官方源自带 GPG 签名配置，但国内速度慢）
if [ ! -f "${ROOTFS_DIR}/etc/apt/sources.list.bak" ]; then
    cp "${ROOTFS_DIR}/etc/apt/sources.list" "${ROOTFS_DIR}/etc/apt/sources.list.bak"
fi

# 替换为国内镜像源 (使用 HTTPS 协议，WSL 镜像自带了证书和 GPG)
cat << 'INNER_EOF' > "${ROOTFS_DIR}/etc/apt/sources.list"
deb [trusted=yes] http://mirrors.aliyun.com/ubuntu-ports/ jammy main restricted universe multiverse
deb [trusted=yes] http://mirrors.aliyun.com/ubuntu-ports/ jammy-updates main restricted universe multiverse
deb [trusted=yes] http://mirrors.aliyun.com/ubuntu-ports/ jammy-security main restricted universe multiverse
deb [trusted=yes] http://mirrors.aliyun.com/ubuntu-ports/ jammy-backports main restricted universe multiverse
INNER_EOF

# WSL风格：初始化由 kh_term_daemon 首次进入时提示用户创建
# 这里不再默认创建 root 用户，而是保持干净，等待首次启动时提示
echo "[KHSL] Initialization completed!"
echo "You can test entering the environment with the following commands:"
echo "  mount --bind /proc ${ROOTFS_DIR}/proc"
echo "  mount --bind /sys ${ROOTFS_DIR}/sys"
echo "  mount --bind /dev ${ROOTFS_DIR}/dev"
echo "  chroot ${ROOTFS_DIR} /bin/bash"
