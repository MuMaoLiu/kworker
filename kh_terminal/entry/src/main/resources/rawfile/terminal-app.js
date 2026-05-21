/**
 * Web terminal app logic (loaded from index.html).
 * Sections: theme/constants, prefs persistence, xterm + tabs, settings panel, profile menu.
 * Native bridge: window.TerminalProxy (ArkTS); exports: __wtPrefs, wtBootstrap, writeToTerminal.
 * 剪贴板：所有 Shell profile（PowerShell、管理员、KHSL、default 等）共用 createTab 内同一套 xterm，选中自动复制与 copy 事件增强对全部生效。
 */
(function() {
    'use strict';

    // --- Theme & xterm defaults ---
    var WT_FONT =
        '\'Cascadia Mono\', \'Cascadia Code\', Consolas, \'Sarasa Mono SC\', \'Noto Sans Mono CJK SC\', monospace';

    /** 将 Windows Terminal defaults.json 中的方案字段映射为 xterm ITheme。 */
    function __wtThemeFromWt(w) {
        var sel = w.selectionBackground;
        if (!sel) {
            sel = 'rgba(161, 198, 247, 0.35)';
        }
        var selfg = w.selectionForeground;
        if (!selfg) {
            selfg = w.foreground;
        }
        return {
            background: w.background,
            foreground: w.foreground,
            cursor: w.cursorColor || w.foreground,
            cursorAccent: w.background,
            selectionForeground: selfg,
            selectionBackground: sel,
            black: w.black,
            red: w.red,
            green: w.green,
            yellow: w.yellow,
            blue: w.blue,
            magenta: w.purple,
            cyan: w.cyan,
            white: w.white,
            brightBlack: w.brightBlack,
            brightRed: w.brightRed,
            brightGreen: w.brightGreen,
            brightYellow: w.brightYellow,
            brightBlue: w.brightBlue,
            brightMagenta: w.brightPurple,
            brightCyan: w.brightCyan,
            brightWhite: w.brightWhite
        };
    }

    /** 应用窗口 Chrome 使用浅色变量（与 data-wt-app-scheme 一致）。 */
    function __wtIsLightUiScheme(schemeId) {
        return schemeId === 'lightcream' || schemeId === 'onehalf_light' || schemeId === 'solarized_light' ||
            schemeId === 'tango_light' || schemeId === 'vscode_light_modern';
    }

    function __wtClampFontSize(n) {
        var v = parseInt(n, 10);
        if (isNaN(v)) {
            return 22;
        }
        return Math.min(36, Math.max(8, v));
    }

    function __wtNearestStandardFontSize(fs) {
        var o = [14, 18, 22];
        var best = o[0];
        var bd = 9999;
        var i;
        for (i = 0; i < o.length; i++) {
            var d = Math.abs(o[i] - fs);
            if (d < bd) {
                bd = d;
                best = o[i];
            }
        }
        return best;
    }

    function __wtComposeFontFamily(primary) {
        var prim =
            primary && String(primary).trim() ?
            String(primary).trim().replace(/['\\<>]/g, '') :
            'Cascadia Mono';
        return '\'' + prim + '\', \'Cascadia Code\', Consolas, \'Sarasa Mono SC\', \'Noto Sans Mono CJK SC\', monospace';
    }

    var __wtXtermMeasureCv = null;

    /**
     * 用当前 term.options 估算单元格宽高（CSS 像素），避免在改字体/主题后仍用 _core.cell 旧值算 cols，
     * 否则列数过小会出现提示符只显示 “ro” 等错位，且 viewport 无可滚动高度。
     */
    function __wtMeasureXtermCellPx(term) {
        var opt = term && term.options ? term.options : {};
        var fs = typeof opt.fontSize === 'number' && opt.fontSize > 0 ? opt.fontSize : 15;
        var fw = typeof opt.fontWeight === 'string' ? opt.fontWeight : 'normal';
        var ff = typeof opt.fontFamily === 'string' ? opt.fontFamily : 'monospace';
        var lhMul = typeof opt.lineHeight === 'number' && opt.lineHeight > 0 ? opt.lineHeight : 1;
        var ls = typeof opt.letterSpacing === 'number' ? opt.letterSpacing : 0;
        if (!__wtXtermMeasureCv) {
            __wtXtermMeasureCv = document.createElement('canvas');
        }
        var ctx = __wtXtermMeasureCv.getContext('2d');
        if (!ctx) {
            return {
                width: Math.max(4, fs * 0.62 + ls),
                height: Math.max(4, Math.ceil(fs * lhMul))
            };
        }
        ctx.font = fw + ' ' + fs + 'px ' + ff;
        var probe = ctx.measureText('W').width || fs * 0.62;
        return {
            width: Math.max(1, probe + ls),
            height: Math.max(1, Math.ceil(fs * lhMul))
        };
    }

    function __wtHexWithAlpha(hex, alpha01) {
        if (typeof hex !== 'string' || hex.charAt(0) !== '#' || hex.length !== 7) {
            return hex;
        }
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        var a = typeof alpha01 === 'number' ? Math.max(0, Math.min(1, alpha01)) : 1;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    function __wtParseColorToRgba(str) {
        if (typeof str !== 'string') {
            return null;
        }
        var s = str.trim();
        var m;
        m = s.match(/^#([0-9A-Fa-f]{6})$/);
        if (m) {
            var h = m[1];
            return {
                r: parseInt(h.slice(0, 2), 16),
                g: parseInt(h.slice(2, 4), 16),
                b: parseInt(h.slice(4, 6), 16),
                a: 1
            };
        }
        m = s.match(/^rgba\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/i);
        if (m) {
            return {
                r: Math.max(0, Math.min(255, parseInt(m[1], 10))),
                g: Math.max(0, Math.min(255, parseInt(m[2], 10))),
                b: Math.max(0, Math.min(255, parseInt(m[3], 10))),
                a: Math.max(0, Math.min(1, parseFloat(m[4])))
            };
        }
        m = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (m) {
            return {
                r: Math.max(0, Math.min(255, parseInt(m[1], 10))),
                g: Math.max(0, Math.min(255, parseInt(m[2], 10))),
                b: Math.max(0, Math.min(255, parseInt(m[3], 10))),
                a: 1
            };
        }
        return null;
    }

    function __wtBlendRgbOver(top, bottom, aTop) {
        var a = typeof aTop === 'number' ? Math.max(0, Math.min(1, aTop)) : 1;
        return {
            r: Math.round(top.r * a + bottom.r * (1 - a)),
            g: Math.round(top.g * a + bottom.g * (1 - a)),
            b: Math.round(top.b * a + bottom.b * (1 - a))
        };
    }

    function __wtRelativeLuminance(rgb) {
        var f = function(c) {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
    }

    function __wtContrastRatio(lumA, lumB) {
        var hi = Math.max(lumA, lumB) + 0.05;
        var lo = Math.min(lumA, lumB) + 0.05;
        return hi / lo;
    }

    /** 半透明终端背景与近似底色素叠，供选区半透明色估算对比度。 */
    function __wtEffectiveTerminalBgRgb(theme) {
        var under = { r: 12, g: 12, b: 12 };
        var bg = __wtParseColorToRgba(theme.background);
        if (!bg) {
            return under;
        }
        if (bg.a >= 0.999) {
            return { r: bg.r, g: bg.g, b: bg.b };
        }
        return __wtBlendRgbOver({ r: bg.r, g: bg.g, b: bg.b }, under, bg.a);
    }

    /**
     * 若 selectionForeground 与（叠加后的）选区底色对比不足，则改为深/浅高对比色。
     * 缓解 Dark+（白选区+浅字）、One Half Light（深灰选区+同色字）、纯白选区+浅灰字等组合。
     */
    function __wtEnsureSelectionContrast(theme) {
        var termSolid = __wtEffectiveTerminalBgRgb(theme);
        var selRgba = __wtParseColorToRgba(theme.selectionBackground);
        if (!selRgba) {
            return;
        }
        var selSolid;
        if (selRgba.a >= 0.999) {
            selSolid = { r: selRgba.r, g: selRgba.g, b: selRgba.b };
        } else {
            selSolid = __wtBlendRgbOver({ r: selRgba.r, g: selRgba.g, b: selRgba.b }, termSolid, selRgba.a);
        }
        var selL = __wtRelativeLuminance(selSolid);
        var fgRgba = __wtParseColorToRgba(theme.selectionForeground || theme.foreground);
        if (!fgRgba) {
            return;
        }
        var fgL = __wtRelativeLuminance({ r: fgRgba.r, g: fgRgba.g, b: fgRgba.b });
        if (__wtContrastRatio(fgL, selL) >= 3.2) {
            return;
        }
        var lumDark = __wtRelativeLuminance({ r: 26, g: 26, b: 26 });
        var lumLight = __wtRelativeLuminance({ r: 243, g: 243, b: 243 });
        var rDark = __wtContrastRatio(lumDark, selL);
        var rLight = __wtContrastRatio(lumLight, selL);
        theme.selectionForeground = rLight >= rDark ? '#f3f3f3' : '#1a1a1a';
    }

    function __wtThemeForTerminal() {
        var p = window.__wtPrefs;
        var base = THEME_PRESETS[p.scheme] || THEME_PRESETS.dark;
        var theme = JSON.parse(JSON.stringify(base));
        var curOv = typeof p.cursorColorOverride === 'string' ? p.cursorColorOverride.trim() : '';
        if (/^#[0-9A-Fa-f]{6}$/.test(curOv)) {
            theme.cursor = curOv;
        }
        var bgOp = typeof p.terminalBgOpacity === 'number' ? p.terminalBgOpacity : 100;
        if (bgOp < 100 && theme.background && theme.background.indexOf('#') === 0) {
            theme.background = __wtHexWithAlpha(theme.background, bgOp / 100);
        }
        __wtEnsureSelectionContrast(theme);
        return theme;
    }

    function __wtParseTerminalPadding(s) {
        var d = { top: 8, right: 8, bottom: 8, left: 8 };
        if (typeof s !== 'string') {
            return d;
        }
        var parts = s.split(/[\s,]+/).filter(Boolean);
        var nums = [];
        var i;
        for (i = 0; i < parts.length; i++) {
            var n = parseInt(parts[i], 10);
            nums.push(isNaN(n) ? null : n);
        }
        if (nums.length === 1 && nums[0] !== null) {
            var u = Math.max(0, Math.min(64, nums[0]));
            d.top = d.right = d.bottom = d.left = u;
        } else if (nums.length >= 4 && nums[0] !== null) {
            d.top = Math.max(0, Math.min(64, nums[0]));
            d.right = Math.max(0, Math.min(64, nums[1] != null ? nums[1] : nums[0]));
            d.bottom = Math.max(0, Math.min(64, nums[2] != null ? nums[2] : nums[0]));
            d.left = Math.max(0, Math.min(64, nums[3] != null ? nums[3] : nums[0]));
        }
        return d;
    }

    function __wtMapBgAlignment(a) {
        var map = {
            center: 'center center',
            top: 'center top',
            bottom: 'center bottom',
            left: 'left center',
            right: 'right center',
            topLeft: 'left top',
            topRight: 'right top',
            bottomLeft: 'left bottom',
            bottomRight: 'right bottom'
        };
        return map[a] || 'center center';
    }

    function __wtApplyPaneDecorations(tab) {
        if (!tab || !tab.paneEl) {
            return;
        }
        var p = window.__wtPrefs;
        var inner = tab.paneEl.querySelector('.wt-term-pane-inner');
        var rail = tab.paneEl.querySelector('.wt-term-scroll-rail');
        if (!inner) {
            return;
        }
        var pad = __wtParseTerminalPadding(p.terminalPadding);
        inner.style.padding =
            pad.top + 'px ' + pad.right + 'px ' + pad.bottom + 'px ' + pad.left + 'px';
        inner.classList.toggle('wt-term-pane-acrylic', !!p.useAcrylic);
        var path = typeof p.backgroundImagePath === 'string' ? p.backgroundImagePath.trim() : '';
        if (path) {
            var esc = path.replace(/\\/g, '/').replace(/"/g, '%22');
            var url =
                path.indexOf('://') >= 0 || path.indexOf('data:') === 0 ?
                esc :
                'file:///' + esc;
            inner.style.backgroundImage = 'url("' + url + '")';
            var sizes = {
                fill: '100% 100%',
                none: 'auto',
                uniform: 'contain',
                uniformToFill: 'cover'
            };
            inner.style.backgroundSize = sizes[p.backgroundImageStretch] || 'cover';
            inner.style.backgroundPosition = __wtMapBgAlignment(p.backgroundImageAlignment);
            inner.style.backgroundRepeat = 'no-repeat';
            var iop = typeof p.backgroundImageOpacity === 'number' ? p.backgroundImageOpacity : 100;
            if (iop < 100) {
                inner.style.boxShadow =
                    'inset 0 0 0 10000px rgba(0,0,0,' + ((100 - iop) / 100 * 0.9) + ')';
            } else {
                inner.style.boxShadow = '';
            }
        } else {
            inner.style.backgroundImage = '';
            inner.style.backgroundSize = '';
            inner.style.backgroundPosition = '';
            inner.style.backgroundRepeat = '';
            inner.style.boxShadow = '';
        }
        if (rail) {
            rail.style.display = p.terminalScrollbarMode === 'hidden' ? 'none' : '';
        }
    }

    function __wtEnsureDefSchemeSelect(root) {
        var sel = root.querySelector('.wt-def-scheme-select');
        if (!sel || sel.getAttribute('data-wt-filled') === '1') {
            return;
        }
        sel.setAttribute('data-wt-filled', '1');
        var i;
        for (i = 0; i < WT_COLOR_SCHEME_CATALOG.length; i++) {
            var ent = WT_COLOR_SCHEME_CATALOG[i];
            if (!THEME_PRESETS[ent.id]) {
                continue;
            }
            var opt = document.createElement('option');
            opt.value = ent.id;
            opt.textContent = ent.title + (ent.badge ? '（' + ent.badge + '）' : '');
            sel.appendChild(opt);
        }
    }

    function __wtSyncDefAppearancePreview(root) {
        var box = root.querySelector('.wt-def-term-preview-body');
        if (!box) {
            return;
        }
        var p = window.__wtPrefs;
        var theme = __wtThemeForTerminal();
        var fam = __wtComposeFontFamily(p.fontFamily);
        var fs = __wtClampFontSize(p.fontSize);
        var lh = typeof p.terminalLineHeight === 'number' ? p.terminalLineHeight : 1.2;
        box.style.fontFamily = fam;
        box.style.fontSize = fs + 'px';
        box.style.lineHeight = String(lh);
        box.style.background = theme.background || '#0c0c0c';
        box.style.color = theme.foreground || '#ccc';
        var rc = theme.red || '#cd3131';
        var gc = theme.green || '#0dbc79';
        var yc = theme.yellow || '#e5e510';
        var bc = theme.blue || '#2472c8';
        box.innerHTML =
            '<span style="color:' + yc + '">PS C:\\repo&gt; </span><span style="color:' + bc + '">git diff</span><br>' +
            '<span style="color:' + rc + '">- old line</span><br>' +
            '<span style="color:' + gc + '">+ new line</span><br>' +
            '<span style="opacity:0.85">配色预览（示意）</span>';
    }

    var THEME_PRESETS = {
        dark: __wtThemeFromWt({
            name: 'Campbell',
            foreground: '#CCCCCC',
            background: '#0C0C0C',
            cursorColor: '#FFFFFF',
            black: '#0C0C0C',
            red: '#C50F1F',
            green: '#13A10E',
            yellow: '#C19C00',
            blue: '#0037DA',
            purple: '#881798',
            cyan: '#3A96DD',
            white: '#CCCCCC',
            brightBlack: '#767676',
            brightRed: '#E74856',
            brightGreen: '#16C60C',
            brightYellow: '#F9F1A5',
            brightBlue: '#3B78FF',
            brightPurple: '#B4009E',
            brightCyan: '#61D6D6',
            brightWhite: '#F2F2F2'
        }),
        campbell_powershell: __wtThemeFromWt({
            name: 'Campbell Powershell',
            foreground: '#CCCCCC',
            background: '#012456',
            cursorColor: '#FFFFFF',
            black: '#0C0C0C',
            red: '#C50F1F',
            green: '#13A10E',
            yellow: '#C19C00',
            blue: '#0037DA',
            purple: '#881798',
            cyan: '#3A96DD',
            white: '#CCCCCC',
            brightBlack: '#767676',
            brightRed: '#E74856',
            brightGreen: '#16C60C',
            brightYellow: '#F9F1A5',
            brightBlue: '#3B78FF',
            brightPurple: '#B4009E',
            brightCyan: '#61D6D6',
            brightWhite: '#F2F2F2'
        }),
        cga: __wtThemeFromWt({
            name: 'CGA',
            background: '#000000',
            black: '#000000',
            blue: '#0000AA',
            brightBlack: '#555555',
            brightBlue: '#5555FF',
            brightCyan: '#55FFFF',
            brightGreen: '#55FF55',
            brightPurple: '#FF55FF',
            brightRed: '#FF5555',
            brightWhite: '#FFFFFF',
            brightYellow: '#FFFF55',
            cursorColor: '#00AA00',
            cyan: '#00AAAA',
            foreground: '#AAAAAA',
            green: '#00AA00',
            purple: '#AA00AA',
            red: '#AA0000',
            selectionBackground: '#FFFFFF',
            selectionForeground: '#1a1a1a',
            white: '#AAAAAA',
            yellow: '#AA5500'
        }),
        dark_plus: __wtThemeFromWt({
            name: 'Dark+',
            foreground: '#cccccc',
            background: '#1e1e1e',
            cursorColor: '#808080',
            selectionBackground: '#ffffff',
            selectionForeground: '#1a1a1a',
            black: '#000000',
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#2472c8',
            purple: '#bc3fbc',
            cyan: '#11a8cd',
            white: '#e5e5e5',
            brightBlack: '#666666',
            brightRed: '#f14c4c',
            brightGreen: '#23d18b',
            brightYellow: '#f5f543',
            brightBlue: '#3b8eea',
            brightPurple: '#d670d6',
            brightCyan: '#29b8db',
            brightWhite: '#e5e5e5'
        }),
        dimidium: __wtThemeFromWt({
            name: 'Dimidium',
            background: '#141414',
            foreground: '#BAB7B6',
            cursorColor: '#37E57B',
            selectionBackground: '#8DB8E5',
            black: '#000000',
            red: '#CF494C',
            green: '#60B442',
            yellow: '#DB9C11',
            blue: '#0575D8',
            purple: '#AF5ED2',
            cyan: '#1DB6BB',
            white: '#BAB7B6',
            brightBlack: '#817E7E',
            brightRed: '#FF643B',
            brightGreen: '#37E57B',
            brightYellow: '#FCCD1A',
            brightBlue: '#688DFD',
            brightPurple: '#ED6FE9',
            brightCyan: '#32E0FB',
            brightWhite: '#DEE3E4'
        }),
        ibm5153: __wtThemeFromWt({
            name: 'IBM 5153',
            background: '#000000',
            black: '#000000',
            blue: '#0000AA',
            brightBlack: '#555555',
            brightBlue: '#5555FF',
            brightCyan: '#55FFFF',
            brightGreen: '#55FF55',
            brightPurple: '#FF55FF',
            brightRed: '#FF5555',
            brightWhite: '#FFFFFF',
            brightYellow: '#FFFF55',
            cursorColor: '#00AA00',
            cyan: '#00AAAA',
            foreground: '#AAAAAA',
            green: '#00AA00',
            purple: '#AA00AA',
            red: '#AA0000',
            selectionBackground: '#FFFFFF',
            selectionForeground: '#1a1a1a',
            white: '#AAAAAA',
            yellow: '#C47E00'
        }),
        onehalf_dark: __wtThemeFromWt({
            name: 'One Half Dark',
            foreground: '#DCDFE4',
            background: '#282C34',
            cursorColor: '#FFFFFF',
            black: '#282C34',
            red: '#E06C75',
            green: '#98C379',
            yellow: '#E5C07B',
            blue: '#61AFEF',
            purple: '#C678DD',
            cyan: '#56B6C2',
            white: '#DCDFE4',
            brightBlack: '#5A6374',
            brightRed: '#E06C75',
            brightGreen: '#98C379',
            brightYellow: '#E5C07B',
            brightBlue: '#61AFEF',
            brightPurple: '#C678DD',
            brightCyan: '#56B6C2',
            brightWhite: '#DCDFE4'
        }),
        onehalf_light: __wtThemeFromWt({
            name: 'One Half Light',
            foreground: '#383A42',
            background: '#FAFAFA',
            cursorColor: '#4F525D',
            selectionBackground: '#383A42',
            selectionForeground: '#fafafa',
            black: '#383A42',
            red: '#E45649',
            green: '#50A14F',
            yellow: '#C18301',
            blue: '#0184BC',
            purple: '#A626A4',
            cyan: '#0997B3',
            white: '#FAFAFA',
            brightBlack: '#4F525D',
            brightRed: '#DF6C75',
            brightGreen: '#98C379',
            brightYellow: '#E4C07A',
            brightBlue: '#61AFEF',
            brightPurple: '#C577DD',
            brightCyan: '#56B5C1',
            brightWhite: '#FFFFFF'
        }),
        ottosson: __wtThemeFromWt({
            name: 'Ottosson',
            background: '#000000',
            foreground: '#bebebe',
            cursorColor: '#ffffff',
            selectionBackground: '#92a4fd',
            black: '#000000',
            red: '#be2c21',
            green: '#3fae3a',
            yellow: '#be9a4a',
            blue: '#204dbe',
            purple: '#bb54be',
            cyan: '#00a7b2',
            white: '#bebebe',
            brightBlack: '#808080',
            brightRed: '#ff3e30',
            brightGreen: '#58ea51',
            brightYellow: '#ffc944',
            brightBlue: '#2f6aff',
            brightPurple: '#fc74ff',
            brightCyan: '#00e1f0',
            brightWhite: '#ffffff'
        }),
        solarized_dark: __wtThemeFromWt({
            name: 'Solarized Dark',
            foreground: '#839496',
            background: '#002B36',
            cursorColor: '#FFFFFF',
            black: '#002B36',
            red: '#DC322F',
            green: '#859900',
            yellow: '#B58900',
            blue: '#268BD2',
            purple: '#D33682',
            cyan: '#2AA198',
            white: '#EEE8D5',
            brightBlack: '#073642',
            brightRed: '#CB4B16',
            brightGreen: '#586E75',
            brightYellow: '#657B83',
            brightBlue: '#839496',
            brightPurple: '#6C71C4',
            brightCyan: '#93A1A1',
            brightWhite: '#FDF6E3'
        }),
        solarized_light: __wtThemeFromWt({
            name: 'Solarized Light',
            foreground: '#657B83',
            background: '#FDF6E3',
            cursorColor: '#002B36',
            selectionBackground: '#2C4D57',
            black: '#002B36',
            red: '#DC322F',
            green: '#859900',
            yellow: '#B58900',
            blue: '#268BD2',
            purple: '#D33682',
            cyan: '#2AA198',
            white: '#EEE8D5',
            brightBlack: '#073642',
            brightRed: '#CB4B16',
            brightGreen: '#586E75',
            brightYellow: '#657B83',
            brightBlue: '#839496',
            brightPurple: '#6C71C4',
            brightCyan: '#93A1A1',
            brightWhite: '#FDF6E3'
        }),
        tango_dark: __wtThemeFromWt({
            name: 'Tango Dark',
            foreground: '#D3D7CF',
            background: '#000000',
            cursorColor: '#FFFFFF',
            black: '#000000',
            red: '#CC0000',
            green: '#4E9A06',
            yellow: '#C4A000',
            blue: '#3465A4',
            purple: '#75507B',
            cyan: '#06989A',
            white: '#D3D7CF',
            brightBlack: '#555753',
            brightRed: '#EF2929',
            brightGreen: '#8AE234',
            brightYellow: '#FCE94F',
            brightBlue: '#729FCF',
            brightPurple: '#AD7FA8',
            brightCyan: '#34E2E2',
            brightWhite: '#EEEEEC'
        }),
        tango_light: __wtThemeFromWt({
            name: 'Tango Light',
            foreground: '#555753',
            background: '#FFFFFF',
            cursorColor: '#000000',
            selectionBackground: '#141414',
            black: '#000000',
            red: '#CC0000',
            green: '#4E9A06',
            yellow: '#C4A000',
            blue: '#3465A4',
            purple: '#75507B',
            cyan: '#06989A',
            white: '#D3D7CF',
            brightBlack: '#555753',
            brightRed: '#EF2929',
            brightGreen: '#8AE234',
            brightYellow: '#FCE94F',
            brightBlue: '#729FCF',
            brightPurple: '#AD7FA8',
            brightCyan: '#34E2E2',
            brightWhite: '#EEEEEC'
        }),
        vintage: __wtThemeFromWt({
            name: 'Vintage',
            foreground: '#C0C0C0',
            background: '#000000',
            cursorColor: '#FFFFFF',
            black: '#000000',
            red: '#800000',
            green: '#008000',
            yellow: '#808000',
            blue: '#000080',
            purple: '#800080',
            cyan: '#008080',
            white: '#C0C0C0',
            brightBlack: '#808080',
            brightRed: '#FF0000',
            brightGreen: '#00FF00',
            brightYellow: '#FFFF00',
            brightBlue: '#0000FF',
            brightPurple: '#FF00FF',
            brightCyan: '#00FFFF',
            brightWhite: '#FFFFFF'
        }),
        vscode_dark_modern: __wtThemeFromWt({
            name: 'VSCode Dark Modern',
            foreground: '#CCCCCC',
            background: '#1F1F1F',
            cursorColor: '#FFFFFF',
            selectionBackground: '#264F78',
            black: '#000000',
            red: '#CD3131',
            green: '#0DBC79',
            yellow: '#E5E510',
            blue: '#2472C8',
            purple: '#BC3FBC',
            cyan: '#11A8CD',
            white: '#E5E5E5',
            brightBlack: '#666666',
            brightRed: '#F14C4C',
            brightGreen: '#23D18B',
            brightYellow: '#F5F543',
            brightBlue: '#3B8EEA',
            brightPurple: '#D670D6',
            brightCyan: '#29B8DB',
            brightWhite: '#E5E5E5'
        }),
        vscode_light_modern: __wtThemeFromWt({
            name: 'VSCode Light Modern',
            foreground: '#3B3B3B',
            background: '#FFFFFF',
            cursorColor: '#000000',
            selectionBackground: '#ADD6FF',
            black: '#000000',
            red: '#CD3131',
            green: '#00BC00',
            yellow: '#949800',
            blue: '#0451A5',
            purple: '#BC05BC',
            cyan: '#0598BC',
            white: '#555555',
            brightBlack: '#666666',
            brightRed: '#CD3131',
            brightGreen: '#14CE14',
            brightYellow: '#B5BA00',
            brightBlue: '#0451A5',
            brightPurple: '#BC05BC',
            brightCyan: '#0598BC',
            brightWhite: '#A5A5A5'
        }),
        ubuntu: __wtThemeFromWt({
            name: 'Ubuntu',
            foreground: '#FFFFFF',
            background: '#300A24',
            cursorColor: '#FFFFFF',
            black: '#171421',
            red: '#C01C28',
            green: '#26A269',
            yellow: '#A2734C',
            blue: '#0037DA',
            purple: '#881798',
            cyan: '#2AA1B3',
            white: '#FFFFFF',
            brightBlack: '#767676',
            brightRed: '#C01C28',
            brightGreen: '#26A269',
            brightYellow: '#A2734C',
            brightBlue: '#08458F',
            brightPurple: '#A347BA',
            brightCyan: '#2C9FB3',
            brightWhite: '#F2F2F2'
        }),
        lightcream: {
            background: '#faf7f0',
            foreground: '#1a1a1a',
            cursor: '#1a1a1a',
            cursorAccent: '#faf7f0',
            selectionForeground: '#1a1a1a',
            selectionBackground: 'rgba(15, 108, 189, 0.22)',
            black: '#000000',
            red: '#b00020',
            green: '#00825b',
            yellow: '#8a6d00',
            blue: '#0f6cbd',
            magenta: '#881798',
            cyan: '#038387',
            white: '#555555',
            brightBlack: '#767676',
            brightRed: '#e81123',
            brightGreen: '#16c60c',
            brightYellow: '#c19c00',
            brightBlue: '#0078d4',
            brightMagenta: '#b4009e',
            brightCyan: '#00b7c3',
            brightWhite: '#242424'
        }
    };

    var WT_COLOR_SCHEME_CATALOG = [
        { id: 'cga', title: 'CGA', desc: '经典 CGA 高对比 16 色，与 Windows Terminal 内置一致。' },
        { id: 'dark', title: 'Campbell', badge: '默认', desc: 'Windows Terminal 默认深色方案。' },
        { id: 'campbell_powershell', title: 'Campbell Powershell', desc: '深蓝背景，ANSI 色与 Campbell 相同。' },
        { id: 'dark_plus', title: 'Dark+', desc: '与 VS Code 深色编辑器相近的终端配色。' },
        { id: 'dimidium', title: 'Dimidium', desc: '现代低饱和深色方案。' },
        { id: 'ibm5153', title: 'IBM 5153', desc: 'IBM PC 风格 CGA 变体（琥珀黄强调）。' },
        { id: 'onehalf_dark', title: 'One Half Dark', desc: 'Atom One Half 深色版。' },
        { id: 'onehalf_light', title: 'One Half Light', desc: 'Atom One Half 浅色版。' },
        { id: 'ottosson', title: 'Ottosson', desc: 'OLED 友好高对比方案。' },
        { id: 'solarized_dark', title: 'Solarized Dark', desc: '经典 Solarized 深色。' },
        { id: 'solarized_light', title: 'Solarized Light', desc: '经典 Solarized 浅色。' },
        { id: 'tango_dark', title: 'Tango Dark', desc: '基于 Tango 桌面色板的深色终端。' },
        { id: 'tango_light', title: 'Tango Light', desc: '基于 Tango 桌面色板的浅色终端。' },
        { id: 'ubuntu', title: 'Ubuntu', desc: 'Ubuntu 终端风格紫底配色。' },
        { id: 'vintage', title: 'Vintage', desc: '老式 16 色 VGA 风格。' },
        { id: 'vscode_dark_modern', title: 'VS Code Dark Modern', desc: 'VS Code 现代深色 UI 配套方案。' },
        { id: 'vscode_light_modern', title: 'VS Code Light Modern', desc: 'VS Code 现代浅色 UI 配套方案。' },
        { id: 'lightcream', title: '乳白浅彩', desc: '本应用内置浅色方案，乳白背景。' }
    ];

    function __wtRenderColorSchemeCards(root) {
        var list = root.querySelector('.wt-color-scheme-list');
        if (!list || list.getAttribute('data-wt-cards-built') === '1') {
            return;
        }
        list.setAttribute('data-wt-cards-built', '1');
        var order = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
            'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
        ];
        for (var i = 0; i < WT_COLOR_SCHEME_CATALOG.length; i++) {
            var ent = WT_COLOR_SCHEME_CATALOG[i];
            var t = THEME_PRESETS[ent.id];
            if (!t) {
                continue;
            }
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wt-color-scheme-card wt-color-scheme-card--row';
            btn.setAttribute('data-scheme', ent.id);
            btn.setAttribute('aria-pressed', 'false');
            var grid = document.createElement('div');
            grid.className = 'wt-color-swatch-grid';
            grid.setAttribute('aria-hidden', 'true');
            for (var k = 0; k < order.length; k++) {
                var sp = document.createElement('span');
                sp.style.background = t[order[k]] || '#000000';
                grid.appendChild(sp);
            }
            var text = document.createElement('div');
            text.className = 'wt-color-card-text';
            var h3 = document.createElement('h3');
            if (ent.badge) {
                var s1 = document.createElement('span');
                s1.textContent = ent.title;
                h3.appendChild(s1);
                var badge = document.createElement('span');
                badge.className = 'wt-color-scheme-badge';
                badge.textContent = ent.badge;
                h3.appendChild(badge);
            } else {
                h3.textContent = ent.title;
            }
            var pEl = document.createElement('p');
            pEl.textContent = ent.desc || '';
            text.appendChild(h3);
            text.appendChild(pEl);
            btn.appendChild(grid);
            btn.appendChild(text);
            list.appendChild(btn);
        }
    }

    /** 与需求对齐：保留约 500 行滚动历史（Windows Terminal 默认更大，此处按产品要求收敛）。 */
    var WT_SCROLLBACK_LINES = 500;

    var WT_TERM_BASE = {
        cursorBlink: true,
        scrollback: WT_SCROLLBACK_LINES,
        scrollOnUserInput: true,
        fontFamily: WT_FONT,
        lineHeight: 1.2,
        letterSpacing: 0.3,
        allowProposedApi: true
    };

    var WT_INTERACTION_DEFAULTS = {
        copyFormat: 'plain',
        autoCopySelection: true,
        rectCopyTrimTrailing: true,
        pasteTrimTrailing: true,
        wordSeparators: '/ \\ ( ) "\' . , ; : < > ~ ! @ # $ % ^ & * | + = [ ] { } - ? |',
        snapWindowToCharGrid: true,
        tabSwitchStyle: 'order',
        focusPaneOnHover: false,
        ctrlScrollFontSize: true,
        ctrlShiftScrollOpacity: true,
        detectUrls: true,
        searchWebUrl: 'https://www.bing.com/search?q=%22%s%22',
        experimentalSelectionColorKeys: false
    };

    var WT_APPEARANCE_DEFAULTS = {
        newTabPosition: 'last',
        alwaysShowTabs: true,
        showTabsInFullscreen: false,
        tabRowAcrylic: false,
        useActiveTitleForAppTitle: true,
        alwaysOnTop: false,
        tabWidth: 'equal',
        paneAnimations: true,
        notifyAreaIcon: false,
        notifyHideWhenMinimized: false,
        autoHideWindow: false
    };

    var WT_RENDERING_DEFAULTS = {
        graphicsApi: 'auto',
        disablePartialSwapChain: false,
        softwareRenderingWarp: false
    };

    var WT_COMPATIBILITY_DEFAULTS = {
        allowBackgroundRun: false,
        textMeasurementMode: 'grapheme'
    };

    function __wtClampStr(s, maxLen, fallback) {
        if (typeof s !== 'string') {
            return fallback;
        }
        if (s.length > maxLen) {
            return s.substring(0, maxLen);
        }
        return s;
    }

    function __wtDefaultExtensionGenerators() {
        return {
            azure: false,
            powershellCore: false,
            ubuntuLts: false,
            visualStudio: false,
            wsl: false,
            khBuiltin: true
        };
    }

    function __wtNormalizeExtensionGenerators(o) {
        var d = __wtDefaultExtensionGenerators();
        if (!o || typeof o !== 'object') {
            return d;
        }
        var r = {};
        var keys = ['azure', 'powershellCore', 'ubuntuLts', 'visualStudio', 'wsl', 'khBuiltin'];
        for (var gi = 0; gi < keys.length; gi++) {
            var gk = keys[gi];
            r[gk] = typeof o[gk] === 'boolean' ? o[gk] : d[gk];
        }
        return r;
    }

    function __wtNormalizeNewTabMenuItems(raw) {
        var out = [];
        var seenRemaining = false;
        if (raw && Array.isArray(raw)) {
            for (var i = 0; i < raw.length; i++) {
                var it = raw[i];
                if (!it || typeof it !== 'object') {
                    continue;
                }
                if (it.kind === 'remaining') {
                    if (!seenRemaining) {
                        seenRemaining = true;
                        out.push({ kind: 'remaining' });
                    }
                    continue;
                }
                if (it.kind === 'separator') {
                    out.push({ kind: 'separator' });
                    continue;
                }
                if (it.kind === 'folder' && typeof it.name === 'string') {
                    var nm = __wtClampStr(String(it.name).trim(), 64, '');
                    if (nm.length > 0) {
                        out.push({ kind: 'folder', name: nm });
                    }
                    continue;
                }
                if (it.kind === 'profile') {
                    var pr = it.profile;
                    if (pr === 'daemon' || pr === 'khsl' || pr === 'powershell') {
                        out.push({ kind: 'profile', profile: pr });
                    }
                }
            }
        }
        if (!seenRemaining) {
            out.push({ kind: 'remaining' });
        }
        return out;
    }

    function __wtProfileToMenuLabel(profile) {
        if (profile === 'khsl') {
            return 'KHSL';
        }
        if (profile === 'daemon') {
            return '管理员：Powershell';
        }
        return 'PowerShell';
    }

    function __wtNtmItemLabel(item) {
        if (!item) {
            return '';
        }
        if (item.kind === 'remaining') {
            return '〈剩余配置文件〉';
        }
        if (item.kind === 'separator') {
            return '—— 分隔符 ——';
        }
        if (item.kind === 'folder') {
            return '文件夹：' + (item.name || '');
        }
        if (item.kind === 'profile') {
            return __wtProfileToMenuLabel(item.profile);
        }
        return '';
    }

    // --- User preferences: normalize, load/save, apply to chrome & terminals ---

    function __wtNormalizePrefs(o) {
        var d = {
            fontSize: 22,
            scheme: 'dark',
            defaultNewTabProfile: 'daemon',
            startupModeIndex: 0,
            bootOnStart: false,
            autoScroll: true,
            copyFormat: WT_INTERACTION_DEFAULTS.copyFormat,
            copyAsHtml: false,
            autoCopySelection: WT_INTERACTION_DEFAULTS.autoCopySelection,
            rectCopyTrimTrailing: WT_INTERACTION_DEFAULTS.rectCopyTrimTrailing,
            pasteTrimTrailing: WT_INTERACTION_DEFAULTS.pasteTrimTrailing,
            wordSeparators: WT_INTERACTION_DEFAULTS.wordSeparators,
            snapWindowToCharGrid: WT_INTERACTION_DEFAULTS.snapWindowToCharGrid,
            tabSwitchStyle: WT_INTERACTION_DEFAULTS.tabSwitchStyle,
            focusPaneOnHover: WT_INTERACTION_DEFAULTS.focusPaneOnHover,
            ctrlScrollFontSize: WT_INTERACTION_DEFAULTS.ctrlScrollFontSize,
            ctrlShiftScrollOpacity: WT_INTERACTION_DEFAULTS.ctrlShiftScrollOpacity,
            detectUrls: WT_INTERACTION_DEFAULTS.detectUrls,
            searchWebUrl: WT_INTERACTION_DEFAULTS.searchWebUrl,
            experimentalSelectionColorKeys: WT_INTERACTION_DEFAULTS.experimentalSelectionColorKeys,
            newTabPosition: WT_APPEARANCE_DEFAULTS.newTabPosition,
            alwaysShowTabs: WT_APPEARANCE_DEFAULTS.alwaysShowTabs,
            showTabsInFullscreen: WT_APPEARANCE_DEFAULTS.showTabsInFullscreen,
            tabRowAcrylic: WT_APPEARANCE_DEFAULTS.tabRowAcrylic,
            useActiveTitleForAppTitle: WT_APPEARANCE_DEFAULTS.useActiveTitleForAppTitle,
            alwaysOnTop: WT_APPEARANCE_DEFAULTS.alwaysOnTop,
            tabWidth: WT_APPEARANCE_DEFAULTS.tabWidth,
            paneAnimations: WT_APPEARANCE_DEFAULTS.paneAnimations,
            notifyAreaIcon: WT_APPEARANCE_DEFAULTS.notifyAreaIcon,
            notifyHideWhenMinimized: WT_APPEARANCE_DEFAULTS.notifyHideWhenMinimized,
            autoHideWindow: WT_APPEARANCE_DEFAULTS.autoHideWindow,
            graphicsApi: WT_RENDERING_DEFAULTS.graphicsApi,
            disablePartialSwapChain: WT_RENDERING_DEFAULTS.disablePartialSwapChain,
            softwareRenderingWarp: WT_RENDERING_DEFAULTS.softwareRenderingWarp,
            allowBackgroundRun: WT_COMPATIBILITY_DEFAULTS.allowBackgroundRun,
            textMeasurementMode: WT_COMPATIBILITY_DEFAULTS.textMeasurementMode,
            newTabMenuItems: __wtNormalizeNewTabMenuItems(null),
            extensionGenerators: __wtDefaultExtensionGenerators(),
            defaultStartingDirectoryMode: 'inherit',
            defaultStartingDirectory: '',
            defaultProfileIcon: '',
            defaultTabTitleMode: 'none',
            defaultElevate: false,
            fontFamily: 'Cascadia Mono',
            terminalLineHeight: 1.2,
            terminalLetterSpacing: 0.3,
            fontWeight: 'normal',
            cursorStyle: 'bar',
            cursorColorOverride: '',
            colorEmoji: true,
            retroTerminalEffect: false,
            adjustIndistinguishableColors: 'never',
            backgroundImagePath: '',
            backgroundImageStretch: 'uniformToFill',
            backgroundImageAlignment: 'center',
            backgroundImageOpacity: 100,
            intenseTextStyle: 'bright',
            terminalBgOpacity: 100,
            useAcrylic: false,
            terminalPadding: '8, 8, 8, 8',
            terminalScrollbarMode: 'visible',
            terminalCustomGlyphs: true
        };
        if (!o || typeof o !== 'object') {
            return d;
        }
        var okProf =
            o.defaultNewTabProfile === 'daemon' ||
            o.defaultNewTabProfile === 'khsl' ||
            o.defaultNewTabProfile === 'powershell';
        var copyFormat = d.copyFormat;
        if (o.copyFormat === 'html' || o.copyFormat === 'plain') {
            copyFormat = o.copyFormat;
        } else if (o.copyAsHtml === true) {
            copyFormat = 'html';
        }
        var tabStyle = o.tabSwitchStyle === 'mru' ? 'mru' : 'order';
        var wsep = typeof o.wordSeparators === 'string' && o.wordSeparators.length > 0 ?
            __wtClampStr(o.wordSeparators, 500, d.wordSeparators) :
            d.wordSeparators;
        var ntp = o.newTabPosition;
        var newTabPos = ntp === 'first' || ntp === 'after_current' ? ntp : 'last';
        var tw = o.tabWidth === 'compact' ? 'compact' : 'equal';
        var gap = o.graphicsApi;
        var gfx = gap === 'd3d11' || gap === 'd2d' ? gap : 'auto';
        var tmmIn = o.textMeasurementMode;
        var textMeas =
            tmmIn === 'wcswidth' || tmmIn === 'wincon' ? tmmIn : 'grapheme';
        return {
            fontSize: __wtClampFontSize(o.fontSize !== undefined ? o.fontSize : d.fontSize),
            scheme: typeof o.scheme === 'string' && THEME_PRESETS[o.scheme] ? o.scheme : d.scheme,
            defaultNewTabProfile: okProf ? o.defaultNewTabProfile : d.defaultNewTabProfile,
            startupModeIndex: o.startupModeIndex === 1 ? 1 : 0,
            bootOnStart: typeof o.bootOnStart === 'boolean' ? o.bootOnStart : d.bootOnStart,
            autoScroll: typeof o.autoScroll === 'boolean' ? o.autoScroll : d.autoScroll,
            copyFormat: copyFormat,
            copyAsHtml: copyFormat === 'html',
            autoCopySelection: typeof o.autoCopySelection === 'boolean' ? o.autoCopySelection : d.autoCopySelection,
            rectCopyTrimTrailing: typeof o.rectCopyTrimTrailing === 'boolean' ? o.rectCopyTrimTrailing : d.rectCopyTrimTrailing,
            pasteTrimTrailing: typeof o.pasteTrimTrailing === 'boolean' ? o.pasteTrimTrailing : d.pasteTrimTrailing,
            wordSeparators: wsep,
            snapWindowToCharGrid: typeof o.snapWindowToCharGrid === 'boolean' ? o.snapWindowToCharGrid : d.snapWindowToCharGrid,
            tabSwitchStyle: tabStyle,
            focusPaneOnHover: typeof o.focusPaneOnHover === 'boolean' ? o.focusPaneOnHover : d.focusPaneOnHover,
            ctrlScrollFontSize: typeof o.ctrlScrollFontSize === 'boolean' ? o.ctrlScrollFontSize : d.ctrlScrollFontSize,
            ctrlShiftScrollOpacity: typeof o.ctrlShiftScrollOpacity === 'boolean' ? o.ctrlShiftScrollOpacity : d.ctrlShiftScrollOpacity,
            detectUrls: typeof o.detectUrls === 'boolean' ? o.detectUrls : d.detectUrls,
            searchWebUrl: __wtClampStr(typeof o.searchWebUrl === 'string' ? o.searchWebUrl : d.searchWebUrl, 2000, d.searchWebUrl),
            experimentalSelectionColorKeys: typeof o.experimentalSelectionColorKeys === 'boolean' ?
                o.experimentalSelectionColorKeys : d.experimentalSelectionColorKeys,
            newTabPosition: newTabPos,
            alwaysShowTabs: typeof o.alwaysShowTabs === 'boolean' ? o.alwaysShowTabs : d.alwaysShowTabs,
            showTabsInFullscreen: typeof o.showTabsInFullscreen === 'boolean' ? o.showTabsInFullscreen : d.showTabsInFullscreen,
            tabRowAcrylic: typeof o.tabRowAcrylic === 'boolean' ? o.tabRowAcrylic : d.tabRowAcrylic,
            useActiveTitleForAppTitle: typeof o.useActiveTitleForAppTitle === 'boolean' ?
                o.useActiveTitleForAppTitle : d.useActiveTitleForAppTitle,
            alwaysOnTop: typeof o.alwaysOnTop === 'boolean' ? o.alwaysOnTop : d.alwaysOnTop,
            tabWidth: tw,
            paneAnimations: typeof o.paneAnimations === 'boolean' ? o.paneAnimations : d.paneAnimations,
            notifyAreaIcon: typeof o.notifyAreaIcon === 'boolean' ? o.notifyAreaIcon : d.notifyAreaIcon,
            notifyHideWhenMinimized: typeof o.notifyHideWhenMinimized === 'boolean' ?
                o.notifyHideWhenMinimized : d.notifyHideWhenMinimized,
            autoHideWindow: typeof o.autoHideWindow === 'boolean' ? o.autoHideWindow : d.autoHideWindow,
            graphicsApi: gfx,
            disablePartialSwapChain: typeof o.disablePartialSwapChain === 'boolean' ?
                o.disablePartialSwapChain : d.disablePartialSwapChain,
            softwareRenderingWarp: typeof o.softwareRenderingWarp === 'boolean' ?
                o.softwareRenderingWarp : d.softwareRenderingWarp,
            allowBackgroundRun: typeof o.allowBackgroundRun === 'boolean' ?
                o.allowBackgroundRun : d.allowBackgroundRun,
            textMeasurementMode: textMeas,
            newTabMenuItems: __wtNormalizeNewTabMenuItems(o.newTabMenuItems),
            extensionGenerators: __wtNormalizeExtensionGenerators(o.extensionGenerators),
            defaultStartingDirectoryMode: o.defaultStartingDirectoryMode === 'custom' ? 'custom' : 'inherit',
            defaultStartingDirectory: __wtClampStr(
                typeof o.defaultStartingDirectory === 'string' ? o.defaultStartingDirectory : d.defaultStartingDirectory,
                500,
                d.defaultStartingDirectory
            ),
            defaultProfileIcon: __wtClampStr(
                typeof o.defaultProfileIcon === 'string' ? o.defaultProfileIcon : d.defaultProfileIcon,
                256,
                d.defaultProfileIcon
            ),
            defaultTabTitleMode: o.defaultTabTitleMode === 'profileName' ? 'profileName' : 'none',
            defaultElevate: typeof o.defaultElevate === 'boolean' ? o.defaultElevate : d.defaultElevate,
            fontFamily: __wtClampStr(
                typeof o.fontFamily === 'string' && o.fontFamily.trim() ? o.fontFamily.trim() : d.fontFamily,
                120,
                d.fontFamily
            ),
            terminalLineHeight: (function() {
                var lh = parseFloat(o.terminalLineHeight);
                if (isNaN(lh)) {
                    return d.terminalLineHeight;
                }
                return Math.min(3, Math.max(1, lh));
            })(),
            terminalLetterSpacing: (function() {
                var ls = parseFloat(o.terminalLetterSpacing);
                if (isNaN(ls)) {
                    return d.terminalLetterSpacing;
                }
                return Math.min(8, Math.max(-2, ls));
            })(),
            fontWeight: (function() {
                var fw = o.fontWeight;
                if (fw === 'bold' || fw === 'normal') {
                    return fw;
                }
                if (fw === '100' || fw === '400' || fw === '600' || fw === '700') {
                    return fw;
                }
                return d.fontWeight;
            })(),
            cursorStyle: o.cursorStyle === 'block' || o.cursorStyle === 'underline' ? o.cursorStyle : 'bar',
            cursorColorOverride: (function() {
                var c = typeof o.cursorColorOverride === 'string' ? o.cursorColorOverride.trim() : '';
                if (c === '') {
                    return '';
                }
                return /^#[0-9A-Fa-f]{6}$/.test(c) ? c : '';
            })(),
            colorEmoji: typeof o.colorEmoji === 'boolean' ? o.colorEmoji : d.colorEmoji,
            retroTerminalEffect: typeof o.retroTerminalEffect === 'boolean' ? o.retroTerminalEffect : d.retroTerminalEffect,
            adjustIndistinguishableColors: o.adjustIndistinguishableColors === 'indexed' || o.adjustIndistinguishableColors === 'always' ?
                o.adjustIndistinguishableColors : 'never',
            backgroundImagePath: __wtClampStr(
                typeof o.backgroundImagePath === 'string' ? o.backgroundImagePath : d.backgroundImagePath,
                2000,
                d.backgroundImagePath
            ),
            backgroundImageStretch: o.backgroundImageStretch === 'fill' || o.backgroundImageStretch === 'none' ||
                o.backgroundImageStretch === 'uniform' || o.backgroundImageStretch === 'uniformToFill' ?
                o.backgroundImageStretch : d.backgroundImageStretch,
            backgroundImageAlignment: (function() {
                var a = o.backgroundImageAlignment;
                var ok = [
                    'center', 'top', 'bottom', 'left', 'right',
                    'topLeft', 'topRight', 'bottomLeft', 'bottomRight'
                ];
                for (var ai = 0; ai < ok.length; ai++) {
                    if (a === ok[ai]) {
                        return a;
                    }
                }
                return d.backgroundImageAlignment;
            })(),
            backgroundImageOpacity: (function() {
                var op = parseInt(o.backgroundImageOpacity, 10);
                if (isNaN(op)) {
                    return d.backgroundImageOpacity;
                }
                return Math.min(100, Math.max(0, op));
            })(),
            intenseTextStyle: o.intenseTextStyle === 'bold' || o.intenseTextStyle === 'all' || o.intenseTextStyle === 'none' ?
                o.intenseTextStyle : 'bright',
            terminalBgOpacity: (function() {
                var op2 = parseInt(o.terminalBgOpacity, 10);
                if (isNaN(op2)) {
                    return d.terminalBgOpacity;
                }
                return Math.min(100, Math.max(10, op2));
            })(),
            useAcrylic: typeof o.useAcrylic === 'boolean' ? o.useAcrylic : d.useAcrylic,
            terminalPadding: __wtClampStr(
                typeof o.terminalPadding === 'string' ? o.terminalPadding : d.terminalPadding,
                64,
                d.terminalPadding
            ),
            terminalScrollbarMode: o.terminalScrollbarMode === 'hidden' ? 'hidden' : 'visible',
            terminalCustomGlyphs: typeof o.terminalCustomGlyphs === 'boolean' ?
                o.terminalCustomGlyphs : d.terminalCustomGlyphs
        };
    }

    function __wtUnicodeVersionFromTextMode(mode) {
        return mode === 'wcswidth' || mode === 'wincon' ? '6' : '11';
    }

    function __wtClearAppCacheStores() {
        try {
            if (window.TerminalProxy && typeof window.TerminalProxy.clearWebCache === 'function') {
                window.TerminalProxy.clearWebCache();
            }
        } catch (e0) {}
        try {
            var toRemove = [];
            var i;
            for (i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('kh_terminal_') === 0 && k !== 'kh_terminal_prefs') {
                    toRemove.push(k);
                }
            }
            for (i = 0; i < toRemove.length; i++) {
                localStorage.removeItem(toRemove[i]);
            }
        } catch (e1) {}
    }

    function __wtResetPrefsToFactory() {
        var fresh = __wtNormalizePrefs(null);
        Object.keys(fresh).forEach(function(k) {
            window.__wtPrefs[k] = fresh[k];
        });
        __wtSavePrefs();
        applyPrefsToRuntime();
    }

    function __wtActionReferenceRows() {
        var tabIndexKeys = [];
        for (var ti = 0; ti <= 8; ti++) {
            tabIndexKeys.push({
                label: '新建标签页，profile index: ' + ti,
                keys: ['ctrl+shift+' + String(ti + 1)]
            });
        }
        var switchTabKeys = [];
        for (var si = 0; si <= 7; si++) {
            switchTabKeys.push({
                label: '切换到选项卡，index: ' + si,
                keys: ['ctrl+alt+' + String(si + 1)]
            });
        }
        return [{
                label: '新建标签页',
                keys: ['ctrl+shift+t']
            }]
            .concat(tabIndexKeys)
            .concat([{
                    label: '新建窗口',
                    keys: ['ctrl+shift+n']
                },
                {
                    label: '显示/隐藏 Quake 窗口',
                    keys: ['win+sc(41)']
                },
                {
                    label: '显示上下文菜单',
                    keys: ['menu']
                },
                {
                    label: '上一个选项卡',
                    keys: ['ctrl+shift+tab']
                },
                {
                    label: '下一个选项卡',
                    keys: ['ctrl+tab']
                },
                {
                    label: '切换到最后一个选项卡',
                    keys: ['ctrl+alt+9']
                }
            ])
            .concat(switchTabKeys)
            .concat([{
                    label: '关闭窗口',
                    keys: ['alt+f4']
                },
                {
                    label: '关闭窗格',
                    keys: ['ctrl+shift+w']
                },
                {
                    label: '查找',
                    keys: ['ctrl+shift+f']
                },
                {
                    label: '清除缓冲区',
                    keys: ['ctrl+shift+k']
                },
                {
                    label: '滚动至历史记录底部',
                    keys: ['ctrl+shift+end']
                },
                {
                    label: '滚动至历史记录顶部',
                    keys: ['ctrl+shift+home']
                },
                {
                    label: '向上滚动',
                    keys: ['ctrl+shift+up']
                },
                {
                    label: '向上滚动一页',
                    keys: ['ctrl+shift+pgup']
                },
                {
                    label: '向下滚动',
                    keys: ['ctrl+shift+down']
                },
                {
                    label: '向下滚动一页',
                    keys: ['ctrl+shift+pgdn']
                },
                {
                    label: '减小字号',
                    keys: ['ctrl+numpad_minus', 'ctrl+minus']
                },
                {
                    label: '增大字号',
                    keys: ['ctrl+plus', 'ctrl+numpad_plus']
                },
                {
                    label: '重置字号',
                    keys: ['ctrl+numpad0', 'ctrl+0']
                },
                {
                    label: '切换全屏',
                    keys: ['alt+enter', 'f11']
                },
                {
                    label: '复制文本',
                    keys: ['ctrl+shift+c', 'ctrl+c', 'enter', 'ctrl+insert']
                },
                {
                    label: '粘贴',
                    keys: ['ctrl+shift+v', 'ctrl+v', 'shift+insert']
                },
                {
                    label: '选择所有文本',
                    keys: ['ctrl+shift+a']
                },
                {
                    label: '复制标签页',
                    keys: ['ctrl+shift+d']
                },
                {
                    label: '复制窗格',
                    keys: ['alt+shift+d']
                },
                {
                    label: '复制窗格，split: down',
                    keys: ['alt+shift+minus']
                },
                {
                    label: '复制窗格，split: right',
                    keys: ['alt+shift+plus']
                },
                {
                    label: '调整窗格大小 上',
                    keys: ['alt+shift+up']
                },
                {
                    label: '调整窗格大小 下',
                    keys: ['alt+shift+down']
                },
                {
                    label: '调整窗格大小 右',
                    keys: ['alt+shift+right']
                },
                {
                    label: '调整窗格大小 左',
                    keys: ['alt+shift+left']
                },
                {
                    label: '向上移动焦点',
                    keys: ['alt+up']
                },
                {
                    label: '向下移动焦点',
                    keys: ['alt+down']
                },
                {
                    label: '向左移动焦点',
                    keys: ['alt+left']
                },
                {
                    label: '向右移动焦点',
                    keys: ['alt+right']
                },
                {
                    label: '将焦点移动到上次使用的窗格',
                    keys: ['ctrl+alt+left']
                },
                {
                    label: '切换命令面板',
                    keys: ['ctrl+shift+p']
                },
                {
                    label: '切换标记模式',
                    keys: ['ctrl+shift+m']
                },
                {
                    label: '打开建议，source: all',
                    keys: ['ctrl+shift+period']
                },
                {
                    label: '打开新建选项卡的下拉列表',
                    keys: ['ctrl+shift+space']
                },
                {
                    label: '打开系统菜单',
                    keys: ['alt+space']
                },
                {
                    label: '打开设置',
                    keys: ['ctrl+comma']
                },
                {
                    label: '打开设置文件 (JSON)',
                    keys: ['ctrl+shift+comma']
                },
                {
                    label: '打开默认设置文件 (JSON)',
                    keys: ['ctrl+alt+comma']
                },
                {
                    label: '（本应用）顶部菜单配置文件快捷键',
                    keys: ['ctrl+shift+0', 'ctrl+shift+1', 'ctrl+shift+2', 'ctrl+shift+3']
                },
                {
                    label: '（本应用）Ctrl + 滚轮调节字号',
                    keys: ['ctrl+滚轮']
                }
            ]);
    }

    function __wtFillActionReferenceList(container) {
        if (!container) {
            return;
        }
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }
        var rows = __wtActionReferenceRows();
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var row = document.createElement('div');
            row.className = 'wt-action-row';
            row.setAttribute('role', 'listitem');
            var lab = document.createElement('div');
            lab.className = 'wt-action-label';
            lab.textContent = r.label;
            row.appendChild(lab);
            var keysWrap = document.createElement('div');
            keysWrap.className = 'wt-action-keys';
            for (var j = 0; j < r.keys.length; j++) {
                var pill = document.createElement('span');
                pill.className = 'wt-key-pill';
                pill.textContent = r.keys[j];
                keysWrap.appendChild(pill);
            }
            row.appendChild(keysWrap);
            container.appendChild(row);
        }
    }

    function __wtRenderNewTabMenuList(root) {
        var body = root.querySelector('.wt-ntm-list-body');
        if (!body) {
            return;
        }
        var items = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
        window.__wtPrefs.newTabMenuItems = items;
        while (body.firstChild) {
            body.removeChild(body.firstChild);
        }
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var row = document.createElement('div');
            row.className = 'wt-ntm-row';
            row.setAttribute('data-wt-ntm-idx', String(i));
            var cbWrap = document.createElement('div');
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.disabled = true;
            cb.setAttribute('aria-label', '选择');
            cbWrap.appendChild(cb);
            var lab = document.createElement('div');
            lab.textContent = __wtNtmItemLabel(item);
            var tools = document.createElement('div');
            tools.className = 'wt-ntm-row-tools';
            var isRem = item.kind === 'remaining';
            var upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'wt-ntm-icon-btn wt-ntm-up';
            upBtn.innerHTML = '&#8593;';
            upBtn.title = '上移';
            upBtn.disabled = i === 0;
            var dnBtn = document.createElement('button');
            dnBtn.type = 'button';
            dnBtn.className = 'wt-ntm-icon-btn wt-ntm-down';
            dnBtn.innerHTML = '&#8595;';
            dnBtn.title = '下移';
            dnBtn.disabled = i === items.length - 1;
            var delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'wt-ntm-icon-btn wt-ntm-del';
            delBtn.textContent = '\u00D7';
            delBtn.title = '删除';
            delBtn.disabled = isRem;
            tools.appendChild(upBtn);
            tools.appendChild(dnBtn);
            tools.appendChild(delBtn);
            row.appendChild(cbWrap);
            row.appendChild(lab);
            row.appendChild(tools);
            body.appendChild(row);
        }
        var remBtn = root.querySelector('.wt-ntm-add-remaining-btn');
        if (remBtn) {
            var hasRem = false;
            for (var j = 0; j < items.length; j++) {
                if (items[j].kind === 'remaining') {
                    hasRem = true;
                    break;
                }
            }
            remBtn.disabled = hasRem;
        }
    }

    function __wtAssignPrefsFromObject(src) {
        var n = __wtNormalizePrefs(src);
        Object.keys(n).forEach(function(k) {
            window.__wtPrefs[k] = n[k];
        });
    }

    window.__wtPrefs = __wtNormalizePrefs(null);

    function applyChromeTypography() {
        var fs = __wtClampFontSize(window.__wtPrefs.fontSize);
        window.__wtPrefs.fontSize = fs;
        document.documentElement.style.setProperty('--wt-ui-font-base', fs + 'px');
    }

    function applyAppChromeScheme() {
        var sch = __wtIsLightUiScheme(window.__wtPrefs.scheme) ? 'lightcream' : 'dark';
        document.documentElement.setAttribute('data-wt-app-scheme', sch);
    }

    function applyAppearancePrefsToChrome() {
        var root = document.getElementById('wt-root');
        var strip = document.getElementById('wt-tabs-strip');
        var bar = document.getElementById('wt-tabbar');
        if (!root || !strip) {
            return;
        }
        root.classList.toggle('wt-root--hide-tabs-strip', window.__wtPrefs.alwaysShowTabs === false);
        root.classList.toggle('wt-root--no-pane-anim', window.__wtPrefs.paneAnimations === false);
        strip.classList.toggle('wt-tabs-strip--compact', window.__wtPrefs.tabWidth === 'compact');
        if (bar) {
            bar.classList.toggle('wt-tabbar--acrylic', !!window.__wtPrefs.tabRowAcrylic);
        }
    }

    function __wtLoadPrefs() {
        var raw = '';
        if (typeof window.__wtInjectedPrefsJson === 'string' && window.__wtInjectedPrefsJson.length > 0) {
            raw = window.__wtInjectedPrefsJson;
            try {
                delete window.__wtInjectedPrefsJson;
            } catch (ie) {
                window.__wtInjectedPrefsJson = '';
            }
        }
        if (!raw) {
            try {
                if (window.TerminalProxy && typeof window.TerminalProxy.loadWebPrefs === 'function') {
                    raw = String(window.TerminalProxy.loadWebPrefs() || '');
                }
            } catch (e) {}
        }
        if (!raw) {
            try {
                raw = localStorage.getItem('kh_terminal_prefs') || '';
            } catch (e2) {}
        }
        if (!raw) {
            return;
        }
        try {
            __wtAssignPrefsFromObject(JSON.parse(raw));
        } catch (e3) {}
    }

    function __wtSavePrefs() {
        var json = JSON.stringify(window.__wtPrefs);
        try {
            localStorage.setItem('kh_terminal_prefs', json);
        } catch (e) {}
        try {
            if (window.TerminalProxy && typeof window.TerminalProxy.saveWebPrefs === 'function') {
                window.TerminalProxy.saveWebPrefs(json);
            }
        } catch (e2) {}
    }

    __wtLoadPrefs();
    applyChromeTypography();
    applyAppChromeScheme();
    applyAppearancePrefsToChrome();

    // --- xterm options builder + push prefs to all shell tabs ---

    function buildTerminalOptions() {
        var p = window.__wtPrefs;
        var theme = __wtThemeForTerminal();
        var opts = {};
        for (var k in WT_TERM_BASE) {
            if (Object.prototype.hasOwnProperty.call(WT_TERM_BASE, k)) {
                opts[k] = WT_TERM_BASE[k];
            }
        }
        opts.scrollOnUserInput = window.__wtPrefs.autoScroll !== false;
        opts.fontSize = __wtClampFontSize(p.fontSize);
        opts.fontFamily = __wtComposeFontFamily(p.fontFamily);
        opts.lineHeight = typeof p.terminalLineHeight === 'number' ? p.terminalLineHeight : 1.2;
        opts.letterSpacing = typeof p.terminalLetterSpacing === 'number' ? p.terminalLetterSpacing : 0.3;
        opts.fontWeight = typeof p.fontWeight === 'string' ? p.fontWeight : 'normal';
        var cs0 = p.cursorStyle;
        opts.cursorStyle = cs0 === 'block' || cs0 === 'underline' ? cs0 : 'bar';
        opts.wordSeparator = p.wordSeparators || WT_INTERACTION_DEFAULTS.wordSeparators;
        opts.theme = {};
        for (var t in theme) {
            if (Object.prototype.hasOwnProperty.call(theme, t)) {
                opts.theme[t] = theme[t];
            }
        }
        opts.unicodeVersion = __wtUnicodeVersionFromTextMode(p.textMeasurementMode);
        return opts;
    }

    function applyTerminalPrefsToAllShellTabs() {
        applyAppChromeScheme();
        var p = window.__wtPrefs;
        var theme = __wtThemeForTerminal();
        var scrollOn = window.__wtPrefs.autoScroll !== false;
        var fs = __wtClampFontSize(p.fontSize);
        var fam = __wtComposeFontFamily(p.fontFamily);
        var lh = typeof p.terminalLineHeight === 'number' ? p.terminalLineHeight : 1.2;
        var ls = typeof p.terminalLetterSpacing === 'number' ? p.terminalLetterSpacing : 0.3;
        var fw = typeof p.fontWeight === 'string' ? p.fontWeight : 'normal';
        var csty = p.cursorStyle === 'block' || p.cursorStyle === 'underline' ? p.cursorStyle : 'bar';
        for (var i = 0; i < tabs.length; i++) {
            var tab = tabs[i];
            if (tab.kind !== 'shell' || !tab.term) {
                continue;
            }
            try {
                tab.term.options.scrollback = WT_SCROLLBACK_LINES;
                tab.term.options.fontSize = fs;
                tab.term.options.fontFamily = fam;
                tab.term.options.lineHeight = lh;
                tab.term.options.letterSpacing = ls;
                tab.term.options.fontWeight = fw;
                tab.term.options.cursorStyle = csty;
                tab.term.options.scrollOnUserInput = scrollOn;
                tab.term.options.wordSeparator = p.wordSeparators || WT_INTERACTION_DEFAULTS.wordSeparators;
                try {
                    tab.term.options.unicodeVersion = __wtUnicodeVersionFromTextMode(p.textMeasurementMode);
                } catch (uE) {}
                tab.term.options.theme = JSON.parse(JSON.stringify(theme));
                /* 字体/行高/字间距变化后必须先按新单元格 resize，再 refresh；否则会出现只画出提示符前几个字符等错位。 */
                layoutTermForTab(tab);
                if (typeof tab.term.refresh === 'function') {
                    tab.term.refresh(0, Math.max(0, tab.term.rows - 1));
                }
            } catch (e) {}
            __wtApplyPaneDecorations(tab);
            if (tab._scrollSync) {
                requestAnimationFrame(tab._scrollSync);
                requestAnimationFrame(function() {
                    try {
                        tab._scrollSync();
                    } catch (eR) {}
                });
            }
        }
        scheduleScrollToBottom();
    }

    // --- Tab strip + active session state ---

    var tabsStrip = document.getElementById('wt-tabs-strip');
    var termStack = document.getElementById('terminal-stack');
    var __nextTabKey = 0;
    var tabs = [];
    var activeTabKey = null;
    /** 新建标签页使用的 profile（与 Windows Terminal 行为类似：最近选择可作为默认链） */
    window.__newTabProfile = 'daemon';

    function applyShellScrollFromPrefs() {
        var on = window.__wtPrefs.autoScroll !== false;
        for (var si = 0; si < tabs.length; si++) {
            var st = tabs[si];
            if (st.kind === 'shell' && st.term) {
                try {
                    st.term.options.scrollOnUserInput = on;
                } catch (e) {}
            }
        }
    }

    function applyPrefsToRuntime() {
        applyChromeTypography();
        applyAppChromeScheme();
        applyAppearancePrefsToChrome();
        window.__newTabProfile = window.__wtPrefs.defaultNewTabProfile || 'daemon';
        applyShellScrollFromPrefs();
        applyTerminalPrefsToAllShellTabs();
    }

    function iconClassForProfile(profile) {
        if (profile === 'khsl') {
            return 'wt-tab-icon wt-tab-icon--khsl';
        }
        if (profile === 'daemon') {
            return 'wt-tab-icon wt-tab-icon--daemon';
        }
        return 'wt-tab-icon wt-tab-icon--pw';
    }

    function profileToTabTitle(profile) {
        if (profile === 'khsl') {
            return 'KHSL';
        }
        if (profile === 'daemon') {
            return '管理员：Powershell';
        }
        return 'PowerShell';
    }

    function applyKhslTabPresentation(tab) {
        if (!tab || !tab.tabEl || tab._presentationKhsl) {
            return;
        }
        tab._presentationKhsl = true;
        var el = tab.tabEl.querySelector('.wt-tab-title');
        if (el) {
            el.textContent = 'KHSL';
        }
        var icon = tab.tabEl.querySelector('.wt-tab-icon');
        if (icon) {
            icon.className = 'wt-tab-icon wt-tab-icon--khsl';
        }
    }

    /**
     * Root（daemon）会话内在子进程中进入 khsl 时，根据 OSC 窗口标题或提示行更新标签为 KHSL。
     */
    function tryPromoteDaemonTabToKhslIfOutput(tab, data) {
        if (!tab || tab.kind !== 'shell' || tab.profile !== 'daemon' || tab._presentationKhsl) {
            return;
        }
        var s = String(data);
        var re = /\x1b\](?:0|2);([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
        var m;
        while ((m = re.exec(s)) !== null) {
            if (/khsl/i.test(m[1])) {
                applyKhslTabPresentation(tab);
                return;
            }
        }
        var lines = s.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (/\bkhsl\b/i.test(ln) && /[#$>］\]]\s*$/.test(ln)) {
                applyKhslTabPresentation(tab);
                return;
            }
        }
    }

    function getActiveTab() {
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].key === activeTabKey) {
                return tabs[i];
            }
        }
        return null;
    }

    /** 与 + 按钮一致：Shell 标签沿用其 profile，设置页则用菜单/默认链上的 profile */
    function profileForNewTabFromActive() {
        var cur = getActiveTab();
        if (cur && cur.kind === 'shell' && cur.profile) {
            return cur.profile;
        }
        return window.__newTabProfile || window.__wtPrefs.defaultNewTabProfile || 'daemon';
    }

    /** xterm 内部列选（矩形选）时 SelectionService._activeSelectionMode === 3（与源码一致）。 */
    function __wtIsXtermColumnSelection(term) {
        try {
            var svc = term._core && term._core.selectionService;
            return !!(svc && svc._activeSelectionMode === 3);
        } catch (eC) {
            return false;
        }
    }

    function __wtTrimTrailingSpacesPerLine(text) {
        return String(text).split(/\r?\n/).map(function(line) {
            return line.replace(/\s+$/, '');
        }).join('\n');
    }

    function __wtEscapeHtmlForClipboard(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function __wtClipboardFragmentHtmlFromPlain(plain) {
        return '<!DOCTYPE html><html><body><!--StartFragment--><pre style="margin:0;white-space:pre-wrap;word-wrap:break-word;font-family:Consolas,\'Cascadia Mono\',\'Sarasa Mono SC\',monospace">' +
            __wtEscapeHtmlForClipboard(plain) + '</pre><!--EndFragment--></body></html>';
    }

    /**
     * 将文本写入系统剪贴板：尊重 copyFormat（plain/html）、rectCopyTrimTrailing（仅列选）。
     * 由「选中自动复制」调用； prefs 每次读取当前 __wtPrefs。
     */
    function __wtCopyTerminalSelectionToClipboard(tab, rawText) {
        var p = window.__wtPrefs;
        if (p.autoCopySelection === false) {
            return;
        }
        var plain = rawText == null ? '' : String(rawText);
        if (!plain.length) {
            return;
        }
        if (p.rectCopyTrimTrailing && tab && tab.term && __wtIsXtermColumnSelection(tab.term)) {
            plain = __wtTrimTrailingSpacesPerLine(plain);
        }
        var asHtml = (p.copyFormat === 'html' || p.copyAsHtml === true);

        function fallbackExecCopy(t) {
            try {
                var ta = document.createElement('textarea');
                ta.setAttribute('readonly', 'readonly');
                ta.value = t;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                ta.style.top = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (eF) {}
        }

        if (asHtml && typeof ClipboardItem !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
            try {
                var html = __wtClipboardFragmentHtmlFromPlain(plain);
                var item = new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([plain], { type: 'text/plain;charset=utf-8' })
                });
                navigator.clipboard.write([item]);
                return;
            } catch (eH) {
                /* 部分 WebView 不支持多 MIME，回落纯文本 */
            }
        }
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(plain).catch(function() {
                fallbackExecCopy(plain);
            });
            return;
        }
        fallbackExecCopy(plain);
    }

    function __wtWireAutoCopySelection(tab) {
        if (!tab || !tab.term || typeof tab.term.onSelectionChange !== 'function') {
            return;
        }
        tab._wtSelCopyTimer = null;
        tab.term.onSelectionChange(function() {
            if (window.__wtPrefs.autoCopySelection === false) {
                return;
            }
            if (tab._wtSelCopyTimer !== null) {
                clearTimeout(tab._wtSelCopyTimer);
            }
            tab._wtSelCopyTimer = setTimeout(function() {
                tab._wtSelCopyTimer = null;
                try {
                    if (!tab || !tab.term) {
                        return;
                    }
                    if (typeof tab.term.hasSelection === 'function' && !tab.term.hasSelection()) {
                        return;
                    }
                    var sel = tab.term.getSelection();
                    if (!sel || !sel.length) {
                        return;
                    }
                    __wtCopyTerminalSelectionToClipboard(tab, sel);
                } catch (eR) {}
            }, 100);
        });
    }

    /**
     * Ctrl+C、右键「复制」等浏览器 copy 事件：对所有 Shell profile 统一套上
     * 「HTML 格式」「列选时去行尾空格」；不依赖「自动复制」开关。
     */
    function __wtWireTerminalCopyEvent(tab) {
        if (!tab || !tab.term || !tab.term.element) {
            return;
        }
        try {
            if (tab.term.element._wtTerminalCopyHook) {
                return;
            }
            tab.term.element._wtTerminalCopyHook = true;
            tab.term.element.addEventListener('copy', function(ev) {
                try {
                    if (!tab.term || typeof tab.term.hasSelection !== 'function' || !tab.term.hasSelection()) {
                        return;
                    }
                    var raw = tab.term.getSelection();
                    if (!raw || !raw.length) {
                        return;
                    }
                    if (!ev.clipboardData) {
                        return;
                    }
                    var wantHtml = (window.__wtPrefs.copyFormat === 'html' || window.__wtPrefs.copyAsHtml === true);
                    var col = __wtIsXtermColumnSelection(tab.term);
                    var needTrim = !!(window.__wtPrefs.rectCopyTrimTrailing && col);
                    if (!wantHtml && !needTrim) {
                        return;
                    }
                    var plain = needTrim ? __wtTrimTrailingSpacesPerLine(raw) : raw;
                    ev.clipboardData.setData('text/plain', plain);
                    if (wantHtml) {
                        try {
                            ev.clipboardData.setData('text/html', __wtClipboardFragmentHtmlFromPlain(plain));
                        } catch (eH) {}
                    }
                    ev.preventDefault();
                    ev.stopPropagation();
                } catch (eC) {}
            }, true);
        } catch (eW) {}
    }

    // 监听全局的键盘事件以支持 Ctrl+C 和 Ctrl+V
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
            if (e.key === 'c' || e.key === 'C') {
                var actTab = getActiveTab();
                if (actTab && actTab.term && typeof actTab.term.hasSelection === 'function' && actTab.term.hasSelection()) {
                    e.preventDefault();
                    var sel = actTab.term.getSelection();
                    if (sel && sel.length) {
                        __wtCopyTerminalSelectionToClipboard(actTab, sel);
                        actTab.term.clearSelection();
                    }
                }
            } else if (e.key === 'v' || e.key === 'V') {
                var actTab2 = getActiveTab();
                if (actTab2 && actTab2.term) {
                    e.preventDefault();
                    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                        navigator.clipboard.readText().then(function(text) {
                            if (text && window.TerminalProxy && window.TerminalProxy.writeToPty) {
                                window.TerminalProxy.writeToPty(text, actTab2.sessionId);
                            }
                        }).catch(function() {});
                    }
                }
            }
        }
    }, true);

    // 监听鼠标和触摸事件，控制系统输入法键盘的唤起
    document.addEventListener('pointerdown', function(e) {
        var actTab = getActiveTab();
        if (actTab && actTab.term && actTab.term.textarea) {
            if (e.pointerType === 'mouse') {
                actTab.term.textarea.inputMode = 'none';
            } else if (e.pointerType === 'touch' || e.pointerType === 'pen') {
                actTab.term.textarea.inputMode = 'text';
            }
        }
    }, true);

    var __scrollBottomScheduled = false;

    function scheduleScrollToBottom() {
        if (__scrollBottomScheduled) {
            return;
        }
        __scrollBottomScheduled = true;
        requestAnimationFrame(function() {
            __scrollBottomScheduled = false;
            var t = getActiveTab();
            if (!t || !t.term) {
                return;
            }
            try {
                if (typeof t.term.scrollToBottom === 'function') {
                    t.term.scrollToBottom();
                } else if (t.term.buffer && t.term.buffer.active && t.term.buffer.active.viewportY !== undefined) {
                    t.term.scrollLines(t.term.buffer.active.baseY + t.term.buffer.active.cursorY);
                }
            } catch (e) {}
            if (t._scrollSync) {
                try {
                    t._scrollSync();
                } catch (e2) {}
            }
        });
    }

    /** 通知 xterm 根据当前 buffer 与 cell 尺寸重算可滚动区域（IME/软键盘开合后常需补这一步，否则 scrollHeight 偏小、拖不到最底行）。 */
    function __wtSyncXtermViewportScrollGeometry(term) {
        if (!term) {
            return;
        }
        try {
            var vpSvc = term._core && term._core.viewport;
            if (vpSvc && typeof vpSvc.syncScrollArea === 'function') {
                vpSvc.syncScrollArea();
            }
        } catch (eV) {}
        try {
            if (typeof term.refresh === 'function') {
                term.refresh(0, Math.max(0, term.rows - 1));
            }
        } catch (eR) {}
    }

    /** 仅当视口已在底部附近时才自动跟到底，避免翻历史时被输出或 resize 强行拉回 */
    function termViewportNearBottom(tab, thresholdPx) {
        var th = typeof thresholdPx === 'number' ? thresholdPx : 48;
        if (!tab) {
            return true;
        }

        // 优先使用 xterm 内部 buffer 状态判断，避免 DOM 更新延迟导致的误判
        try {
            if (tab.term && tab.term.buffer && tab.term.buffer.active) {
                var b = tab.term.buffer.active;
                if (typeof b.viewportY === 'number' && typeof b.baseY === 'number') {
                    // 估算行高，通常一行在 14~20px 之间，这里保守取 14
                    var lineTh = Math.max(1, Math.ceil(th / 14));
                    return (b.baseY - b.viewportY) <= lineTh;
                }
            }
        } catch (e) {}

        if (!tab.paneEl) {
            return true;
        }
        var vp = tab.paneEl.querySelector('.xterm-viewport');
        if (!vp) {
            return true;
        }
        var maxS = Math.max(0, vp.scrollHeight - vp.clientHeight);
        return maxS - vp.scrollTop <= th;
    }

    function termWriteChunk(tab, data) {
        var scrollOn = tab.term.options.scrollOnUserInput !== false;
        if (scrollOn && termViewportNearBottom(tab, 64)) {
            tab._wtFollowOutput = true;
        }

        tab._writePendingCount = (tab._writePendingCount || 0) + 1;
        var follow = scrollOn && tab._wtFollowOutput === true;

        tab.term.write(data, function() {
            tab._writePendingCount = Math.max(0, tab._writePendingCount - 1);
            if (tab.key === activeTabKey) {
                if (follow) {
                    scheduleScrollToBottom();
                } else if (tab._scrollSync) {
                    requestAnimationFrame(tab._scrollSync);
                }
            } else {
                if (tab._scrollSync) {
                    requestAnimationFrame(tab._scrollSync);
                }
            }
        });

        tryPromoteDaemonTabToKhslIfOutput(tab, data);
    }

    function layoutTermForTab(t) {
        if (!t || !t.term || !t.paneEl) {
            return;
        }
        var anchor = t.paneEl.querySelector('.wt-xterm-anchor');
        var w = anchor ? anchor.clientWidth : t.paneEl.clientWidth;
        var h = anchor ? anchor.clientHeight : t.paneEl.clientHeight;
        if (!(w > 0) || !(h > 0)) {
            return;
        }
        var md = __wtMeasureXtermCellPx(t.term);
        var cols = Math.max(2, Math.floor(w / md.width));
        var rows = Math.max(1, Math.floor(h / md.height));
        try {
            t.term.resize(cols, rows);
        } catch (eRz) {}
        /* 估算行高常小于 xterm 实际 _core.cell.height，若不再校正会得到过大的 rows，
         * 画布总高度超出视口，底部多行内容被 overflow 裁掉（大输出时像「吞掉最后几行」）。 */
        try {
            var cw0 = t.term._core && t.term._core.cell && t.term._core.cell.width;
            var rh0 = t.term._core && t.term._core.cell && t.term._core.cell.height;
            if (cw0 > 0 && rh0 > 0) {
                var cFix = Math.max(2, Math.floor(w / cw0));
                var rFix = Math.max(1, Math.floor(h / rh0));
                if (cFix !== cols || rFix !== rows) {
                    cols = cFix;
                    rows = rFix;
                    try {
                        t.term.resize(cols, rows);
                    } catch (eR2) {}
                }
            }
        } catch (eFix0) {}
        __wtSyncXtermViewportScrollGeometry(t.term);
        if (!t.localEcho && t.sessionId >= 0 && window.TerminalProxy && window.TerminalProxy.resizePty) {
            try {
                window.TerminalProxy.resizePty(cols, rows, t.sessionId);
            } catch (eP) {}
        }
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                if (!t.term || !t.paneEl) {
                    return;
                }
                var anchor2 = t.paneEl.querySelector('.wt-xterm-anchor');
                var w2 = anchor2 ? anchor2.clientWidth : t.paneEl.clientWidth;
                var h2 = anchor2 ? anchor2.clientHeight : t.paneEl.clientHeight;
                if (!(w2 > 0) || !(h2 > 0)) {
                    return;
                }
                try {
                    var cw = t.term._core && t.term._core.cell && t.term._core.cell.width;
                    var rh = t.term._core && t.term._core.cell && t.term._core.cell.height;
                    if (cw > 0 && rh > 0) {
                        var c2 = Math.max(2, Math.floor(w2 / cw));
                        var r2 = Math.max(1, Math.floor(h2 / rh));
                        if (c2 !== t.term.cols || r2 !== t.term.rows) {
                            t.term.resize(c2, r2);
                            if (!t.localEcho && t.sessionId >= 0 && window.TerminalProxy && window.TerminalProxy.resizePty) {
                                window.TerminalProxy.resizePty(c2, r2, t.sessionId);
                            }
                        }
                    }
                } catch (eRef) {}
                __wtSyncXtermViewportScrollGeometry(t.term);
                try {
                    var vpFix = t.paneEl.querySelector('.xterm-viewport');
                    if (vpFix) {
                        var mx = Math.max(0, vpFix.scrollHeight - vpFix.clientHeight);
                        if (vpFix.scrollTop > mx) {
                            vpFix.scrollTop = mx;
                        }
                    }
                } catch (eVp) {}
                if (t._scrollSync) {
                    try {
                        t._scrollSync();
                    } catch (eSy) {}
                }
            });
        });
    }

    function layoutTerm() {
        layoutTermForTab(getActiveTab());
    }

    var __wtGeomDebounceTimer = null;
    /** 软键盘关闭、可视视口变化等场景下布局往往晚一拍；防抖后只对当前 Shell 再 layout + 同步滚动度量。 */
    function __wtScheduleLayoutAfterViewportOrIme() {
        if (__wtGeomDebounceTimer !== null) {
            clearTimeout(__wtGeomDebounceTimer);
        }
        __wtGeomDebounceTimer = setTimeout(function() {
            __wtGeomDebounceTimer = null;
            var tab = getActiveTab();
            if (!tab || tab.kind !== 'shell' || !tab.term || !tab.paneEl) {
                return;
            }
            layoutTermForTab(tab);
        }, 120);
    }

    window.addEventListener('resize', function() {
        layoutTerm();
        __wtScheduleLayoutAfterViewportOrIme();
    });

    if (typeof ResizeObserver !== 'undefined' && termStack) {
        new ResizeObserver(function() {
            layoutTerm();
            __wtScheduleLayoutAfterViewportOrIme();
        }).observe(termStack);
    }

    (function __wtBindShellGeomHooks() {
        if (window.visualViewport) {
            try {
                window.visualViewport.addEventListener('resize', __wtScheduleLayoutAfterViewportOrIme, {
                    passive: true
                });
                window.visualViewport.addEventListener('scroll', __wtScheduleLayoutAfterViewportOrIme, {
                    passive: true
                });
            } catch (eVv) {}
        }
        var wr = document.getElementById('wt-root');
        if (typeof ResizeObserver !== 'undefined' && wr) {
            try {
                new ResizeObserver(function() {
                    __wtScheduleLayoutAfterViewportOrIme();
                }).observe(wr);
            } catch (eRo) {}
        }
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) {
                __wtScheduleLayoutAfterViewportOrIme();
            }
        });
    })();

    function switchTab(key) {
        for (var i = 0; i < tabs.length; i++) {
            var row = tabs[i];
            var on = row.key === key;
            row.tabEl.classList.toggle('wt-tab-active', on);
            row.paneEl.classList.toggle('wt-pane-visible', on);
        }
        activeTabKey = key;
        var a = getActiveTab();
        if (a) {
            setTimeout(function() {
                if (a.kind === 'shell' && a.term) {
                    layoutTerm();
                    if (a._scrollSync) {
                        requestAnimationFrame(a._scrollSync);
                    }
                    try {
                        a.term.focus();
                    } catch (e) {}
                    scheduleScrollToBottom();
                }
            }, 0);
        }
    }

    function removeTab(key) {
        if (tabs.length <= 1) {
            return;
        }
        var idx = -1;
        var victim = null;
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].key === key) {
                idx = i;
                victim = tabs[i];
                break;
            }
        }
        if (!victim) {
            return;
        }
        if (victim.kind === 'settings') {
            victim.tabEl.remove();
            victim.paneEl.remove();
            tabs.splice(idx, 1);
            if (activeTabKey === key) {
                var fall = tabs[Math.max(0, idx - 1)];
                switchTab(fall.key);
            }
            return;
        }
        if (victim.sessionId >= 0 && window.TerminalProxy && window.TerminalProxy.stopSession) {
            window.TerminalProxy.stopSession(victim.sessionId);
        }
        try {
            victim.term.dispose();
        } catch (e) {}
        victim.tabEl.remove();
        victim.paneEl.remove();
        tabs.splice(idx, 1);
        if (activeTabKey === key) {
            var fall = tabs[Math.max(0, idx - 1)];
            switchTab(fall.key);
        }
    }

    function wireCustomScrollbar(tab) {
        var pane = tab.paneEl;
        var thumb = pane.querySelector('.wt-term-scroll-thumb');
        var track = pane.querySelector('.wt-term-scroll-track');
        var anchor = pane.querySelector('.wt-xterm-anchor');
        var inner = pane.querySelector('.wt-term-pane-inner');
        if (!thumb || !track || !tab.term) {
            return;
        }

        var vpCached = null;

        function getViewport() {
            if (!vpCached || !pane.contains(vpCached)) {
                vpCached = pane.querySelector('.xterm-viewport');
            }
            return vpCached;
        }

        function syncThumb() {
            var vp = getViewport();
            if (!vp || !thumb || !track) {
                return;
            }
            var MIN_THUMB_PX = 28;
            var MIN_TRACK_DRAG_RANGE = 72;
            var sh = vp.scrollHeight;
            var ch = vp.clientHeight;
            var maxScroll = Math.max(0, sh - ch);
            var trInner = track.clientHeight;
            if (maxScroll <= 0 || trInner <= 0) {
                thumb.classList.add('wt-thumb-idle');
                thumb.style.height = Math.min(48, Math.max(MIN_THUMB_PX, Math.floor(trInner * 0.35))) + 'px';
                thumb.style.top = '0px';
                return;
            }
            thumb.classList.remove('wt-thumb-idle');
            var thumbH = Math.round((ch / sh) * trInner);
            thumbH = Math.max(MIN_THUMB_PX, thumbH);
            var maxThumb = Math.max(MIN_THUMB_PX, trInner - MIN_TRACK_DRAG_RANGE - 2);
            thumbH = Math.min(thumbH, maxThumb);
            var range = Math.max(1, trInner - thumbH);
            var top = (vp.scrollTop / maxScroll) * range;
            thumb.style.height = thumbH + 'px';
            thumb.style.top = top + 'px';
        }

        tab._scrollSync = syncThumb;

        function syncThumbAndOutputFollow() {
            syncThumb();
            try {
                if (!tab.term || tab.term.options.scrollOnUserInput === false) {
                    return;
                }
                var isWriting = tab._writePendingCount > 0;
                if (isWriting || (tab.key === activeTabKey && typeof __scrollBottomScheduled !== 'undefined' && __scrollBottomScheduled)) {
                    return; // 忽略 write 期间或等待 scrollToBottom 期间触发的 scroll 事件，避免误判
                }
                if (!termViewportNearBottom(tab, 64)) {
                    tab._wtFollowOutput = false;
                }
            } catch (eFo) {}
        }

        function bindViewport() {
            var vp = getViewport();
            if (!vp) {
                requestAnimationFrame(bindViewport);
                return;
            }
            vp.addEventListener('scroll', syncThumbAndOutputFollow, {
                passive: true
            });
            try {
                if (typeof tab.term.onScroll === 'function') {
                    tab.term.onScroll(function() {
                        syncThumbAndOutputFollow();
                    });
                }
            } catch (eOn) {}
            if (typeof ResizeObserver !== 'undefined') {
                var ro = new ResizeObserver(syncThumb);
                ro.observe(vp);
                ro.observe(track);
            }
            syncThumb();
            requestAnimationFrame(function() {
                syncThumb();
                requestAnimationFrame(syncThumb);
            });
        }
        bindViewport();

        var dragging = false;
        var dragPointerId = null;

        function clientYUnified(ev) {
            if (ev.touches && ev.touches.length) {
                return ev.touches[0].clientY;
            }
            if (typeof ev.clientY === 'number') {
                return ev.clientY;
            }
            return 0;
        }

        function onThumbStart(ev) {
            if (dragging) {
                return;
            }
            if (typeof ev.button === 'number' && ev.button !== 0) {
                return;
            }
            var vp = getViewport();
            if (!vp) {
                return;
            }
            var maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
            if (maxScroll <= 0) {
                requestAnimationFrame(syncThumb);
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            dragging = true;
            dragPointerId = typeof ev.pointerId === 'number' ? ev.pointerId : null;
            try {
                if (dragPointerId !== null && typeof thumb.setPointerCapture === 'function') {
                    thumb.setPointerCapture(dragPointerId);
                }
            } catch (capE) {}
            var sy = clientYUnified(ev);
            var sScroll = vp.scrollTop;
            var sth = thumb.offsetHeight;
            var trackRange = Math.max(1, track.clientHeight - sth);

            function onMove(e2) {
                if (!dragging) {
                    return;
                }
                e2.preventDefault();
                var vp2 = getViewport();
                if (!vp2) {
                    return;
                }
                var max2 = Math.max(0, vp2.scrollHeight - vp2.clientHeight);
                if (max2 <= 0) {
                    return;
                }
                var dy = clientYUnified(e2) - sy;
                var next = sScroll + (dy / trackRange) * max2;
                vp2.scrollTop = Math.max(0, Math.min(max2, next));
                syncThumb();
            }

            function onEnd() {
                dragging = false;
                try {
                    if (dragPointerId !== null && typeof thumb.releasePointerCapture === 'function') {
                        thumb.releasePointerCapture(dragPointerId);
                    }
                } catch (rE) {}
                dragPointerId = null;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onEnd);
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onEnd);
                document.removeEventListener('pointercancel', onEnd);
            }
            document.addEventListener('mousemove', onMove, {
                passive: false
            });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, {
                passive: false
            });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
            document.addEventListener('pointermove', onMove, {
                passive: false
            });
            document.addEventListener('pointerup', onEnd);
            document.addEventListener('pointercancel', onEnd);
        }

        if (typeof window.PointerEvent !== 'undefined') {
            thumb.addEventListener('pointerdown', onThumbStart);
        } else {
            thumb.addEventListener('mousedown', onThumbStart);
            thumb.addEventListener('touchstart', onThumbStart, {
                passive: false
            });
        }

        function jumpTrackToClientY(clientYVal) {
            var vp = getViewport();
            if (!vp || !thumb) {
                return;
            }
            var maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
            if (maxScroll <= 0) {
                return;
            }
            var rect = track.getBoundingClientRect();
            var y = clientYVal - rect.top;
            var thumbH = thumb.offsetHeight;
            var trh = track.clientHeight;
            var range = Math.max(1, trh - thumbH);
            var ratio = (y - thumbH / 2) / range;
            ratio = Math.max(0, Math.min(1, ratio));
            vp.scrollTop = ratio * maxScroll;
            syncThumb();
        }

        function onTrackClick(ev) {
            if (ev.target === thumb) {
                return;
            }
            jumpTrackToClientY(clientYUnified(ev));
        }
        track.addEventListener('click', onTrackClick);
        track.addEventListener('pointerdown', function(ev) {
            if (ev.target === thumb) {
                return;
            }
            if (ev.pointerType === 'touch' || ev.pointerType === 'pen') {
                jumpTrackToClientY(ev.clientY);
                ev.preventDefault();
            }
        });

        if (inner) {
            inner.addEventListener('wheel', function(ev) {
                if (window.__wtPrefs.ctrlScrollFontSize && ev.ctrlKey && !ev.shiftKey) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    var fs0 = __wtClampFontSize(window.__wtPrefs.fontSize);
                    if (ev.deltaY < 0) {
                        window.__wtPrefs.fontSize = Math.min(36, fs0 + 1);
                    } else {
                        window.__wtPrefs.fontSize = Math.max(8, fs0 - 1);
                    }
                    applyChromeTypography();
                    applyTerminalPrefsToAllShellTabs();
                    return;
                }
                var vp = getViewport();
                if (!vp) {
                    return;
                }
                if (ev.target.closest && ev.target.closest('.wt-term-scroll-rail')) {
                    return;
                }
                var dy = ev.deltaY;
                if (ev.deltaMode === 1) {
                    dy *= 16;
                } else if (ev.deltaMode === 2) {
                    dy *= Math.max(80, vp.clientHeight * 0.85);
                }
                if (!dy) {
                    return;
                }
                ev.preventDefault();
                vp.scrollTop += dy;
                syncThumb();
            }, {
                passive: false
            });
        }

        var panStart = null;
        if (anchor) {
            anchor.addEventListener('touchstart', function(ev) {
                if (!ev.touches || ev.touches.length !== 1) {
                    return;
                }
                var vp = getViewport();
                if (!vp) {
                    return;
                }
                panStart = {
                    y: ev.touches[0].clientY,
                    st: vp.scrollTop
                };
            }, {
                passive: true
            });
            anchor.addEventListener('touchmove', function(ev) {
                if (!panStart || !ev.touches || ev.touches.length !== 1) {
                    return;
                }
                var vp = getViewport();
                if (!vp) {
                    return;
                }
                var dy = ev.touches[0].clientY - panStart.y;
                var maxS = Math.max(0, vp.scrollHeight - vp.clientHeight);
                vp.scrollTop = Math.max(0, Math.min(maxS, panStart.st - dy));
                ev.preventDefault();
                syncThumb();
            }, {
                passive: false
            });
            anchor.addEventListener('touchend', function() {
                panStart = null;
            }, {
                passive: true
            });
            anchor.addEventListener('touchcancel', function() {
                panStart = null;
            }, {
                passive: true
            });
        }
    }

    function insertShellTabInStrip(tabEl, tabObj) {
        var pos = window.__wtPrefs.newTabPosition || 'last';
        if (pos === 'first') {
            var ref0 = tabsStrip.firstChild;
            if (ref0) {
                tabsStrip.insertBefore(tabEl, ref0);
            } else {
                tabsStrip.appendChild(tabEl);
            }
            tabs.unshift(tabObj);
            return;
        }
        if (pos === 'after_current') {
            var a = getActiveTab();
            var ai = -1;
            for (var i = 0; i < tabs.length; i++) {
                if (a && tabs[i].key === a.key) {
                    ai = i;
                    break;
                }
            }
            if (a && a.tabEl.nextSibling) {
                tabsStrip.insertBefore(tabEl, a.tabEl.nextSibling);
            } else {
                tabsStrip.appendChild(tabEl);
            }
            if (ai >= 0) {
                tabs.splice(ai + 1, 0, tabObj);
            } else {
                tabs.push(tabObj);
            }
            return;
        }
        tabsStrip.appendChild(tabEl);
        tabs.push(tabObj);
    }

    function bindTabRow(tab) {
        tab.tabEl.querySelector('.wt-tab-close').addEventListener('click', function(ev) {
            ev.stopPropagation();
            removeTab(tab.key);
        });
        tab.tabEl.addEventListener('click', function() {
            switchTab(tab.key);
        });
    }

    function createTab(profile) {
        var p = profile || 'daemon';
        var key = ++__nextTabKey;

        var tabEl = document.createElement('div');
        tabEl.className = 'wt-tab';
        tabEl.innerHTML =
            '<span class="' + iconClassForProfile(p) + '" aria-hidden="true"></span>' +
            '<span class="wt-tab-title">' + profileToTabTitle(p) + '</span>' +
            '<button type="button" class="wt-tab-close" title="关闭" aria-label="关闭标签">×</button>';

        var paneEl = document.createElement('div');
        paneEl.className = 'wt-term-pane';
        var inner = document.createElement('div');
        inner.className = 'wt-term-pane-inner';
        var anchor = document.createElement('div');
        anchor.className = 'wt-xterm-anchor';
        var rail = document.createElement('div');
        rail.className = 'wt-term-scroll-rail';
        rail.innerHTML = '<div class="wt-term-scroll-track"><div class="wt-term-scroll-thumb" role="slider" tabindex="-1" aria-label="终端滚动"></div></div>';
        inner.appendChild(anchor);
        inner.appendChild(rail);
        paneEl.appendChild(inner);
        termStack.appendChild(paneEl);

        var term = new Terminal(buildTerminalOptions());
        term.open(anchor);
        try {
            var taIme = term.textarea;
            if (taIme && !taIme._wtImeBlurHook) {
                taIme._wtImeBlurHook = true;
                taIme.addEventListener('blur', function() {
                    __wtScheduleLayoutAfterViewportOrIme();
                });
            }
        } catch (eIme) {}

        var tab = {
            key: key,
            kind: 'shell',
            profile: p,
            sessionId: -1,
            localEcho: false,
            term: term,
            paneEl: paneEl,
            tabEl: tabEl
        };

        wireCustomScrollbar(tab);

        __wtApplyPaneDecorations(tab);

        paneEl.addEventListener('mouseenter', function() {
            if (!window.__wtPrefs.focusPaneOnHover) {
                return;
            }
            if (tab.kind === 'shell' && tab.term) {
                try {
                    tab.term.focus();
                } catch (ef) {}
            }
        });

        term.onData(function(data) {
            if (tab.localEcho) {
                termWriteChunk(tab, data);
                return;
            }
            if (tab.sessionId >= 0 && window.TerminalProxy && window.TerminalProxy.writeToPty) {
                window.TerminalProxy.writeToPty(String(data), tab.sessionId);
            }
        });

        __wtWireAutoCopySelection(tab);
        __wtWireTerminalCopyEvent(tab);

        insertShellTabInStrip(tabEl, tab);
        bindTabRow(tab);
        switchTab(key);

        if (window.TerminalProxy && window.TerminalProxy.startSession) {
            tab.sessionId = window.TerminalProxy.startSession(p);
            tab.localEcho = tab.sessionId < 0;
            if (tab.localEcho) {
                var detail = '';
                try {
                    if (window.TerminalProxy.getLastPtyError) {
                        detail = window.TerminalProxy.getLastPtyError();
                    }
                } catch (e) {}
                term.writeln('');
                term.writeln('\x1b[33m[本地回显] 无法创建 PTY。\x1b[0m');
                if (detail) {
                    term.writeln('\x1b[90m详情: ' + String(detail) + '\x1b[0m');
                }
                term.writeln('\x1b[36m输入将仅本地显示。\x1b[0m');
                term.writeln('');
            }
        } else {
            tab.localEcho = true;
        }

        setTimeout(function() {
            layoutTerm();
            try {
                term.focus();
            } catch (e) {}
            scheduleScrollToBottom();
        }, 80);

        return tab;
    }

    // --- Embedded settings (clone of #wt-settings-template) ---

    function initSettingsPanelInRoot(root) {
        var navItems = root.querySelectorAll('.wt-set-nav-item[data-page]');
        var pages = root.querySelectorAll('.wt-set-page[data-page]');

        function showPage(id) {
            var navKey = id === 'profileDefaultsAppearance' ? 'profileDefaults' : id;
            for (var i = 0; i < navItems.length; i++) {
                var nid = navItems[i].getAttribute('data-page');
                var on = nid === navKey;
                navItems[i].classList.toggle('wt-set-nav-active', on);
            }
            for (var j = 0; j < pages.length; j++) {
                var pg = pages[j].getAttribute('data-page');
                pages[j].classList.toggle('wt-set-page-active', pg === id);
            }
        }

        for (var n = 0; n < navItems.length; n++) {
            (function(el) {
                var pid = el.getAttribute('data-page');
                el.addEventListener('click', function() {
                    showPage(pid);
                });
                el.addEventListener('keydown', function(ev) {
                    if (ev.key === 'Enter') {
                        showPage(pid);
                    }
                });
            })(navItems[n]);
        }

        function prefsSnapshotSerialize() {
            return JSON.stringify(__wtNormalizePrefs(window.__wtPrefs));
        }

        var prefsSnapshot = prefsSnapshotSerialize();

        function syncSettingsDomFromPrefs() {
            function syncToggle(sel, on) {
                var el = root.querySelector(sel);
                if (el) {
                    el.classList.toggle('wt-on', !!on);
                    el.setAttribute('aria-pressed', on ? 'true' : 'false');
                }
            }
            var profSel = root.querySelector('.wt-set-default-profile');
            if (profSel) {
                profSel.value = window.__wtPrefs.defaultNewTabProfile || 'daemon';
            }
            var modeSel = root.querySelector('.wt-set-startup-mode');
            if (modeSel) {
                modeSel.value = String(window.__wtPrefs.startupModeIndex === 1 ? 1 : 0);
            }
            var boot = root.querySelector('.wt-set-boot-toggle');
            if (boot) {
                boot.classList.toggle('wt-on', !!window.__wtPrefs.bootOnStart);
                boot.setAttribute('aria-pressed', window.__wtPrefs.bootOnStart ? 'true' : 'false');
            }
            syncToggle('.wt-set-auto-scroll', window.__wtPrefs.autoScroll !== false);
            syncToggle('.wt-set-auto-copy', window.__wtPrefs.autoCopySelection !== false);
            var copyFmt = root.querySelector('.wt-set-copy-format');
            if (copyFmt) {
                copyFmt.value = window.__wtPrefs.copyFormat === 'html' ? 'html' : 'plain';
            }
            syncToggle('.wt-set-rect-trim', !!window.__wtPrefs.rectCopyTrimTrailing);
            syncToggle('.wt-set-paste-trim', !!window.__wtPrefs.pasteTrimTrailing);
            var wordInp = root.querySelector('.wt-set-word-sep');
            if (wordInp) {
                wordInp.value = String(window.__wtPrefs.wordSeparators || WT_INTERACTION_DEFAULTS.wordSeparators);
            }
            syncToggle('.wt-set-snap-grid', !!window.__wtPrefs.snapWindowToCharGrid);
            var tabSw = root.querySelector('.wt-set-tab-switch-style');
            if (tabSw) {
                tabSw.value = window.__wtPrefs.tabSwitchStyle === 'mru' ? 'mru' : 'order';
            }
            syncToggle('.wt-set-focus-hover', !!window.__wtPrefs.focusPaneOnHover);
            syncToggle('.wt-set-ctrl-scroll-font', window.__wtPrefs.ctrlScrollFontSize !== false);
            syncToggle('.wt-set-ctrl-shift-opacity', window.__wtPrefs.ctrlShiftScrollOpacity !== false);
            syncToggle('.wt-set-detect-urls', window.__wtPrefs.detectUrls !== false);
            var urlInp = root.querySelector('.wt-set-search-web-url');
            if (urlInp) {
                urlInp.value = String(window.__wtPrefs.searchWebUrl || WT_INTERACTION_DEFAULTS.searchWebUrl);
            }
            syncToggle('.wt-set-exp-selection-color', !!window.__wtPrefs.experimentalSelectionColorKeys);
            var fontSel0 = root.querySelector('.wt-set-font-size-select');
            if (fontSel0) {
                fontSel0.value = String(__wtNearestStandardFontSize(__wtClampFontSize(window.__wtPrefs.fontSize)));
            }
            var defFs = root.querySelector('.wt-def-fontsize');
            if (defFs) {
                defFs.value = String(__wtClampFontSize(window.__wtPrefs.fontSize));
            }
            var appTh = root.querySelector('.wt-set-app-theme');
            if (appTh) {
                appTh.value = __wtIsLightUiScheme(window.__wtPrefs.scheme) ? 'lightcream' : 'dark';
            }
            var ntpSel = root.querySelector('.wt-set-new-tab-position');
            if (ntpSel) {
                var ntp = window.__wtPrefs.newTabPosition;
                ntpSel.value = ntp === 'first' || ntp === 'after_current' ? ntp : 'last';
            }
            syncToggle('.wt-set-always-show-tabs', window.__wtPrefs.alwaysShowTabs !== false);
            syncToggle('.wt-set-show-tabs-fullscreen', !!window.__wtPrefs.showTabsInFullscreen);
            syncToggle('.wt-set-tab-acrylic', !!window.__wtPrefs.tabRowAcrylic);
            syncToggle('.wt-set-active-title-app', window.__wtPrefs.useActiveTitleForAppTitle !== false);
            syncToggle('.wt-set-always-on-top', !!window.__wtPrefs.alwaysOnTop);
            var twSty0 = root.querySelector('.wt-set-tab-width-style');
            if (twSty0) {
                twSty0.value = window.__wtPrefs.tabWidth === 'compact' ? 'compact' : 'equal';
            }
            syncToggle('.wt-set-pane-animations', window.__wtPrefs.paneAnimations !== false);
            syncToggle('.wt-set-tray-icon', !!window.__wtPrefs.notifyAreaIcon);
            syncToggle('.wt-set-tray-hide-min', !!window.__wtPrefs.notifyHideWhenMinimized);
            syncToggle('.wt-set-auto-hide-win', !!window.__wtPrefs.autoHideWindow);
            var gfxSel0 = root.querySelector('.wt-set-graphics-api');
            if (gfxSel0) {
                var ga = window.__wtPrefs.graphicsApi;
                gfxSel0.value = ga === 'd3d11' || ga === 'd2d' ? ga : 'auto';
            }
            syncToggle('.wt-set-disable-partial-swap', !!window.__wtPrefs.disablePartialSwapChain);
            syncToggle('.wt-set-software-warp', !!window.__wtPrefs.softwareRenderingWarp);
            syncToggle('.wt-set-allow-background', !!window.__wtPrefs.allowBackgroundRun);
            var tmmSel0 = root.querySelector('.wt-set-text-measure-mode');
            if (tmmSel0) {
                var tmu = window.__wtPrefs.textMeasurementMode;
                tmmSel0.value = tmu === 'wcswidth' || tmu === 'wincon' ? tmu : 'grapheme';
            }
            var egSync = __wtNormalizeExtensionGenerators(window.__wtPrefs.extensionGenerators);
            window.__wtPrefs.extensionGenerators = egSync;
            var extNodes = root.querySelectorAll('.wt-ext-gen-toggle[data-wt-ext]');
            for (var exi = 0; exi < extNodes.length; exi++) {
                var en = extNodes[exi];
                var eid = en.getAttribute('data-wt-ext');
                var eon = !!egSync[eid];
                en.classList.toggle('wt-on', eon);
                en.setAttribute('aria-pressed', eon ? 'true' : 'false');
            }
            __wtRenderNewTabMenuList(root);
            var actListRef = root.querySelector('.wt-actions-list');
            if (actListRef) {
                __wtFillActionReferenceList(actListRef);
            }
            __wtEnsureDefSchemeSelect(root);
            var defScheme = root.querySelector('.wt-def-scheme-select');
            if (defScheme && THEME_PRESETS[window.__wtPrefs.scheme]) {
                defScheme.value = window.__wtPrefs.scheme;
            }
            var dirModeEl = root.querySelector('.wt-def-start-dir-mode');
            var dirPathEl = root.querySelector('.wt-def-start-dir-path');
            if (dirModeEl) {
                dirModeEl.value = window.__wtPrefs.defaultStartingDirectoryMode === 'custom' ? 'custom' : 'inherit';
            }
            if (dirPathEl) {
                dirPathEl.value = String(window.__wtPrefs.defaultStartingDirectory || '');
                dirPathEl.disabled = window.__wtPrefs.defaultStartingDirectoryMode !== 'custom';
            }
            var iconInp = root.querySelector('.wt-def-profile-icon');
            if (iconInp) {
                iconInp.value = String(window.__wtPrefs.defaultProfileIcon || '');
            }
            var tabTit = root.querySelector('.wt-def-tab-title-mode');
            if (tabTit) {
                tabTit.value = window.__wtPrefs.defaultTabTitleMode === 'profileName' ? 'profileName' : 'none';
            }
            syncToggle('.wt-def-elevate', !!window.__wtPrefs.defaultElevate);
            var ff = root.querySelector('.wt-def-font-family');
            if (ff) {
                ff.value = String(window.__wtPrefs.fontFamily || '');
            }
            var lhInp = root.querySelector('.wt-def-line-height');
            if (lhInp) {
                lhInp.value = String(window.__wtPrefs.terminalLineHeight);
            }
            var lsInp = root.querySelector('.wt-def-letter-spacing');
            if (lsInp) {
                lsInp.value = String(window.__wtPrefs.terminalLetterSpacing);
            }
            var fwSel = root.querySelector('.wt-def-font-weight');
            if (fwSel) {
                fwSel.value = String(window.__wtPrefs.fontWeight || 'normal');
            }
            syncToggle('.wt-def-custom-glyphs', window.__wtPrefs.terminalCustomGlyphs !== false);
            syncToggle('.wt-def-color-emoji', window.__wtPrefs.colorEmoji !== false);
            syncToggle('.wt-def-retro', !!window.__wtPrefs.retroTerminalEffect);
            var adjc = root.querySelector('.wt-def-adjust-colors');
            if (adjc) {
                var ac = window.__wtPrefs.adjustIndistinguishableColors;
                adjc.value = ac === 'indexed' || ac === 'always' ? ac : 'never';
            }
            var cst = root.querySelector('.wt-def-cursor-style');
            if (cst) {
                var cs = window.__wtPrefs.cursorStyle;
                cst.value = cs === 'block' || cs === 'underline' ? cs : 'bar';
            }
            var cc = root.querySelector('.wt-def-cursor-color');
            if (cc) {
                cc.value = String(window.__wtPrefs.cursorColorOverride || '');
            }
            var bgp = root.querySelector('.wt-def-bg-path');
            if (bgp) {
                bgp.value = String(window.__wtPrefs.backgroundImagePath || '');
            }
            var bgs = root.querySelector('.wt-def-bg-stretch');
            if (bgs) {
                bgs.value = String(window.__wtPrefs.backgroundImageStretch || 'uniformToFill');
            }
            var bga = root.querySelector('.wt-def-bg-align');
            if (bga) {
                bga.value = String(window.__wtPrefs.backgroundImageAlignment || 'center');
            }
            var bio = root.querySelector('.wt-def-bg-img-opacity');
            var biov = root.querySelector('.wt-def-bg-img-opacity-val');
            if (bio) {
                var iop = typeof window.__wtPrefs.backgroundImageOpacity === 'number' ?
                    window.__wtPrefs.backgroundImageOpacity : 100;
                bio.value = String(iop);
            }
            if (biov) {
                biov.textContent = (typeof window.__wtPrefs.backgroundImageOpacity === 'number' ?
                    window.__wtPrefs.backgroundImageOpacity : 100) + '%';
            }
            var ist = root.querySelector('.wt-def-intense-style');
            if (ist) {
                ist.value = String(window.__wtPrefs.intenseTextStyle || 'bright');
            }
            var tbo = root.querySelector('.wt-def-terminal-bg-opacity');
            var tbov = root.querySelector('.wt-def-terminal-bg-opacity-val');
            if (tbo) {
                var tbp = typeof window.__wtPrefs.terminalBgOpacity === 'number' ?
                    window.__wtPrefs.terminalBgOpacity : 100;
                tbo.value = String(tbp);
            }
            if (tbov) {
                tbov.textContent = (typeof window.__wtPrefs.terminalBgOpacity === 'number' ?
                    window.__wtPrefs.terminalBgOpacity : 100) + '%';
            }
            syncToggle('.wt-def-acrylic', !!window.__wtPrefs.useAcrylic);
            var padInp = root.querySelector('.wt-def-padding');
            if (padInp) {
                padInp.value = String(window.__wtPrefs.terminalPadding || '');
            }
            var sbar = root.querySelector('.wt-def-scrollbar');
            if (sbar) {
                sbar.value = window.__wtPrefs.terminalScrollbarMode === 'hidden' ? 'hidden' : 'visible';
            }
            __wtRenderColorSchemeCards(root);
            syncColorCards();
            __wtSyncDefAppearancePreview(root);
        }

        var bootT = root.querySelector('.wt-set-boot-toggle');
        if (bootT) {
            bootT.addEventListener('click', function() {
                bootT.classList.toggle('wt-on');
                var bon = bootT.classList.contains('wt-on');
                bootT.setAttribute('aria-pressed', bon ? 'true' : 'false');
                window.__wtPrefs.bootOnStart = bon;
            });
        }
        var autoT = root.querySelector('.wt-set-auto-scroll');
        if (autoT) {
            autoT.addEventListener('click', function() {
                autoT.classList.toggle('wt-on');
                var aon = autoT.classList.contains('wt-on');
                autoT.setAttribute('aria-pressed', aon ? 'true' : 'false');
                window.__wtPrefs.autoScroll = aon;
                applyShellScrollFromPrefs();
            });
        }

        function bindToggleClick(el, prefKey, after) {
            if (!el) {
                return;
            }
            el.addEventListener('click', function() {
                el.classList.toggle('wt-on');
                var on = el.classList.contains('wt-on');
                el.setAttribute('aria-pressed', on ? 'true' : 'false');
                window.__wtPrefs[prefKey] = on;
                if (typeof after === 'function') {
                    after(on);
                }
            });
        }

        bindToggleClick(root.querySelector('.wt-set-auto-copy'), 'autoCopySelection');
        bindToggleClick(root.querySelector('.wt-set-rect-trim'), 'rectCopyTrimTrailing');
        bindToggleClick(root.querySelector('.wt-set-paste-trim'), 'pasteTrimTrailing');
        bindToggleClick(root.querySelector('.wt-set-snap-grid'), 'snapWindowToCharGrid');
        bindToggleClick(root.querySelector('.wt-set-focus-hover'), 'focusPaneOnHover');
        bindToggleClick(root.querySelector('.wt-set-ctrl-scroll-font'), 'ctrlScrollFontSize');
        bindToggleClick(root.querySelector('.wt-set-ctrl-shift-opacity'), 'ctrlShiftScrollOpacity');
        bindToggleClick(root.querySelector('.wt-set-detect-urls'), 'detectUrls');
        bindToggleClick(root.querySelector('.wt-set-exp-selection-color'), 'experimentalSelectionColorKeys');

        bindToggleClick(root.querySelector('.wt-set-always-show-tabs'), 'alwaysShowTabs', function() {
            applyAppearancePrefsToChrome();
        });
        bindToggleClick(root.querySelector('.wt-set-show-tabs-fullscreen'), 'showTabsInFullscreen');
        bindToggleClick(root.querySelector('.wt-set-tab-acrylic'), 'tabRowAcrylic', function() {
            applyAppearancePrefsToChrome();
        });
        bindToggleClick(root.querySelector('.wt-set-active-title-app'), 'useActiveTitleForAppTitle');
        bindToggleClick(root.querySelector('.wt-set-always-on-top'), 'alwaysOnTop');
        bindToggleClick(root.querySelector('.wt-set-pane-animations'), 'paneAnimations', function() {
            applyAppearancePrefsToChrome();
        });
        bindToggleClick(root.querySelector('.wt-set-tray-icon'), 'notifyAreaIcon');
        bindToggleClick(root.querySelector('.wt-set-tray-hide-min'), 'notifyHideWhenMinimized');
        bindToggleClick(root.querySelector('.wt-set-auto-hide-win'), 'autoHideWindow');
        bindToggleClick(root.querySelector('.wt-set-disable-partial-swap'), 'disablePartialSwapChain');
        bindToggleClick(root.querySelector('.wt-set-software-warp'), 'softwareRenderingWarp');
        bindToggleClick(root.querySelector('.wt-set-allow-background'), 'allowBackgroundRun');

        bindToggleClick(root.querySelector('.wt-def-elevate'), 'defaultElevate');
        bindToggleClick(root.querySelector('.wt-def-custom-glyphs'), 'terminalCustomGlyphs', function() {
            applyPrefsToRuntime();
        });
        bindToggleClick(root.querySelector('.wt-def-color-emoji'), 'colorEmoji');
        bindToggleClick(root.querySelector('.wt-def-retro'), 'retroTerminalEffect');
        bindToggleClick(root.querySelector('.wt-def-acrylic'), 'useAcrylic', function() {
            applyPrefsToRuntime();
        });

        var tmmSel = root.querySelector('.wt-set-text-measure-mode');
        if (tmmSel) {
            tmmSel.addEventListener('change', function() {
                var v = tmmSel.value;
                window.__wtPrefs.textMeasurementMode =
                    v === 'wcswidth' || v === 'wincon' ? v : 'grapheme';
                applyTerminalPrefsToAllShellTabs();
            });
        }

        var dirm0 = root.querySelector('.wt-def-start-dir-mode');
        if (dirm0) {
            dirm0.addEventListener('change', function() {
                window.__wtPrefs.defaultStartingDirectoryMode = dirm0.value === 'custom' ? 'custom' : 'inherit';
                var dp0 = root.querySelector('.wt-def-start-dir-path');
                if (dp0) {
                    dp0.disabled = window.__wtPrefs.defaultStartingDirectoryMode !== 'custom';
                }
            });
        }
        var dirp0 = root.querySelector('.wt-def-start-dir-path');
        if (dirp0) {
            dirp0.addEventListener('change', function() {
                window.__wtPrefs.defaultStartingDirectory =
                    __wtClampStr(String(dirp0.value || ''), 500, '');
            });
        }
        var ic0 = root.querySelector('.wt-def-profile-icon');
        if (ic0) {
            ic0.addEventListener('change', function() {
                window.__wtPrefs.defaultProfileIcon = __wtClampStr(String(ic0.value || ''), 256, '');
            });
        }
        var ttm0 = root.querySelector('.wt-def-tab-title-mode');
        if (ttm0) {
            ttm0.addEventListener('change', function() {
                window.__wtPrefs.defaultTabTitleMode = ttm0.value === 'profileName' ? 'profileName' : 'none';
            });
        }
        var dsc0 = root.querySelector('.wt-def-scheme-select');
        if (dsc0) {
            dsc0.addEventListener('change', function() {
                var sid = dsc0.value;
                if (!THEME_PRESETS[sid]) {
                    return;
                }
                window.__wtPrefs.scheme = sid;
                syncColorCards();
                var appTh0 = root.querySelector('.wt-set-app-theme');
                if (appTh0) {
                    appTh0.value = __wtIsLightUiScheme(sid) ? 'lightcream' : 'dark';
                }
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var ff0 = root.querySelector('.wt-def-font-family');
        if (ff0) {
            ff0.addEventListener('change', function() {
                window.__wtPrefs.fontFamily = __wtClampStr(String(ff0.value || '').trim(), 120, 'Cascadia Mono');
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var dfs0 = root.querySelector('.wt-def-fontsize');
        if (dfs0) {
            dfs0.addEventListener('change', function() {
                window.__wtPrefs.fontSize = __wtClampFontSize(parseInt(dfs0.value, 10));
                syncSettingsDomFromPrefs();
                applyPrefsToRuntime();
            });
        }
        var lh0 = root.querySelector('.wt-def-line-height');
        if (lh0) {
            lh0.addEventListener('change', function() {
                var lh = parseFloat(lh0.value);
                window.__wtPrefs.terminalLineHeight = isNaN(lh) ? 1.2 : Math.min(3, Math.max(1, lh));
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var ls0 = root.querySelector('.wt-def-letter-spacing');
        if (ls0) {
            ls0.addEventListener('change', function() {
                var lsv = parseFloat(ls0.value);
                window.__wtPrefs.terminalLetterSpacing = isNaN(lsv) ? 0.3 : Math.min(8, Math.max(-2, lsv));
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var fwg0 = root.querySelector('.wt-def-font-weight');
        if (fwg0) {
            fwg0.addEventListener('change', function() {
                window.__wtPrefs.fontWeight = fwg0.value || 'normal';
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var adj0 = root.querySelector('.wt-def-adjust-colors');
        if (adj0) {
            adj0.addEventListener('change', function() {
                var av = adj0.value;
                window.__wtPrefs.adjustIndistinguishableColors =
                    av === 'indexed' || av === 'always' ? av : 'never';
            });
        }
        var cus0 = root.querySelector('.wt-def-cursor-style');
        if (cus0) {
            cus0.addEventListener('change', function() {
                var cv = cus0.value;
                window.__wtPrefs.cursorStyle = cv === 'block' || cv === 'underline' ? cv : 'bar';
                applyPrefsToRuntime();
            });
        }
        var cuc0 = root.querySelector('.wt-def-cursor-color');
        if (cuc0) {
            cuc0.addEventListener('change', function() {
                var t = String(cuc0.value || '').trim();
                window.__wtPrefs.cursorColorOverride = /^#[0-9A-Fa-f]{6}$/.test(t) ? t : '';
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var bgp0 = root.querySelector('.wt-def-bg-path');
        if (bgp0) {
            bgp0.addEventListener('change', function() {
                window.__wtPrefs.backgroundImagePath =
                    __wtClampStr(String(bgp0.value || ''), 2000, '');
                applyPrefsToRuntime();
            });
        }
        var bgs0 = root.querySelector('.wt-def-bg-stretch');
        if (bgs0) {
            bgs0.addEventListener('change', function() {
                window.__wtPrefs.backgroundImageStretch = bgs0.value || 'uniformToFill';
                applyPrefsToRuntime();
            });
        }
        var bga0 = root.querySelector('.wt-def-bg-align');
        if (bga0) {
            bga0.addEventListener('change', function() {
                window.__wtPrefs.backgroundImageAlignment = bga0.value || 'center';
                applyPrefsToRuntime();
            });
        }
        var bio0 = root.querySelector('.wt-def-bg-img-opacity');
        var biov0 = root.querySelector('.wt-def-bg-img-opacity-val');
        if (bio0 && biov0) {
            bio0.addEventListener('input', function() {
                var iv = parseInt(bio0.value, 10);
                if (isNaN(iv)) {
                    return;
                }
                iv = Math.min(100, Math.max(0, iv));
                window.__wtPrefs.backgroundImageOpacity = iv;
                biov0.textContent = iv + '%';
                applyPrefsToRuntime();
            });
        }
        var int0 = root.querySelector('.wt-def-intense-style');
        if (int0) {
            int0.addEventListener('change', function() {
                var ivs = int0.value;
                window.__wtPrefs.intenseTextStyle =
                    ivs === 'bold' || ivs === 'all' || ivs === 'none' ? ivs : 'bright';
            });
        }
        var tbo0 = root.querySelector('.wt-def-terminal-bg-opacity');
        var tbov0 = root.querySelector('.wt-def-terminal-bg-opacity-val');
        if (tbo0 && tbov0) {
            tbo0.addEventListener('input', function() {
                var tv = parseInt(tbo0.value, 10);
                if (isNaN(tv)) {
                    return;
                }
                tv = Math.min(100, Math.max(10, tv));
                window.__wtPrefs.terminalBgOpacity = tv;
                tbov0.textContent = tv + '%';
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var pad0 = root.querySelector('.wt-def-padding');
        if (pad0) {
            pad0.addEventListener('change', function() {
                window.__wtPrefs.terminalPadding = __wtClampStr(String(pad0.value || ''), 64, '8, 8, 8, 8');
                applyPrefsToRuntime();
            });
        }
        var sbr0 = root.querySelector('.wt-def-scrollbar');
        if (sbr0) {
            sbr0.addEventListener('change', function() {
                window.__wtPrefs.terminalScrollbarMode = sbr0.value === 'hidden' ? 'hidden' : 'visible';
                applyPrefsToRuntime();
            });
        }

        var clearCacheBtn = root.querySelector('.wt-set-clear-cache-btn');
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', function() {
                if (!window.confirm('清除 Web 侧除「已保存设置」以外的缓存项，并尝试通知原生清理？')) {
                    return;
                }
                __wtClearAppCacheStores();
            });
        }
        var resetPrefsBtn = root.querySelector('.wt-set-reset-prefs-btn');
        if (resetPrefsBtn) {
            resetPrefsBtn.addEventListener('click', function() {
                if (!window.confirm('将所有设置恢复为默认值并立即保存？此操作不可撤销。')) {
                    return;
                }
                __wtResetPrefsToFactory();
                prefsSnapshot = prefsSnapshotSerialize();
                syncSettingsDomFromPrefs();
            });
        }

        if (!root.dataset.wtSettingsDelegates) {
            root.dataset.wtSettingsDelegates = '1';
            root.addEventListener('click', function(ev) {
                var psub = ev.target.closest('[data-profile-subnav]');
                if (psub && root.contains(psub)) {
                    showPage(psub.getAttribute('data-profile-subnav'));
                    return;
                }
                var pbak = ev.target.closest('[data-profile-breadcrumb-back]');
                if (pbak && root.contains(pbak)) {
                    showPage(pbak.getAttribute('data-profile-breadcrumb-back'));
                    return;
                }
                var extEl = ev.target.closest('.wt-ext-gen-toggle[data-wt-ext]');
                if (extEl && root.contains(extEl)) {
                    extEl.classList.toggle('wt-on');
                    var onx = extEl.classList.contains('wt-on');
                    extEl.setAttribute('aria-pressed', onx ? 'true' : 'false');
                    var exid = extEl.getAttribute('data-wt-ext');
                    window.__wtPrefs.extensionGenerators =
                        __wtNormalizeExtensionGenerators(window.__wtPrefs.extensionGenerators);
                    window.__wtPrefs.extensionGenerators[exid] = onx;
                    return;
                }
                var upEl = ev.target.closest('.wt-ntm-up');
                if (upEl && root.contains(upEl) && !upEl.disabled) {
                    var rowU = upEl.closest('.wt-ntm-row');
                    if (rowU) {
                        var idxU = parseInt(rowU.getAttribute('data-wt-ntm-idx'), 10);
                        if (!isNaN(idxU) && idxU > 0) {
                            var listU = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
                            var tmpU = listU[idxU - 1];
                            listU[idxU - 1] = listU[idxU];
                            listU[idxU] = tmpU;
                            window.__wtPrefs.newTabMenuItems = listU;
                            __wtRenderNewTabMenuList(root);
                        }
                    }
                    return;
                }
                var dnEl = ev.target.closest('.wt-ntm-down');
                if (dnEl && root.contains(dnEl) && !dnEl.disabled) {
                    var rowD = dnEl.closest('.wt-ntm-row');
                    if (rowD) {
                        var idxD = parseInt(rowD.getAttribute('data-wt-ntm-idx'), 10);
                        var listD = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
                        if (!isNaN(idxD) && idxD >= 0 && idxD < listD.length - 1) {
                            var tmpD = listD[idxD + 1];
                            listD[idxD + 1] = listD[idxD];
                            listD[idxD] = tmpD;
                            window.__wtPrefs.newTabMenuItems = listD;
                            __wtRenderNewTabMenuList(root);
                        }
                    }
                    return;
                }
                var delEl = ev.target.closest('.wt-ntm-del');
                if (delEl && root.contains(delEl) && !delEl.disabled) {
                    var rowX = delEl.closest('.wt-ntm-row');
                    if (rowX) {
                        var idxX = parseInt(rowX.getAttribute('data-wt-ntm-idx'), 10);
                        var listX = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
                        if (!isNaN(idxX) && idxX >= 0 && idxX < listX.length) {
                            if (listX[idxX].kind !== 'remaining') {
                                listX.splice(idxX, 1);
                                window.__wtPrefs.newTabMenuItems =
                                    __wtNormalizeNewTabMenuItems(listX);
                                __wtRenderNewTabMenuList(root);
                            }
                        }
                    }
                }
            });

            var addProfBtn = root.querySelector('.wt-ntm-add-profile-btn');
            if (addProfBtn) {
                addProfBtn.addEventListener('click', function() {
                    var sel = root.querySelector('.wt-ntm-pick-profile');
                    var v = sel ? sel.value : 'daemon';
                    var listP = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
                    var ins = listP.length;
                    for (var ii = 0; ii < listP.length; ii++) {
                        if (listP[ii].kind === 'remaining') {
                            ins = ii;
                            break;
                        }
                    }
                    listP.splice(ins, 0, { kind: 'profile', profile: v });
                    window.__wtPrefs.newTabMenuItems = __wtNormalizeNewTabMenuItems(listP);
                    __wtRenderNewTabMenuList(root);
                });
            }
            var addSepBtn = root.querySelector('.wt-ntm-add-sep-btn');
            if (addSepBtn) {
                addSepBtn.addEventListener('click', function() {
                    var listS = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
                    var insS = listS.length;
                    for (var si = 0; si < listS.length; si++) {
                        if (listS[si].kind === 'remaining') {
                            insS = si;
                            break;
                        }
                    }
                    listS.splice(insS, 0, { kind: 'separator' });
                    window.__wtPrefs.newTabMenuItems = __wtNormalizeNewTabMenuItems(listS);
                    __wtRenderNewTabMenuList(root);
                });
            }
            var addFoldBtn = root.querySelector('.wt-ntm-add-folder-btn');
            if (addFoldBtn) {
                addFoldBtn.addEventListener('click', function() {
                    var inp = root.querySelector('.wt-ntm-folder-name');
                    var name = inp ? String(inp.value || '').trim() : '';
                    if (!name) {
                        name = '新建文件夹';
                    }
                    name = __wtClampStr(name, 64, '新建文件夹');
                    var listF = __wtNormalizeNewTabMenuItems(window.__wtPrefs.newTabMenuItems);
                    var insF = listF.length;
                    for (var fi = 0; fi < listF.length; fi++) {
                        if (listF[fi].kind === 'remaining') {
                            insF = fi;
                            break;
                        }
                    }
                    listF.splice(insF, 0, { kind: 'folder', name: name });
                    window.__wtPrefs.newTabMenuItems = __wtNormalizeNewTabMenuItems(listF);
                    __wtRenderNewTabMenuList(root);
                });
            }
        }

        function syncColorCards() {
            var cur = window.__wtPrefs.scheme;
            var cards = root.querySelectorAll('.wt-color-scheme-card[data-scheme]');
            for (var c = 0; c < cards.length; c++) {
                var card = cards[c];
                var id = card.getAttribute('data-scheme');
                var on = id === cur;
                card.classList.toggle('wt-color-scheme-card-active', on);
                card.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        }

        if (!root.dataset.wtColorCardDelegate) {
            root.dataset.wtColorCardDelegate = '1';
            root.addEventListener('click', function(ev) {
                var card = ev.target.closest('.wt-color-scheme-card[data-scheme]');
                if (!card || !root.contains(card)) {
                    return;
                }
                var sid = card.getAttribute('data-scheme');
                if (!sid || !THEME_PRESETS[sid]) {
                    return;
                }
                window.__wtPrefs.scheme = sid;
                syncColorCards();
                var appThSync = root.querySelector('.wt-set-app-theme');
                if (appThSync) {
                    appThSync.value = __wtIsLightUiScheme(sid) ? 'lightcream' : 'dark';
                }
                var defSchSync = root.querySelector('.wt-def-scheme-select');
                if (defSchSync) {
                    defSchSync.value = sid;
                }
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }

        var fontSel = root.querySelector('.wt-set-font-size-select');
        var profSel = root.querySelector('.wt-set-default-profile');
        var modeSel = root.querySelector('.wt-set-startup-mode');

        syncSettingsDomFromPrefs();

        if (profSel) {
            profSel.addEventListener('change', function() {
                window.__wtPrefs.defaultNewTabProfile = profSel.value;
                window.__newTabProfile = profSel.value;
            });
        }
        if (modeSel) {
            modeSel.addEventListener('change', function() {
                var v = parseInt(modeSel.value, 10);
                window.__wtPrefs.startupModeIndex = v === 1 ? 1 : 0;
            });
        }

        var copyFmtEl = root.querySelector('.wt-set-copy-format');
        if (copyFmtEl) {
            copyFmtEl.addEventListener('change', function() {
                var v = copyFmtEl.value === 'html' ? 'html' : 'plain';
                window.__wtPrefs.copyFormat = v;
                window.__wtPrefs.copyAsHtml = (v === 'html');
            });
        }

        var wordSepInp = root.querySelector('.wt-set-word-sep');
        if (wordSepInp) {
            wordSepInp.addEventListener('change', function() {
                var t = String(wordSepInp.value || '');
                window.__wtPrefs.wordSeparators = t.length > 0 ?
                    __wtClampStr(t, 500, WT_INTERACTION_DEFAULTS.wordSeparators) :
                    WT_INTERACTION_DEFAULTS.wordSeparators;
                applyTerminalPrefsToAllShellTabs();
            });
        }

        var tabSwitchEl = root.querySelector('.wt-set-tab-switch-style');
        if (tabSwitchEl) {
            tabSwitchEl.addEventListener('change', function() {
                window.__wtPrefs.tabSwitchStyle = tabSwitchEl.value === 'mru' ? 'mru' : 'order';
            });
        }

        var searchUrlInp = root.querySelector('.wt-set-search-web-url');
        if (searchUrlInp) {
            searchUrlInp.addEventListener('change', function() {
                window.__wtPrefs.searchWebUrl = __wtClampStr(String(searchUrlInp.value || ''),
                    2000,
                    WT_INTERACTION_DEFAULTS.searchWebUrl);
            });
        }

        if (fontSel) {
            fontSel.addEventListener('change', function() {
                var v = parseInt(fontSel.value, 10);
                if (!isNaN(v)) {
                    window.__wtPrefs.fontSize = __wtClampFontSize(v);
                    var dfsSync = root.querySelector('.wt-def-fontsize');
                    if (dfsSync) {
                        dfsSync.value = String(window.__wtPrefs.fontSize);
                    }
                    applyChromeTypography();
                    applyTerminalPrefsToAllShellTabs();
                    __wtSyncDefAppearancePreview(root);
                }
            });
        }

        var appThemeEl = root.querySelector('.wt-set-app-theme');
        if (appThemeEl) {
            appThemeEl.addEventListener('change', function() {
                var v = appThemeEl.value === 'lightcream' ? 'lightcream' : 'dark';
                window.__wtPrefs.scheme = v;
                syncColorCards();
                var defSch2 = root.querySelector('.wt-def-scheme-select');
                if (defSch2) {
                    defSch2.value = v;
                }
                applyPrefsToRuntime();
                __wtSyncDefAppearancePreview(root);
            });
        }
        var ntpEl = root.querySelector('.wt-set-new-tab-position');
        if (ntpEl) {
            ntpEl.addEventListener('change', function() {
                var v = ntpEl.value;
                window.__wtPrefs.newTabPosition = v === 'first' || v === 'after_current' ? v : 'last';
            });
        }
        var twStyEl = root.querySelector('.wt-set-tab-width-style');
        if (twStyEl) {
            twStyEl.addEventListener('change', function() {
                window.__wtPrefs.tabWidth = twStyEl.value === 'compact' ? 'compact' : 'equal';
                applyAppearancePrefsToChrome();
            });
        }
        var gfxEl = root.querySelector('.wt-set-graphics-api');
        if (gfxEl) {
            gfxEl.addEventListener('change', function() {
                var gv = gfxEl.value;
                window.__wtPrefs.graphicsApi = gv === 'd3d11' || gv === 'd2d' ? gv : 'auto';
            });
        }

        var discard = root.querySelector('.wt-set-discard-btn');
        var save = root.querySelector('.wt-set-save-btn');
        if (discard) {
            discard.addEventListener('click', function() {
                try {
                    __wtAssignPrefsFromObject(JSON.parse(prefsSnapshot));
                    syncSettingsDomFromPrefs();
                    applyPrefsToRuntime();
                } catch (e) {}
            });
        }
        if (save) {
            save.addEventListener('click', function() {
                __wtSavePrefs();
                prefsSnapshot = prefsSnapshotSerialize();
            });
        }
    }

    function findSettingsTab() {
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].kind === 'settings') {
                return tabs[i];
            }
        }
        return null;
    }

    function openOrFocusSettingsTab() {
        var existing = findSettingsTab();
        if (existing) {
            switchTab(existing.key);
            return existing;
        }
        return createSettingsTab();
    }

    function createSettingsTab() {
        var key = ++__nextTabKey;

        var tabEl = document.createElement('div');
        tabEl.className = 'wt-tab';
        tabEl.innerHTML =
            '<span class="wt-tab-icon wt-tab-icon--settings" aria-hidden="true"></span>' +
            '<span class="wt-tab-title">设置</span>' +
            '<button type="button" class="wt-tab-close" title="关闭" aria-label="关闭标签">×</button>';

        var paneEl = document.createElement('div');
        paneEl.className = 'wt-term-pane wt-settings-pane';
        termStack.appendChild(paneEl);

        var tmpl = document.getElementById('wt-settings-template');
        if (tmpl && tmpl.content) {
            paneEl.appendChild(document.importNode(tmpl.content, true));
        }

        var tab = {
            key: key,
            kind: 'settings',
            profile: '',
            sessionId: -1,
            localEcho: false,
            term: null,
            paneEl: paneEl,
            tabEl: tabEl
        };

        tabsStrip.appendChild(tabEl);
        tabs.push(tab);
        bindTabRow(tab);
        switchTab(key);
        initSettingsPanelInRoot(paneEl);
        return tab;
    }

    window.writeToTerminal = function(sessionId, data) {
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].sessionId === sessionId) {
                termWriteChunk(tabs[i], data);
                break;
            }
        }
    };

    window.wtBootstrap = function() {
        if (!tabsStrip || !termStack) {
            return;
        }
        __wtLoadPrefs();
        applyPrefsToRuntime();
        if (tabs.length === 0) {
            createTab(window.__wtPrefs.defaultNewTabProfile || 'daemon');
        }
    };

    document.getElementById('wt-btn-new-tab').addEventListener('click', function() {
        var cur = getActiveTab();
        if (cur && cur.kind === 'settings') {
            return;
        }
        createTab(profileForNewTabFromActive());
    });

    var btnMin = document.getElementById('wt-btn-min');
    if (btnMin) {
        btnMin.addEventListener('click', function() {
            if (window.TerminalProxy && window.TerminalProxy.minimizeWindow) {
                window.TerminalProxy.minimizeWindow();
            }
        });
    }

    var btnMax = document.getElementById('wt-btn-max');
    if (btnMax) {
        btnMax.addEventListener('click', function() {
            if (window.TerminalProxy && window.TerminalProxy.maximizeWindow) {
                window.TerminalProxy.maximizeWindow();
            }
        });
    }

    var btnClose = document.getElementById('wt-btn-close');
    if (btnClose) {
        btnClose.addEventListener('click', function() {
            if (window.TerminalProxy && window.TerminalProxy.closeWindow) {
                window.TerminalProxy.closeWindow();
            }
        });
    }

    var WT_APP_VERSION = '0.1.0';

    function __wtPositionMenuTooltip(anchorEl, tipEl) {
        if (!anchorEl || !tipEl) {
            return;
        }
        var msg = anchorEl.getAttribute('data-wt-tooltip');
        if (!msg) {
            return;
        }
        tipEl.textContent = msg;
        tipEl.setAttribute('aria-hidden', 'false');
        tipEl.classList.add('wt-tip-visible');
        tipEl.style.visibility = 'hidden';
        tipEl.style.display = 'block';
        var tw = tipEl.offsetWidth;
        var th = tipEl.offsetHeight;
        var r = anchorEl.getBoundingClientRect();
        var top = r.top - th - 10;
        var left = r.left + (r.width - tw) / 2;
        if (top < 12) {
            top = r.bottom + 10;
        }
        if (left < 10) {
            left = 10;
        }
        if (left + tw > window.innerWidth - 10) {
            left = Math.max(10, window.innerWidth - tw - 10);
        }
        tipEl.style.top = top + 'px';
        tipEl.style.left = left + 'px';
        tipEl.style.visibility = '';
    }

    function __wtHideMenuTooltip(tipEl) {
        if (!tipEl) {
            return;
        }
        tipEl.classList.remove('wt-tip-visible');
        tipEl.textContent = '';
        tipEl.setAttribute('aria-hidden', 'true');
    }

    function __wtOpenAboutDialog() {
        var ov = document.getElementById('wt-about-overlay');
        if (!ov) {
            return;
        }
        var vEl = document.getElementById('wt-about-version-val');
        if (vEl) {
            vEl.textContent = WT_APP_VERSION;
        }
        ov.hidden = false;
        ov.setAttribute('aria-hidden', 'false');
        var dlg = ov.querySelector('.wt-about-dialog');
        if (dlg) {
            try {
                dlg.focus();
            } catch (e1) {}
        }
    }

    function __wtCloseAboutDialog() {
        var ov = document.getElementById('wt-about-overlay');
        if (!ov) {
            return;
        }
        ov.hidden = true;
        ov.setAttribute('aria-hidden', 'true');
    }

    (function setupProfileMenu() {
        var btn = document.getElementById('wt-btn-menu');
        var panel = document.getElementById('wt-dropdown');
        var tipEl = document.getElementById('wt-menu-hover-tip');
        if (!btn || !panel) {
            return;
        }

        function closeMenu() {
            panel.classList.remove('wt-open');
            __wtHideMenuTooltip(tipEl);
        }

        function openMenu() {
            panel.classList.add('wt-open');
        }

        function toggleMenu(ev) {
            ev.stopPropagation();
            if (panel.classList.contains('wt-open')) {
                closeMenu();
            } else {
                openMenu();
            }
        }

        btn.addEventListener('click', toggleMenu);

        document.addEventListener('click', function() {
            closeMenu();
        });

        panel.addEventListener('click', function(ev) {
            ev.stopPropagation();
        });

        function activateItem(row) {
            if (!row) {
                return;
            }
            if (row.getAttribute('data-action') === 'about') {
                closeMenu();
                __wtOpenAboutDialog();
                return;
            }
            if (row.getAttribute('data-action') === 'settings') {
                closeMenu();
                openOrFocusSettingsTab();
                return;
            }
            var pid = row.getAttribute('data-profile');
            if (!pid) {
                return;
            }
            closeMenu();
            window.__newTabProfile = pid;
            createTab(pid);
        }

        var items = panel.querySelectorAll('.wt-menu-item[role="menuitem"]');
        for (var i = 0; i < items.length; i++) {
            (function(row) {
                row.addEventListener('click', function() {
                    activateItem(row);
                });
                row.addEventListener('keydown', function(kev) {
                    if (kev.key === 'Enter') {
                        activateItem(row);
                    }
                });
            })(items[i]);
        }

        var aboutRow = document.getElementById('wt-menu-about');
        if (aboutRow && tipEl) {
            aboutRow.addEventListener('mouseenter', function() {
                if (panel.classList.contains('wt-open')) {
                    __wtPositionMenuTooltip(aboutRow, tipEl);
                }
            });
            aboutRow.addEventListener('mouseleave', function() {
                __wtHideMenuTooltip(tipEl);
            });
            aboutRow.addEventListener('focus', function() {
                if (panel.classList.contains('wt-open')) {
                    __wtPositionMenuTooltip(aboutRow, tipEl);
                }
            });
            aboutRow.addEventListener('blur', function() {
                __wtHideMenuTooltip(tipEl);
            });
        }
    })();

    (function __wtSetupAboutDialog() {
        var ov = document.getElementById('wt-about-overlay');
        if (!ov) {
            return;
        }
        ov.addEventListener('click', function(ev) {
            if (ev.target === ov) {
                __wtCloseAboutDialog();
            }
        });
        var okB = document.getElementById('wt-about-btn-ok');
        if (okB) {
            okB.addEventListener('click', __wtCloseAboutDialog);
        }
        var feedB = document.getElementById('wt-about-btn-feedback');
        if (feedB) {
            feedB.addEventListener('click', function() {
                try {
                    window.open('mailto:?subject=' + encodeURIComponent('KH Terminal 反馈') + '&body=' +
                        encodeURIComponent('版本 ' + WT_APP_VERSION + '\n\n'));
                } catch (eM) {}
            });
        }
        document.addEventListener('keydown', function(ev) {
            if (ev.key !== 'Escape') {
                return;
            }
            var o = document.getElementById('wt-about-overlay');
            if (o && !o.hidden) {
                ev.preventDefault();
                __wtCloseAboutDialog();
            }
        }, true);
    })();

    (function __wtInstallGlobalShortcutCapture() {
        function isFormFieldTarget(el) {
            if (!el || el.nodeType !== 1) {
                return false;
            }
            if (el.closest && el.closest('.xterm')) {
                return false;
            }
            var tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                return true;
            }
            return !!el.isContentEditable;
        }

        document.addEventListener('keydown', function(ev) {
            if (!ev.ctrlKey) {
                return;
            }
            if (isFormFieldTarget(ev.target)) {
                return;
            }
            var actTab = getActiveTab();

            if (ev.key === ',' && !ev.shiftKey && !ev.altKey) {
                if (actTab && actTab.kind === 'settings') {
                    return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                openOrFocusSettingsTab();
                return;
            }

            if (ev.key === 'Tab' && !ev.altKey) {
                if (tabs.length < 2) {
                    return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                var idx = -1;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i].key === activeTabKey) {
                        idx = i;
                        break;
                    }
                }
                if (idx < 0) {
                    return;
                }
                var n = tabs.length;
                var next = ((idx + (ev.shiftKey ? -1 : 1)) % n + n) % n;
                switchTab(tabs[next].key);
                return;
            }

            if (!ev.shiftKey || ev.altKey) {
                return;
            }

            var lk = String(ev.key).toLowerCase();
            if (lk === 'p') {
                ev.preventDefault();
                ev.stopPropagation();
                __wtOpenAboutDialog();
                return;
            }
            if (lk === 't') {
                if (actTab && actTab.kind === 'settings') {
                    return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                createTab(profileForNewTabFromActive());
                return;
            }
            if (lk === 'w') {
                if (tabs.length <= 1) {
                    return;
                }
                ev.preventDefault();
                ev.stopPropagation();
                removeTab(activeTabKey);
                return;
            }

            var profMap = {
                '1': 'powershell',
                '2': 'khsl',
                '3': 'daemon'
            };
            if (profMap[ev.key] !== undefined) {
                ev.preventDefault();
                ev.stopPropagation();
                createTab(profMap[ev.key]);
            }
        }, true);
    })();
})();