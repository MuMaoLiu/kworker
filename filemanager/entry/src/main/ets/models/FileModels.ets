// 定义文件/文件夹的数据模型
export interface FileItem {
  id: string;
  name: string;
  type: 'folder' | 'drive' | 'file';
  icon: ResourceStr;
  details?: string; // 例如：磁盘容量信息
  path?: string; // 真实路径
  totalSize?: number; // 总容量 (bytes)
  freeSize?: number; // 可用容量 (bytes)
}

// 定义侧边栏导航节点模型
export interface NavNode {
  id: string;
  name: string;
  icon: ResourceStr;
  isExpanded?: boolean;
  children?: NavNode[];
}
