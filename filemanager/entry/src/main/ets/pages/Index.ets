import { FileItem, NavNode } from '../models/FileModels';
import { MOCK_DRIVES, MOCK_FOLDERS, MOCK_NAV_DATA } from '../mock/MockData';
import statvfs from '@ohos.file.statvfs';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import window from '@ohos.window';
import common from '@ohos.app.ability.common';

import pointer from '@ohos.multimodalInput.pointer';

const DOMAIN = 0x0000;
const TAG = 'FileManager';

interface PathRecord {
  name: string;
  realPath?: string;
}

@Entry
@Component
struct Index {
  @State currentPath: string = '此电脑';
  @State currentRealPath: string | undefined = undefined;
  @State selectedNavId: string = 'this_pc';
  @State navData: NavNode[] = MOCK_NAV_DATA;
  
  // 真实驱动器数据
  @State realDrives: FileItem[] = [];
  // 网络位置/虚拟磁盘
  @State networkDrives: FileItem[] = [];
  // 当前路径下的真实文件/文件夹列表
  @State currentFiles: FileItem[] = [];

  // 路径历史栈
  @State pathHistory: PathRecord[] = [{ name: '此电脑' }];
  @State historyIndex: number = 0;
  
  // 地址栏输入状态
  @State addressBarText: string = '此电脑';
  
  // 拖拽缩放状态
  @State sidebarWidth: number = 330;
  @State initialSidebarWidth: number = 330;
  @State foldersHeight: number = 180;
  @State initialFoldersHeight: number = 180;
  
  // 错误提示
  @State errorMessage: string = '';

  // 窗口状态
  @State isMaximized: boolean = false;
  @State topPadding: number = 0;
  @State windowId: number = -1;
  private windowClass: window.Window | null = null;
  
  // 拖拽窗口状态
  private winX: number = 0;
  private winY: number = 0;

  aboutToAppear() {
    this.initRealDrives();
    this.initWindow();
  }

  // 初始化窗口实例
  initWindow() {
    let context = getContext(this) as common.UIAbilityContext;
    window.getLastWindow(context).then((win) => {
      this.windowClass = win;
      this.windowId = win.getWindowProperties().id;
      
      try {
        let avoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
        this.topPadding = px2vp(avoidArea.topRect.height);
        
        win.on('avoidAreaChange', (data) => {
          if (data.type === window.AvoidAreaType.TYPE_SYSTEM) {
            this.topPadding = px2vp(data.area.topRect.height);
          }
        });
      } catch (e) {
        hilog.warn(DOMAIN, TAG, `Avoid area error: ${e.message}`);
      }
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, `Failed to get window. message: ${err.message}`);
    });
  }

  // 最小化窗口
  minimizeWindow() {
    if (this.windowClass) {
      this.windowClass.minimize().catch((err: Error) => {
        hilog.error(DOMAIN, TAG, `Failed to minimize window. message: ${err.message}`);
      });
    }
  }

  // 切换最大化/恢复窗口
  toggleMaximizeWindow() {
    if (this.windowClass) {
      if (this.isMaximized) {
        // 恢复窗口
        this.windowClass.setWindowLayoutFullScreen(false).then(() => {
          this.windowClass?.setWindowSystemBarEnable(['status', 'navigation']).catch(() => {});
          try { this.windowClass?.setWindowDecorVisible(true); } catch (e) {}
          this.isMaximized = false;
        }).catch((err: Error) => {
          hilog.error(DOMAIN, TAG, `Failed to restore window. message: ${err.message}`);
        });
      } else {
        // 最大化窗口 (全屏)
        this.windowClass.setWindowLayoutFullScreen(true).then(() => {
          this.windowClass?.setWindowSystemBarEnable([]).catch(() => {});
          try { this.windowClass?.setWindowDecorVisible(false); } catch (e) {}
          this.isMaximized = true;
        }).catch((err: Error) => {
          hilog.error(DOMAIN, TAG, `Failed to maximize window. message: ${err.message}`);
        });
      }
    }
  }

  // 关闭窗口 (退出应用)
  closeWindow() {
    let context = getContext(this) as common.UIAbilityContext;
    context.terminateSelf().catch((err: Error) => {
      hilog.error(DOMAIN, TAG, `Failed to terminate. message: ${err.message}`);
    });
  }

  // 格式化字节大小
  formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  // 获取真实磁盘信息
  async initRealDrives() {
    let drives: FileItem[] = [];
    let netDrives: FileItem[] = [];

    try {
      // 1. 系统根目录
      let rootPath = '/'; 
      let rootStat = await statvfs.getTotalSize(rootPath);
      let rootFree = await statvfs.getFreeSize(rootPath);
      drives.push({
        id: 'root_storage',
        name: '系统根目录 (/)',
        type: 'drive',
        icon: $r('app.media.ic_drive'),
        path: rootPath,
        totalSize: Number(rootStat),
        freeSize: Number(rootFree),
        details: `${this.formatBytes(Number(rootFree))} 可用，共 ${this.formatBytes(Number(rootStat))}`
      });

      // 2. 用户数据目录
      let dataPath = '/data'; 
      let dataStat = await statvfs.getTotalSize(dataPath);
      let dataFree = await statvfs.getFreeSize(dataPath);
      drives.push({
        id: 'data_storage',
        name: '用户数据 (/data)',
        type: 'drive',
        icon: $r('app.media.ic_drive'),
        path: dataPath,
        totalSize: Number(dataStat),
        freeSize: Number(dataFree),
        details: `${this.formatBytes(Number(dataFree))} 可用，共 ${this.formatBytes(Number(dataStat))}`
      });
    } catch (err) {
      let e = err as Error;
      hilog.error(DOMAIN, TAG, `Failed to get statvfs. message: ${e.message}`);
    }

    // 尝试挂载 khsl (类似 WSL)
    try {
      let khslPath = '/data/khsl/rootfs';
      let isKhslDir = fs.statSync(khslPath).isDirectory();
      if (isKhslDir) {
        // 尝试获取 khsl 的容量信息
        let kStat = await statvfs.getTotalSize(khslPath);
        let kFree = await statvfs.getFreeSize(khslPath);
        
        netDrives.push({
          id: 'khsl_storage',
          name: 'Linux (khsl)',
          type: 'drive',
          icon: $r('app.media.ic_drive'),
          path: khslPath,
          totalSize: Number(kStat),
          freeSize: Number(kFree),
          details: `${this.formatBytes(Number(kFree))} 可用，共 ${this.formatBytes(Number(kStat))}`
        });
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, `khsl not found or no permission: ${e.message}`);
    }

    this.realDrives = drives.length > 0 ? drives : MOCK_DRIVES;
    this.networkDrives = netDrives;
  }

  // 读取指定路径下的文件列表
  async loadFilesFromPath(path: string) {
    this.errorMessage = '';
    try {
      let isDir = fs.statSync(path).isDirectory();
      if (!isDir) return;

      let filenames = await fs.listFile(path);
      let files: FileItem[] = [];
      
      for (let i = 0; i < filenames.length; i++) {
        let filename = filenames[i];
        let filePath = path === '/' ? '/' + filename : path + '/' + filename;
        try {
          let stat = fs.statSync(filePath);
          files.push({
            id: filePath,
            name: filename,
            type: stat.isDirectory() ? 'folder' : 'file',
            icon: stat.isDirectory() ? $r('app.media.ic_folder') : $r('app.media.ic_file'),
            path: filePath,
            details: stat.isDirectory() ? '' : this.formatBytes(stat.size)
          });
        } catch (e) {
          hilog.warn(DOMAIN, TAG, `Failed to stat file: ${filePath}`);
        }
      }
      
      // 排序：文件夹在前，文件在后
      files.sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name);
        }
        return a.type === 'folder' ? -1 : 1;
      });
      
      this.currentFiles = files;
    } catch (err) {
      let e = err as Error;
      hilog.error(DOMAIN, TAG, `Failed to list files. message: ${e.message}`);
      this.errorMessage = `无法访问: ${e.message}`;
      this.currentFiles = [];
    }
  }

  // 跳转到新路径
  navigateTo(pathName: string, navId?: string, realPath?: string) {
    let displayPath = realPath ? realPath : pathName;
    if (this.currentPath === displayPath && this.currentRealPath === realPath) return;
    
    // 如果在历史记录中间进行了新的跳转，则截断后面的历史
    if (this.historyIndex < this.pathHistory.length - 1) {
      this.pathHistory = this.pathHistory.slice(0, this.historyIndex + 1);
    }
    
    this.pathHistory.push({ name: displayPath, realPath: realPath });
    this.historyIndex = this.pathHistory.length - 1;
    this.currentPath = displayPath;
    this.addressBarText = displayPath;
    this.currentRealPath = realPath;
    
    if (navId) {
      this.selectedNavId = navId;
    }

    // 如果传入了真实的系统路径，则读取该路径下的文件
    if (realPath) {
      this.loadFilesFromPath(realPath);
    } else {
      // 如果没有真实路径（比如点击了模拟的"此电脑"），清空当前文件列表
      this.currentFiles = [];
    }
  }

  // 后退
  goBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      let record = this.pathHistory[this.historyIndex];
      this.currentPath = record.name;
      this.addressBarText = record.name;
      this.currentRealPath = record.realPath;
      this.syncNavIdByPath(this.currentPath);
      
      if (this.currentRealPath) {
         this.loadFilesFromPath(this.currentRealPath);
      } else {
         this.currentFiles = [];
      }
    }
  }

  // 前进
  goForward() {
    if (this.historyIndex < this.pathHistory.length - 1) {
      this.historyIndex++;
      let record = this.pathHistory[this.historyIndex];
      this.currentPath = record.name;
      this.addressBarText = record.name;
      this.currentRealPath = record.realPath;
      this.syncNavIdByPath(this.currentPath);
      
      if (this.currentRealPath) {
         this.loadFilesFromPath(this.currentRealPath);
      } else {
         this.currentFiles = [];
      }
    }
  }

  // 向上（简单模拟：如果是驱动器/文件夹，统一回到"此电脑"）
  goUp() {
    if (this.currentPath !== '此电脑' && this.currentPath !== '快速访问' && this.currentPath !== '网络') {
      this.navigateTo('此电脑', 'this_pc');
    }
  }

  // 根据路径同步左侧选中状态（简易版）
  syncNavIdByPath(path: string) {
    if (path === '此电脑') this.selectedNavId = 'this_pc';
    else if (path === '快速访问') this.selectedNavId = 'quick_access';
    else if (path === '网络') this.selectedNavId = 'network';
    else {
      // 尝试在子节点中查找
      for (let node of this.navData) {
        if (node.children) {
          let found = node.children.find(c => c.name === path);
          if (found) {
            this.selectedNavId = found.id;
            return;
          }
        }
      }
    }
  }

  // 递归渲染导航树节点
  @Builder
  NavNodeItem(node: NavNode, level: number = 0) {
    Column() {
      Row() {
        // 展开/折叠图标占位
        if (node.children && node.children.length > 0) {
          Text(node.isExpanded ? '▼' : '▶')
            .fontSize(15)
            .fontColor('#666')
            .width(24)
            .onClick(() => {
              node.isExpanded = !node.isExpanded;
              // 触发UI刷新
              this.navData = [...this.navData];
            })
        } else {
          Blank().width(24)
        }

        Image(node.icon)
          .width(30)
          .height(30)
          .margin({ right: 9 })

        Text(node.name)
          .fontSize(19.5)
          .fontColor(this.selectedNavId === node.id ? '#0066CC' : '#333')
          .fontWeight(this.selectedNavId === node.id ? FontWeight.Bold : FontWeight.Normal)
      }
      .width('100%')
      .height(42)
      .padding({ left: level * 18 })
      .backgroundColor(this.selectedNavId === node.id ? '#E5F3FF' : 'transparent')
      .onClick(() => {
        this.navigateTo(node.name, node.id);
      })

      if (node.isExpanded && node.children) {
        ForEach(node.children, (child: NavNode) => {
          this.NavNodeItem(child, level + 1)
        }, (child: NavNode) => child.id)
      }
    }
  }

  // 渲染文件/文件夹项 (网格视图)
  @Builder
  FileGridItem(item: FileItem) {
    Row() {
      Image(item.icon)
        .width(84)
        .height(84)
        .margin({ right: 15 })
      
      Column() {
        Text(item.name).fontSize(19.5).fontColor('#333').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        if (item.details) {
          Text(item.details).fontSize(16.5).fontColor('#666').margin({ top: 6 })
          // 简单的进度条模拟
          if (item.type === 'drive' && item.totalSize && item.freeSize) {
             Progress({ 
               value: item.totalSize - item.freeSize, 
               total: item.totalSize, 
               type: ProgressType.Linear 
             })
               .width('100%')
               .height(15)
               .color('#2196F3')
               .margin({ top: 6 })
          } else if (item.type === 'drive') {
             // 兼容旧的模拟数据
             Progress({ value: 30, total: 100, type: ProgressType.Linear })
               .width('100%')
               .height(15)
               .color('#2196F3')
               .margin({ top: 6 })
          }
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .padding(12)
    .borderRadius(6)
    .stateStyles({
      normal: { .backgroundColor(Color.Transparent) },
      pressed: { .backgroundColor('#E5F3FF') }
    })
    .onClick(() => {
      // 点击右侧文件/驱动器时，跳转到该路径
      if (item.type === 'drive' || item.type === 'folder') {
        this.navigateTo(item.name, undefined, item.path);
      }
    })
  }

  @Builder
  emptyKeyboardBuilder() {
    Column()
  }

  build() {
    Column() {
      // 1. 顶部菜单栏 (Ribbon/Menu)
      Row() {
        Row() {
          Text("文件").fontSize(18).margin({ right: 20 }).padding(6)
          Text("计算机").fontSize(18).margin({ right: 20 }).padding(6).backgroundColor('#E5F3FF')
          Text("查看").fontSize(18).padding(6)
        }
        .layoutWeight(1)

        // 右上角窗口控制按钮
        Row() {
          Text("—").fontSize(16).padding({ left: 15, right: 15, top: 8, bottom: 8 })
            .onClick(() => this.minimizeWindow())
          Text(this.isMaximized ? "❐" : "□").fontSize(16).padding({ left: 15, right: 15, top: 8, bottom: 8 })
            .onClick(() => this.toggleMaximizeWindow())
          Text("✕").fontSize(16).padding({ left: 15, right: 15, top: 8, bottom: 8 })
            .onClick(() => this.closeWindow())
            .stateStyles({
               normal: { .backgroundColor(Color.Transparent) },
               pressed: { .backgroundColor('#E81123') } // Windows关闭按钮经典的红色
            })
        }
      }
      .width('100%')
      .height(40)
      .backgroundColor('#FFFFFF')
      .padding({ left: 10 })
      .gesture(
        GestureGroup(GestureMode.Exclusive,
          TapGesture({ count: 2 })
            .onAction(() => {
              this.toggleMaximizeWindow();
            }),
          PanGesture()
            .onActionStart((event: GestureEvent) => {
              if (this.windowClass && !this.isMaximized) {
                let rect = this.windowClass.getWindowProperties().windowRect;
                this.winX = rect.left;
                this.winY = rect.top;
              }
            })
            .onActionUpdate((event: GestureEvent) => {
              if (this.windowClass && !this.isMaximized) {
                this.windowClass.moveWindowTo(this.winX + event.offsetX, this.winY + event.offsetY);
              }
            })
        )
      )

      // 2. 导航栏 (地址栏 + 搜索框)
      Row() {
        // 后退、前进、向上按钮
        Row() {
          Text("←")
            .fontSize(24)
            .fontColor(this.historyIndex > 0 ? '#333' : '#999')
            .margin({ right: 15 })
            .onClick(() => this.goBack())
          
          Text("→")
            .fontSize(24)
            .fontColor(this.historyIndex < this.pathHistory.length - 1 ? '#333' : '#999')
            .margin({ right: 15 })
            .onClick(() => this.goForward())
          
          Text("↑")
            .fontSize(24)
            .fontColor((this.currentPath !== '此电脑' && this.currentPath !== '快速访问' && this.currentPath !== '网络') ? '#333' : '#999')
            .onClick(() => this.goUp())
        }.margin({ right: 22.5 })

        // 地址栏
        Row() {
          Image($r('app.media.ic_folder')).width(30).height(30).margin({ right: 9 })
          Text('▶').fontSize(15).fontColor('#999').margin({ right: 9 })
          TextInput({ text: this.addressBarText })
            .fontSize(19.5)
            .backgroundColor(Color.Transparent)
            .layoutWeight(1)
            .padding(0)
            .customKeyboard(this.emptyKeyboardBuilder())
            .onChange((value: string) => {
              this.addressBarText = value;
            })
            .onSubmit(() => {
              let input = this.addressBarText.trim();
              if (input === '此电脑') {
                this.navigateTo('此电脑', 'this_pc');
              } else if (input === '快速访问') {
                this.navigateTo('快速访问', 'quick_access');
              } else if (input === '网络') {
                this.navigateTo('网络', 'network');
              } else {
                // 尝试作为真实路径访问
                this.navigateTo(input, undefined, input);
              }
            })
        }
        .height(42)
        .layoutWeight(1)
        .padding({ left: 12 })
        .borderRadius(3)
        .backgroundColor(Color.White)
        .border({ width: 1.5, color: '#D9D9D9' })
        .margin({ right: 15 })

        // 搜索框
        TextInput({ placeholder: `搜索"${this.currentPath}"` })
          .height(42)
          .width(330)
          .fontSize(19.5)
          .borderRadius(3)
          .backgroundColor(Color.White)
          .border({ width: 1.5, color: '#D9D9D9' })
          .customKeyboard(this.emptyKeyboardBuilder())
      }
      .width('100%')
      .height(67.5)
      .backgroundColor('#F5F6F7')
      .padding({ left: 15, right: 15 })
      .border({ width: { bottom: 1.5 }, color: '#D9D9D9' })

      // 3. 主体内容区 (左侧导航 + 右侧文件区)
      Row() {
        // 左侧导航树 (Sidebar)
        Scroll() {
          Column() {
            ForEach(this.navData, (node: NavNode) => {
              this.NavNodeItem(node, 0)
            }, (node: NavNode) => node.id)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        }
        .width(this.sidebarWidth)
        .height('100%')
        .backgroundColor('#FFFFFF')
        .padding({ top: 15, left: 7.5, right: 7.5 })
        .align(Alignment.TopStart)

        // 左侧与右侧的拖拽分割线
        Row()
          .width(6)
          .height('100%')
          .backgroundColor('#E0E0E0')
          .onHover((isHover: boolean) => {
            if (this.windowId !== -1) {
              try {
                // 10 对应 WEST_EAST 双向箭头
                pointer.setPointerStyle(this.windowId, isHover ? 10 : 0);
              } catch (e) {}
            }
          })
          .gesture(
            PanGesture({ direction: PanDirection.Horizontal })
              .onActionStart(() => {
                this.initialSidebarWidth = this.sidebarWidth;
              })
              .onActionUpdate((event: GestureEvent) => {
                this.sidebarWidth = this.initialSidebarWidth + event.offsetX;
                if (this.sidebarWidth < 200) this.sidebarWidth = 200;
                if (this.sidebarWidth > 800) this.sidebarWidth = 800;
              })
          )

        // 右侧主文件区
        Scroll() {
          Column() {
            if (this.currentPath === '此电脑') {
              // --- 此电脑视图 ---
              // 文件夹区域
              Row() {
                Text("▼").fontSize(15).fontColor('#666').margin({ right: 9 })
                Text(`文件夹 (${MOCK_FOLDERS.length})`).fontSize(19.5).fontWeight(FontWeight.Medium).fontColor('#333')
              }
              .width('100%')
              .padding({ bottom: 15 })
              .border({ width: { bottom: 1.5 }, color: '#EBEBEB' })
              .margin({ bottom: 22.5 })

              Grid() {
                ForEach(MOCK_FOLDERS, (item: FileItem) => {
                  GridItem() {
                    this.FileGridItem(item)
                  }
                }, (item: FileItem) => item.id)
              }
              .columnsTemplate('1fr 1fr 1fr 1fr')
              .columnsGap(15)
              .rowsGap(15)
              .width('100%')
              .height(this.foldersHeight)

              // 文件夹与驱动器之间的拖拽分割线
              Row() {
                Divider().color('#CCC')
              }
              .width('100%')
              .height(15)
              .backgroundColor(Color.Transparent)
              .onHover((isHover: boolean) => {
                if (this.windowId !== -1) {
                  try {
                    // 11 对应 NORTH_SOUTH 双向箭头
                    pointer.setPointerStyle(this.windowId, isHover ? 11 : 0);
                  } catch (e) {}
                }
              })
              .gesture(
                PanGesture({ direction: PanDirection.Vertical })
                  .onActionStart(() => {
                    this.initialFoldersHeight = this.foldersHeight;
                  })
                  .onActionUpdate((event: GestureEvent) => {
                    this.foldersHeight = this.initialFoldersHeight + event.offsetY;
                    if (this.foldersHeight < 100) this.foldersHeight = 100;
                    if (this.foldersHeight > 600) this.foldersHeight = 600;
                  })
              )

              // 驱动器区域
              Row() {
                Text("▼").fontSize(15).fontColor('#666').margin({ right: 9 })
                Text(`设备和驱动器 (${this.realDrives.length})`).fontSize(19.5).fontWeight(FontWeight.Medium).fontColor('#333')
              }
              .width('100%')
              .padding({ bottom: 15, top: 30 })
              .border({ width: { bottom: 1.5 }, color: '#EBEBEB' })
              .margin({ bottom: 22.5 })

              Grid() {
                ForEach(this.realDrives, (item: FileItem) => {
                  GridItem() {
                    this.FileGridItem(item)
                  }
                }, (item: FileItem) => item.id)
              }
              .columnsTemplate('1fr 1fr 1fr') // 驱动器稍微宽一点
              .columnsGap(22.5)
              .rowsGap(22.5)
              .width('100%')
              .height(300)
              // 网络位置区域
              if (this.networkDrives.length > 0) {
                Row() {
                  Text("▼").fontSize(15).fontColor('#666').margin({ right: 9 })
                  Text(`网络位置 (${this.networkDrives.length})`).fontSize(19.5).fontWeight(FontWeight.Medium).fontColor('#333')
                }
                .width('100%')
                .padding({ bottom: 15, top: 30 })
                .border({ width: { bottom: 1.5 }, color: '#EBEBEB' })
                .margin({ bottom: 22.5 })

                Grid() {
                  ForEach(this.networkDrives, (item: FileItem) => {
                    GridItem() {
                      this.FileGridItem(item)
                    }
                  }, (item: FileItem) => item.id)
                }
                .columnsTemplate('1fr 1fr 1fr')
                .columnsGap(22.5)
                .rowsGap(22.5)
                .width('100%')
                .height(150)
              }
            } else if (this.currentFiles.length > 0) {
              // --- 真实文件夹视图 ---
              Grid() {
                ForEach(this.currentFiles, (item: FileItem) => {
                  GridItem() {
                    this.FileGridItem(item)
                  }
                }, (item: FileItem) => item.id)
              }
              .columnsTemplate('1fr 1fr 1fr 1fr')
              .columnsGap(15)
              .rowsGap(15)
              .width('100%')
              .height('100%')
            } else {
              // --- 其他文件夹视图 (空状态模拟) ---
              Column() {
                Image($r('app.media.ic_folder')).width(144).height(144).opacity(0.2).margin({ bottom: 30 })
                Text(`此文件夹为空`).fontSize(21).fontColor('#999')
                Text(`当前路径: ${this.currentPath}`).fontSize(18).fontColor('#CCC').margin({ top: 15 })
              }
              .width('100%')
              .height(450)
              .justifyContent(FlexAlign.Center)
            }
          }
          .width('100%')
          .padding(30)
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .height('100%')
        .backgroundColor('#FFFFFF')
        .align(Alignment.TopStart)
      }
      .layoutWeight(1)
      .width('100%')

      // 4. 底部状态栏
      Row() {
        Text(`${MOCK_FOLDERS.length + this.realDrives.length} 个项目`).fontSize(18).fontColor('#666')
        Divider().vertical(true).height(18).margin({ left: 15, right: 15 })
        Text("选中 1 个项目").fontSize(18).fontColor('#666')
      }
      .width('100%')
      .height(39)
      .backgroundColor('#F0F0F0')
      .padding({ left: 15 })
      .border({ width: { top: 1.5 }, color: '#D9D9D9' })
    }
    .width('100%')
    .height('100%')
    .padding({ top: this.topPadding })
  }
}