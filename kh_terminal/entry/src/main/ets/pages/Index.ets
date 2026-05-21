// KaihongOS 终端：ArkUI Web + xterm，经 NAPI 连接 PTY（非通用开源 OH ROM 演示用途）。

import { hilog } from '@kit.PerformanceAnalysisKit';
import testNapi from 'libentry.so';
import web_webview from '@ohos.web.webview';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0x0000;
const TAG = 'TerminalApp';
const PREFS_NAME = 'kh_terminal_web_prefs';
const PREFS_FIELD = 'terminal_web_prefs_v1';
const SHELL_LIGHT = '#FAF7F0';
const SHELL_DARK = '#1A1A1A';

interface WtPrefsShape {
  scheme?: string;
}

function shellColorFromJson(json: string): string {
  if (json.length === 0) {
    return SHELL_DARK;
  }
  try {
    const o = JSON.parse(json) as WtPrefsShape;
    if (o.scheme === 'lightcream') {
      return SHELL_LIGHT;
    }
  } catch (_e) {}
  return SHELL_DARK;
}

let isWindowMaximized: boolean = false;

class TerminalProxy {
  controller: web_webview.WebviewController | null = null;
  prefStore: preferences.Preferences | null = null;
  context: common.UIAbilityContext | null = null;

  initPrefsStore(ctx: common.UIAbilityContext): void {
    if (this.prefStore !== null) {
      return;
    }
    try {
      this.prefStore = preferences.getPreferencesSync(ctx, { name: PREFS_NAME });
    } catch (e) {
      hilog.error(DOMAIN, TAG, `initPrefsStore: ${e}`);
    }
  }

  saveWebPrefs(json: string): void {
    const store = this.prefStore;
    if (store === null) {
      hilog.warn(DOMAIN, TAG, 'saveWebPrefs: no prefStore');
      return;
    }
    try {
      store.putSync(PREFS_FIELD, json);
      store.flush((err) => {
        if (err) {
          hilog.error(DOMAIN, TAG, `flush: ${err.code} ${err.message}`);
        }
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, `saveWebPrefs: ${e}`);
    }
  }

  loadWebPrefs(): string {
    const store = this.prefStore;
    if (store === null) {
      return '';
    }
    try {
      return store.getSync(PREFS_FIELD, '') as string;
    } catch (e) {
      hilog.error(DOMAIN, TAG, `loadWebPrefs: ${e}`);
      return '';
    }
  }

  startSession(profile: string): number {
    const ctl = this.controller;
    if (ctl === null) {
      return -1;
    }
    try {
      return testNapi.startPty((sessionId: number, data: string) => {
        try {
          ctl.runJavaScript(`window.writeToTerminal(${sessionId}, ${JSON.stringify(data)});`);
        } catch (e) {
          hilog.error(DOMAIN, TAG, `runJavaScript: ${e}`);
        }
      }, profile);
    } catch (e) {
      hilog.error(DOMAIN, TAG, `startSession: ${e}`);
      return -1;
    }
  }

  stopSession(sessionId: number): void {
    testNapi.stopPty(sessionId);
  }

  writeToPty(data: string, sessionId: number): void {
    testNapi.writePty(data, sessionId);
  }

  resizePty(cols: number, rows: number, sessionId: number): void {
    testNapi.resizePty(cols, rows, sessionId);
  }

  getLastPtyError(): string {
    try {
      return testNapi.getLastPtyError();
    } catch (_e) {
      return '(no getLastPtyError)';
    }
  }

  minimizeWindow(): void {
    if (!this.context) return;
    window.getLastWindow(this.context).then((win) => {
      win.minimize();
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, `minimizeWindow: ${err.message}`);
    });
  }

  maximizeWindow(): void {
    if (!this.context) return;
    window.getLastWindow(this.context).then((win) => {
      if (isWindowMaximized) {
        win.setWindowLayoutFullScreen(false).then(() => {
          win.setWindowSystemBarEnable(['status', 'navigation']).catch(() => {});
          try { win.setWindowDecorVisible(true); } catch (e) {}
          isWindowMaximized = false;
        }).catch((err: Error) => {
          hilog.error(DOMAIN, TAG, `setWindowLayoutFullScreen false: ${err.message}`);
        });
      } else {
        win.setWindowLayoutFullScreen(true).then(() => {
          win.setWindowSystemBarEnable([]).catch(() => {});
          try { win.setWindowDecorVisible(false); } catch (e) {}
          isWindowMaximized = true;
        }).catch((err: Error) => {
          hilog.error(DOMAIN, TAG, `setWindowLayoutFullScreen true: ${err.message}`);
        });
      }
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, `maximizeWindow: ${err.message}`);
    });
  }

  closeWindow(): void {
    if (!this.context) return;
    this.context.terminateSelf().catch((err: Error) => {
      hilog.error(DOMAIN, TAG, `closeWindow: ${err.message}`);
    });
  }
}

@Entry
@Component
struct Index {
  controller: web_webview.WebviewController = new web_webview.WebviewController();
  terminalProxy: TerminalProxy = new TerminalProxy();
  @State shellBg: string = SHELL_DARK;

  initPrefs(): void {
    if (this.terminalProxy.prefStore !== null) {
      return;
    }
    try {
      const host = this.getUIContext().getHostContext();
      if (host === undefined) {
        return;
      }
      this.terminalProxy.initPrefsStore(host as common.UIAbilityContext);
    } catch (e) {
      hilog.error(DOMAIN, TAG, `initPrefs: ${e}`);
    }
  }

  aboutToAppear(): void {
    this.terminalProxy.controller = this.controller;
    this.terminalProxy.context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.initPrefs();
    this.shellBg = shellColorFromJson(this.terminalProxy.loadWebPrefs());
  }

  aboutToDisappear() {
    testNapi.stopPty();
  }

  build() {
    Row() {
      Column() {
        Web({ src: $rawfile('index.html'), controller: this.controller })
          .javaScriptAccess(true)
          .javaScriptProxy({
            object: this.terminalProxy,
            name: 'TerminalProxy',
            methodList: [
              'startSession',
              'stopSession',
              'writeToPty',
              'resizePty',
              'getLastPtyError',
              'saveWebPrefs',
              'loadWebPrefs',
              'minimizeWindow',
              'maximizeWindow',
              'closeWindow'
            ],
            controller: this.controller
          })
          .onPageEnd(() => {
            try {
              this.initPrefs();
              const prefsJson = this.terminalProxy.loadWebPrefs();
              this.shellBg = shellColorFromJson(prefsJson);
              let js = '';
              if (prefsJson.length > 0) {
                js = 'try{window.__wtInjectedPrefsJson=' + JSON.stringify(prefsJson) + ';}catch(e){};';
              }
              js += 'try{window.wtBootstrap&&window.wtBootstrap();}catch(e){};';
              this.controller.runJavaScript(js);
            } catch (e) {
              hilog.error(DOMAIN, TAG, `onPageEnd: ${e}`);
              try {
                this.controller.runJavaScript('window.wtBootstrap && window.wtBootstrap();');
              } catch (e2) {
                hilog.error(DOMAIN, TAG, `wtBootstrap: ${e2}`);
              }
            }
          })
          .width('100%')
          .height('100%')
      }
      .width('100%')
    }
    .height('100%')
    .backgroundColor(this.shellBg)
  }
}
