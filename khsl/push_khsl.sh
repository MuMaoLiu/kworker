#!/bin/bash
echo "Pushing updated khsl CLI and kh_term_daemon..."
hdc shell "mount -o rw,remount /"

# 先杀掉进程，防止推送时报 "Text file busy" 错误
echo "Stopping kh_term_daemon..."
hdc shell "killall kh_term_daemon"

hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\out\arm\targets\product_khdvk_rk3568_a\product_khdvk_rk3568_a\khsl /system/bin/
hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\out\arm\targets\product_khdvk_rk3568_a\product_khdvk_rk3568_a\kh_term_daemon /system/bin/
hdc shell "chmod +x /system/bin/khsl"
hdc shell "chmod +x /system/bin/kh_term_daemon"

# 因为 cfg 改为了 once: 1，系统不会自动拉起，推送完后我们需要手动后台拉起它
echo "Starting kh_term_daemon..."
hdc shell "nohup /system/bin/kh_term_daemon > /dev/null 2>&1 &"
echo "Done."
