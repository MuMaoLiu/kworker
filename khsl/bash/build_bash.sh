#!/bin/bash
set -e

BASH_SRC_DIR=$(realpath ${1})
mkdir -p ${2}
OUT_DIR=$(realpath ${2})
CLANG_PATH=$(realpath ${3})
TARGET_CPU=${4}
BUILD_ROOT_DIR=$(realpath ${5})

FLAGS_TARGET="--target=arm-linux-ohos"
FLAGS_MARCH="-march=armv7-a"
CONFIGURE_TARGET="--host=arm-linux"

if [ "$TARGET_CPU" = "arm64" ]; then
    FLAGS_TARGET="--target=aarch64-linux-ohos"
    FLAGS_MARCH="-march=armv8-a"
    CONFIGURE_TARGET="--host=aarch64-linux"
fi

export CC="$CLANG_PATH/clang"
export CXX="$CLANG_PATH/clang++"
export LD="$CLANG_PATH/ld.lld"
export STRIP="$CLANG_PATH/llvm-strip"
export AR="$CLANG_PATH/llvm-ar"
export RANLIB="$CLANG_PATH/llvm-ranlib"

export CFLAGS="-Os -fPIC ${FLAGS_TARGET} ${FLAGS_MARCH} -mfloat-abi=softfp -D__MUSL__=1 --sysroot=$BUILD_ROOT_DIR -ffunction-sections -fdata-sections"
export LDFLAGS="${FLAGS_TARGET} ${FLAGS_MARCH} -mfloat-abi=softfp --sysroot=$BUILD_ROOT_DIR --rtlib=compiler-rt -fuse-ld=lld -Wl,--gc-sections"

# bash configure needs to know it's cross-compiling
export bash_cv_dev_fd=whacky
export bash_cv_getcwd_malloc=yes
export bash_cv_job_control_missing=present
export bash_cv_sys_named_pipes=present
export bash_cv_func_sigsetjmp=present
export bash_cv_printf_a_format=yes

rm -rf $OUT_DIR
mkdir -p $OUT_DIR
cd $OUT_DIR

# Copy source to out dir to avoid polluting source tree
cp -prf $BASH_SRC_DIR/* .

./configure --prefix=/system ${CONFIGURE_TARGET} --without-bash-malloc --disable-nls

make -j8

$STRIP --strip-unneeded bash
