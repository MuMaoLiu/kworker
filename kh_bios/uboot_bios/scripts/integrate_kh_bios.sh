#!/bin/bash
# Integrate KaihongOS L2 kh_bios: extension core + board overlay
# Usage: integrate_kh_bios.sh <UBOOT_SRC> <BOARD_UBOOT_DIR>

set -e

UBOOT_SRC="$1"
BOARD_UBOOT="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KH_BIOS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CORE_SRC="${KH_BIOS_ROOT}/core"
INCLUDE_SRC="${KH_BIOS_ROOT}/include"
BOARD_BIOS="${BOARD_UBOOT}/bios"
DEST="${UBOOT_SRC}/cmd/kh_bios"

if [ -z "$UBOOT_SRC" ] || [ -z "$BOARD_UBOOT" ]; then
	echo "usage: integrate_kh_bios.sh <uboot_src> <board_uboot_dir>"
	exit 1
fi

if [ ! -d "$CORE_SRC" ]; then
	echo "[kh_bios] ERROR: missing core at ${CORE_SRC}"
	exit 1
fi

if [ ! -d "$BOARD_BIOS" ]; then
	echo "[kh_bios] ERROR: missing board bios at ${BOARD_BIOS}"
	exit 1
fi

mkdir -p "${UBOOT_SRC}/cmd"
rm -rf "${DEST}"
mkdir -p "${DEST}/include" "${DEST}/board"

cp -arf "${CORE_SRC}/"* "${DEST}/"
cp -arf "${INCLUDE_SRC}/"* "${DEST}/include/"
cp -arf "${BOARD_BIOS}/"* "${DEST}/board/"

# Board Makefile fragment
if [ ! -f "${DEST}/board/Makefile" ]; then
	cat > "${DEST}/board/Makefile" <<'EOF'
# Board-specific kh_bios objects (overlay from device/board/.../uboot/bios)
obj-y += kh_bios_board.o
EOF
fi

# cmd/Makefile
MK="${UBOOT_SRC}/cmd/Makefile"
if ! grep -q 'CONFIG_KH_BIOS' "$MK"; then
	if grep -q 'CONFIG_CMD_BOOT_KAIHONG' "$MK"; then
		sed -i '/CONFIG_CMD_BOOT_KAIHONG/a obj-$(CONFIG_KH_BIOS) += kh_bios/' "$MK"
	else
		echo 'obj-$(CONFIG_KH_BIOS) += kh_bios/' >> "$MK"
	fi
fi

# cmd/Kconfig
KC="${UBOOT_SRC}/cmd/Kconfig"
if ! grep -q 'cmd/kh_bios/Kconfig' "$KC"; then
	if grep -q 'config CMD_BOOT_KAIHONG' "$KC"; then
		sed -i '/config CMD_BOOT_KAIHONG/a source "cmd/kh_bios/Kconfig"' "$KC"
	else
		echo 'source "cmd/kh_bios/Kconfig"' >> "$KC"
	fi
fi

echo "[kh_bios] integrated core+board into ${DEST}"

# U-Boot DRM: FB dimensions + RGB565 console plane for kh_bios menu
for PATCH in "${KH_BIOS_ROOT}/patches/rockchip_video_fb_header.patch" \
	     "${KH_BIOS_ROOT}/patches/rockchip_video_fb.patch"; do
	if [ -f "$PATCH" ]; then
		( cd "${UBOOT_SRC}" && patch -p1 -N -s -f < "$PATCH" ) || true
	fi
done
if ! grep -q rockchip_show_fbbase_fmt "${UBOOT_SRC}/drivers/video/drm/rockchip_display.c" 2>/dev/null; then
	echo "[kh_bios] ERROR: rockchip_show_fbbase_fmt missing in rockchip_display.c"
	exit 1
fi
