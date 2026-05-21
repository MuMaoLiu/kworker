/** 成功返回会话 id（>=1），失败返回 -1。回调参数：(sessionId, outputChunk)。 */
export const startPty: (
  callback: (sessionId: number, data: string) => void,
  profile?: string,
) => number;
export const writePty: (data: string, sessionId: number) => void;
export const resizePty: (cols: number, rows: number, sessionId: number) => void;
/** Omit sessionId / undefined / negative: stop all sessions. */
export const stopPty: (sessionId?: number) => void;
export const getLastPtyError: () => string;
