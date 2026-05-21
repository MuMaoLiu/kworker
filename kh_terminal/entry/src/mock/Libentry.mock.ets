const NativeMock: Record<string, Object> = {
  'add': (a: number, b: number) => {
    return a + b;
  },
  'startPty': (_cb: (sessionId: number, data: string) => void, _profile?: string) => {
    return 1;
  },
  'writePty': (_data: string, _sessionId: number) => {
  },
  'resizePty': (_cols: number, _rows: number, _sessionId: number) => {
  },
  'stopPty': (_sessionId?: number) => {
  },
  'getLastPtyError': () => 'mock-native',
};

export default NativeMock;
