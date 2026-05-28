# 05 - Phase 0 改动清单

> 开发态软校验，零 fuse 风险。以下路径均相对于 OpenHarmony 代码仓根目录。

## 1. 分区表

**文件**：`device/board/{company}/khdvk_rk3568_a/loader/parameter.txt`

**当前**（节选）：

```
CMDLINE:...0x00002000@0x00690000(factory),-@0x00800000(userdata:grow)
```

**建议改动**：从 `factory` 或 `misc` 划出 512KB（0x400 扇区 @ 512B）给 `rvt`：

```
# 示例：在 factory 前插入 rvt
...,0x00000400@0x00690000(rvt),0x00002000@0x00694000(factory),...
```

**同步修改**：

- `device/board/{company}/khdvk_rk3568_a/package_file/khdvk_rk3568_a_package_file` 增加：
  ```
  rvt    Image/rvt.img
  ```

---

## 2. U-Boot defconfig

**文件**：`device/board/{company}/khdvk_rk3568_a/uboot/configs/khdvk_rk3568_a_defconfig`

**追加配置**：

```ini
# HVB 核心
CONFIG_HVB_LIBHVB=y
CONFIG_HVB_LIBHVB_USER=y
CONFIG_RK_HVB_LIBHVB_USER=y

# Kaihong 启动命令（含 hvb_verify）
CONFIG_CMD_BOOT_KAIHONG=y

# 走 bootkhp 启动路径（rockchip-common.h）
CONFIG_FIT_SIGNATURE=y
```

**可选（Phase 2 再开）**：

```ini
CONFIG_HVB_VBMETA_PUBLIC_KEY_VALIDATE=y
CONFIG_RK_HVB_LIBHVB_ENABLE_ATH_UNLOCK=y
```

---

## 3. 内核 defconfig（Phase 1，可 Phase 0 预开）

**文件**：`device/board/{company}/khdvk_rk3568_a/kernel/config/khdvk_rk3568_a/khdvk_rk3568_a_defconfig`

**修改**：

```diff
-# CONFIG_BLK_DEV_DM is not set
+CONFIG_MD=y
+CONFIG_BLK_DEV_DM_BUILTIN=y
+CONFIG_BLK_DEV_DM=y
+CONFIG_DM_BUFIO=y
+CONFIG_DM_ZERO=y
+CONFIG_DM_INIT=y
+CONFIG_DM_VERITY=y
+CONFIG_DM_VERITY_VERIFY_ROOTHASH_SIG=y
```

---

## 4. fstab（Phase 1）

**文件**：`vendor/{company}/khdvk_rk3568_a/startup/init/cfg/fstab.rk3568`

**修改示例**：

```diff
-/dev/block/.../system    /usr       ext4  ro,barrier=1  wait,required
+/dev/block/.../system    /usr       ext4  ro,barrier=1  wait,required,hvb
```

vendor / sys-prod / chip-prod 同理追加 `,hvb`。

---

## 5. 密钥与产线文件（首次）

**工作目录**：`base/startup/hvb/tools/`

```bash
# 1. 生成 product_id
python3 kh_hvbtool.py generate_product_id_bin \
  --product_name khdvk_rk3568_a --output product_id.bin

# 2. 生成密钥
mkdir -p keys
openssl genrsa -out keys/prk_priv.pem 4096
openssl rsa -pubout -in keys/prk_priv.pem -out keys/prk_pub.pem
openssl genrsa -out keys/psk_priv.pem 4096
openssl rsa -pubout -in keys/psk_priv.pem -out keys/psk_pub.pem

# 3. 生成 salt
python3 kh_hvbtool.py generate_salt_bin --output salt.bin

# 4. 生成永久属性
python3 kh_hvbtool.py make_htx_permanent_attributes \
  --output permanent_attributes.bin \
  --root_authority_key keys/prk_pub.pem \
  --product_id product_id.bin
```

> ⚠️ 私钥离线保管，不入代码仓。公钥 / product_id 按产线规范分发。

---

## 6. 构建签名集成

**文件**：`base/startup/hvb/tools/hvb_sign.py`

**参与签名的镜像**（脚本内已定义）：

```python
_HVB_IMAGES = ['rvt', 'boot_linux', 'resource', 'ramdisk',
               'system', 'vendor', 'sys_prod', 'chip_prod']
```

**构建后手动执行**（Phase 0）：

```bash
cd base/startup/hvb/tools
python3 hvb_sign.py sign --product_name khdvk_rk3568_a
```

**后续集成点**（Phase 0 后期）：在镜像打包脚本末尾自动调用，参考 Kaihong RK3588 产品 `kh_readme.md` 中的流程。

---

## 7. U-Boot 验签分区列表

**文件**：`device/soc/rockchip/tools/uboot/rk356x/lib/hvb/uboot_hvb.c`

**当前**：

```c
const char *hash_ptn_list[] = {"boot_linux", "resource", "ramdisk", NULL};
char *rootPartitionName = "rvt";
```

**Phase 1 扩展**（system 等由 init dm-verity 校验，U-Boot 侧可选择性加入）：

- boot 阶段：hash 类型分区在 U-Boot 验签
- system 等 hashtree 分区：U-Boot 验签 footer + init 启用 dm-verity

---

## 8. 验证步骤

### 8.1 编译

```bash
# 全量编译（按现有 OpenHarmony 构建流程）
./build.sh --product-name khdvk_rk3568_a ...
```

### 8.2 签名

```bash
python3 base/startup/hvb/tools/hvb_sign.py sign --product_name khdvk_rk3568_a
```

### 8.3 刷机

```bash
# 使用现有烧录工具刷入完整 GPT 镜像
```

### 8.4 串口验证

预期 log：

```
[hvb] bootloader boot flow start hvb verify
[hvb] update_bootargs
[hvb] hvb verify finish in uboot, errorcode: 0x0
```

### 8.5 篡改测试

```bash
# 在 host 上修改 system.img 任意字节后重新刷入
# 预期：U-Boot 报 hvb verify failed，不启动内核
```

### 8.6 unlock 调试

```bash
# 通过 OP-TEE / kh_hvbtool 设置 lock_state=1
# 预期：[hvb] Warning! unlocked，跳过校验正常启动
```

---

## 9. 改动文件汇总

| 文件 | Phase | 改动类型 |
|------|-------|----------|
| `loader/parameter.txt` | 0 | 增加 rvt 分区 |
| `package_file/khdvk_rk3568_a_package_file` | 0 | 增加 rvt.img |
| `uboot/configs/khdvk_rk3568_a_defconfig` | 0 | 开 HVB Kconfig |
| `kernel/config/.../khdvk_rk3568_a_defconfig` | 1 | 开 dm-verity |
| `vendor/.../fstab.rk3568` | 1 | 加 hvb 标志 |
| 构建脚本 / CI | 0+ | 集成 hvb_sign.py |
| `extension/khsl/ohvb/tools/` | 0+ | 新建产线脚本（建议） |
