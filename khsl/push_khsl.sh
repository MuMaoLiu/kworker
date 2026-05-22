#!/bin/bash
echo "Pushing updated khsl CLI..."
hdc shell "mount -o rw,remount /"
hdc file send \\wsl.localhost\master\home\liuboyi\master\openharmony\out\arm\targets\product_khdvk_rk3568_a\product_khdvk_rk3568_a\khsl /system/bin/
hdc shell "chmod +x /system/bin/khsl"
echo "Done."
