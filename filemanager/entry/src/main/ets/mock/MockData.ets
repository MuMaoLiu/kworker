import { FileItem, NavNode } from '../models/FileModels';

// 模拟侧边栏数据
// 模拟侧边栏数据
export const MOCK_NAV_DATA: NavNode[] = [
  {
    id: 'quick_access',
    name: '快速访问',
    icon: $r('app.media.ic_home'),
    isExpanded: true,
    children: [
      { id: 'desktop', name: '桌面', icon: $r('app.media.ic_folder') },
      { id: 'downloads', name: '下载', icon: $r('app.media.ic_folder') },
      { id: 'documents', name: '文档', icon: $r('app.media.ic_folder') },
      { id: 'pictures', name: '图片', icon: $r('app.media.ic_folder') }
    ]
  },
  {
    id: 'this_pc',
    name: '此电脑',
    icon: $r('app.media.ic_pc'),
    isExpanded: true,
    children: [
      { id: 'c_drive', name: '系统盘 (C:)', icon: $r('app.media.ic_drive') },
      { id: 'd_drive', name: '开发工具 (E:)', icon: $r('app.media.ic_drive') },
      { id: 'khsl_drive', name: 'Linux (khsl)', icon: $r('app.media.ic_drive') }
    ]
  },
  {
    id: 'network',
    name: '网络',
    icon: $r('app.media.ic_pc')
  }
];

// 模拟主内容区数据（此电脑视图）
export const MOCK_FOLDERS: FileItem[] = [
  { id: 'f1', name: '3D Objects', type: 'folder', icon: $r('app.media.ic_folder') },
  { id: 'f2', name: '视频', type: 'folder', icon: $r('app.media.ic_folder') },
  { id: 'f3', name: '图片', type: 'folder', icon: $r('app.media.ic_folder') },
  { id: 'f4', name: '文档', type: 'folder', icon: $r('app.media.ic_folder') },
  { id: 'f5', name: '下载', type: 'folder', icon: $r('app.media.ic_folder') },
  { id: 'f6', name: '音乐', type: 'folder', icon: $r('app.media.ic_folder') },
  { id: 'f7', name: '桌面', type: 'folder', icon: $r('app.media.ic_folder') }
];

export const MOCK_DRIVES: FileItem[] = [
  { id: 'd1', name: '系统盘 (C:)', type: 'drive', icon: $r('app.media.ic_drive'), details: '81.6 GB 可用，共 953 GB' },
  { id: 'd2', name: 'WSL (D:)', type: 'drive', icon: $r('app.media.ic_drive'), details: '257 GB 可用，共 999 GB' },
  { id: 'd3', name: '开发工具 (E:)', type: 'drive', icon: $r('app.media.ic_drive'), details: '467 GB 可用，共 499 GB' },
  { id: 'd4', name: '开发资料 (F:)', type: 'drive', icon: $r('app.media.ic_drive'), details: '131 GB 可用，共 363 GB' },
  { id: 'd5', name: '项目资料 (G:)', type: 'drive', icon: $r('app.media.ic_drive'), details: '447 GB 可用，共 931 GB' },
  { id: 'd6', name: 'Linux (khsl)', type: 'drive', icon: $r('app.media.ic_drive'), details: '虚拟磁盘', path: '/data/khsl/rootfs' }
];