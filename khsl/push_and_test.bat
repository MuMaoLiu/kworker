@echo off
echo Pushing updated kh_term_daemon and test scripts...

echo Stopping kh_term_daemon to release file lock...
hdc shell "stop kh_term_daemon"
hdc shell "killall kh_term_daemon 2>/dev/null"

hdc shell "mount -o rw,remount /"
hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\out\arm\targets\product_khdvk_rk3568_a\product_khdvk_rk3568_a\kh_term_daemon /system/bin/
hdc shell "chmod +x /system/bin/kh_term_daemon"

hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\extension\khsl\distribution\khsl_init_ubuntu.sh /data/
hdc shell "chmod +x /data/khsl_init_ubuntu.sh"

echo Restarting kh_term_daemon...
hdc shell "start kh_term_daemon"
echo Done.
pause
