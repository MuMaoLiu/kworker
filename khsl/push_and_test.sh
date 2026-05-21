#!/bin/bash
set -e

echo "Pushing updated kh_term_daemon..."
# Use Windows hdc.exe if available, otherwise just echo
if command -v hdc.exe &> /dev/null; then
    HDC="hdc.exe"
elif command -v hdc &> /dev/null; then
    HDC="hdc"
else
    echo "hdc not found. Please run these commands manually on your Windows host:"
    echo "hdc shell \"mount -o rw,remount /\""
    echo "hdc file send \\\\wsl.localhost\\master\\home\\liuboyi\\master\\openharmony\\out\\arm\\targets\\product_khdvk_rk3568_a\\product_khdvk_rk3568_a\\kh_term_daemon /system/bin/"
    echo "hdc shell \"chmod +x /system/bin/kh_term_daemon\""
    echo "hdc file send \\\\wsl.localhost\\master\\home\\liuboyi\\master\\openharmony\\extension\\khsl\\distribution\\khsl_init_ubuntu.sh /data/"
    echo "hdc shell \"chmod +x /data/khsl_init_ubuntu.sh\""
    echo "hdc shell \"killall kh_term_daemon || true\""
    echo "hdc shell \"nohup /system/bin/kh_term_daemon > /dev/null 2>&1 &\""
    exit 0
fi
