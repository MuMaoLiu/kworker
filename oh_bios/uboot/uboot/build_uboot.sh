#!/bin/bash

# Copyright (C) 2022 Kaihong Open Source Organization .
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


set -e
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
export IMAGES_OUT_PATH=${2}
export ROOT_DIR=${4}
export DEVICE_COMPANY=${5}
export DEVICE_NAME=${6}
export PRODUCT_COMPANY=${7}
export PRODUCT_NAME=${8}

UBOOT_OBJ_TMP_PATH=${ROOT_DIR}/out/uboot/${DEVICE_NAME}/OBJ
export KBUILD_OUTPUT=${UBOOT_OBJ_TMP_PATH}
KERNEL_BUILD_ROOT_DIR=${ROOT_DIR}/out/uboot/${DEVICE_NAME}/src_tmp
UBOOT_SRC_TMP_PATH=${KERNEL_BUILD_ROOT_DIR}
UBOOT_SOURCE=${ROOT_DIR}/device/soc/rockchip/tools/uboot/rk356x
RKBIN_SRC_TMP_PATH=${KERNEL_BUILD_ROOT_DIR}/../rkbin
RKBIN_SOURCE=${ROOT_DIR}/device/soc/rockchip/tools/rkbin

function copy_uboot_source(){
    rm -rf  ${ROOT_DIR}/out/uboot/${DEVICE_NAME}
    mkdir -p ${UBOOT_SRC_TMP_PATH}

    mkdir -p ${RKBIN_SRC_TMP_PATH}

    cp -arf ${UBOOT_SOURCE}/* ${UBOOT_SRC_TMP_PATH}/
    cp -arf ${SCRIPT_DIR}/configs/* ${UBOOT_SRC_TMP_PATH}/configs/
    cp -arf ${SCRIPT_DIR}/dts/* ${UBOOT_SRC_TMP_PATH}/arch/arm/dts/
    cp -arf ${RKBIN_SOURCE}/* ${RKBIN_SRC_TMP_PATH}/
    cp -arf ${SCRIPT_DIR}/rkbin/* ${RKBIN_SRC_TMP_PATH}/

    KH_BIOS_ROOT="${ROOT_DIR}/extension/uboot_bios"
    bash "${KH_BIOS_ROOT}/scripts/integrate_kh_bios.sh" \
        "${UBOOT_SRC_TMP_PATH}" "${SCRIPT_DIR}"
}

    copy_uboot_source

pushd $UBOOT_SRC_TMP_PATH

bash ./make.sh $DEVICE_NAME
if [ ! -d ${IMAGES_OUT_PATH} ];then
mkdir -p ${IMAGES_OUT_PATH}
fi
cp -arf ./uboot.img ${IMAGES_OUT_PATH}/uboot.img
    cp "${SCRIPT_DIR}/../loader/MiniLoaderAll.bin" ${IMAGES_OUT_PATH}/MiniLoaderAll.bin
popd
