@echo off
echo Stopping kh_term_daemon to release file lock...
hdc shell "stop kh_term_daemon"
hdc shell "killall kh_term_daemon 2>/dev/null"

echo Pushing updated khsl CLI and kh_term_daemon...
hdc shell "mount -o rw,remount /"
hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\out\arm\targets\product_khdvk_rk3568_a\product_khdvk_rk3568_a\khsl /system/bin/
hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\out\arm\targets\product_khdvk_rk3568_a\product_khdvk_rk3568_a\kh_term_daemon /system/bin/
hdc shell "chmod +x /system/bin/khsl"
hdc shell "chmod +x /system/bin/kh_term_daemon"

echo Restarting kh_term_daemon...
hdc shell "start kh_term_daemon"
echo Done.
pause
