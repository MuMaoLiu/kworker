# kworker

OpenHarmony 相关技术文档与示例工程集合（KHSL、U-Boot BIOS、安全启动、终端应用等）。

## 目录说明

| 目录 | 说明 |
|------|------|
| [oh_bios/](oh_bios/) | U-Boot 阶段 `kh_bios`（HDMI Setup、F10/串口进菜单） |
| [oh-secure-boot/](oh-secure-boot/) | OpenHarmony 安全启动（OHVB / HVB）技术文档 |
| [khsl/](khsl/) | KHSL（OpenHarmony Subsystem for Linux） |
| [kh_terminal/](kh_terminal/) | OpenHarmony 终端应用（Web + xterm + PTY） |

## 与 OpenHarmony 主仓集成

KHSL 等组件在 vendor `bundle.json` 中引用示例：

```text
/home/liuboyi/master/openharmony/vendor/{company}/{product_name}/bundle.json

  "//extension/khsl/kh_term_daemon:kh_term_daemon_group",
  "//extension/khsl/bash:bash_group",
  "//extension/khsl/khsl:khsl_group"
```

`oh_bios` 合入路径见 [oh_bios/README.md](oh_bios/README.md)。
