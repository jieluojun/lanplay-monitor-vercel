(() => {
  "use strict";

  function __lanPlayInit() {
    "use strict";

    // ============================================================
    // 补丁：沉浸式状态栏 + 网页深色跟随系统深色 + 电池优化桥接
    // 适用：合并进 script.js 的最顶部 IIFE 入口 `__lanPlayInit()` 内。
    //       在 `__lanPlayInit()` 函数最开始（约第 4 行 `use strict;` 之后）插入本块。
    // ============================================================
    //
    // 1) 在脚本启动最早的时间建立"系统深色模式"主题管线（必须在 main themeToggle 之前）。
    // 2) 提供 `window.applySystemDarkMode(isDark)` 给 Java 端调用（监听 Configuration 变化）。
    // 3) 启动后通过 `window.LanPlayNative.syncPageTheme(...)` 把当前主题推给 Java，
    //    Java 端据此切换状态栏图标颜色。
    // 4) 监听 `prefers-color-scheme: dark` 变化，WebView 自身也跟随（Android 11+ WebView 已支持）。

    // 替换 script.js 最顶部的 (function setupSystemThemeAndImmersive() { ... })();
    // 这是已修复的完整版，可直接覆盖原  IIFE（约 1-150 行）
    // 修复点：
    //  - 增加 “跟随系统” 语义：lan_play_theme 的值为 'light'|'dark'|'auto'(或空) ，auto 才跟随系统
    //  - 增加 window.resetToFollowSystem() 和长按主题按钮回到跟随系统
    //  - 启动时优先从 Java 的 LanPlayNative.getInfo() 同步系统深色，避免 localStorage 竞态
    //  - 初始推送延迟重试，确保 Java 的 evaluateJavascript 在页面就绪后仍能生效
    //  - 修复深色切换时状态栏图标通过 syncPageTheme 回推，避免 Java 侧强制覆盖
    //  - 兼容旧版 WebView 不支持 matchMedia addEventListener 的情况

    (function setupSystemThemeAndImmersive() {
      "use strict";

      if (typeof window.__lanplaySystemDark === "undefined") {
        window.__lanplaySystemDark = false;
      }

      // 对外暴露：让设置页或长按按钮可一键回到跟随系统
      window.resetToFollowSystem = function () {
        try {
          localStorage.removeItem("lan_play_theme");
          // 也清理旧的 light 标记（兼容只有 dark 存储的版本）
        } catch (e) {}
        const isDark =
          !!window.__lanplaySystemDark ||
          (window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches);
        _applyThemeToDom(isDark ? "dark" : "light");
        _pushThemeToJava(isDark ? "dark" : "light");
        try {
          window.dispatchEvent(
            new CustomEvent("lanplay:system-theme-changed", {
              detail: { isDark },
            }),
          );
        } catch (e) {}
        // 同步更新图标
        try {
          if (typeof updateThemeIcon === "function") updateThemeIcon();
        } catch (e) {}
        try {
          if (typeof updateThemeColor === "function") updateThemeColor();
        } catch (e) {}
      };

      function _getSavedManualTheme() {
        try {
          const v = localStorage.getItem("lan_play_theme");
          if (v === "light" || v === "dark") return v;
          if (v === "auto") return null; // 兼容 auto 显式值
        } catch (e) {}
        return null;
      }

      function _fetchSystemDarkFromJava() {
        try {
          if (
            window.LanPlayNative &&
            typeof window.LanPlayNative.getInfo === "function"
          ) {
            const raw = window.LanPlayNative.getInfo();
            const info = JSON.parse(raw);
            if (info && typeof info.isSystemDark === "boolean")
              return info.isSystemDark;
          }
        } catch (e) {}
        return null;
      }

      function _resolveTheme() {
        const manual = _getSavedManualTheme();
        if (manual) return manual;
        // 跟随系统
        let cached = null;
        try {
          const v = localStorage.getItem("lanplay_system_dark");
          if (v === "1") cached = true;
          else if (v === "0") cached = false;
        } catch (e) {}
        // 优先用 Java 提供的真实系统值（避免 WebView 虚拟值）
        const fromJava = _fetchSystemDarkFromJava();
        if (fromJava !== null) return fromJava ? "dark" : "light";
        if (cached === true) return "dark";
        if (cached === false) return "light";
        if (
          window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches
        )
          return "dark";
        return "light";
      }

      function _applyThemeToDom(theme) {
        const html = document.documentElement;
        if (!html) return;
        if (theme === "dark") {
          html.classList.add("dark");
          html.classList.remove("light");
        } else if (theme === "light") {
          html.classList.add("light");
          html.classList.remove("dark");
        } else {
          html.classList.remove("light", "dark");
        }
        // 同时更新 meta theme-color，并确保全局函数也更新（避免旧版本引用）
        try {
          const isDarkNow = theme === "dark";
          const color = isDarkNow ? "#0f1923" : "#dff3ff";
          document
            .querySelectorAll('meta[name="theme-color"]')
            .forEach((m) => m.remove());
          const meta = document.createElement("meta");
          meta.name = "theme-color";
          meta.content = color;
          document.head.appendChild(meta);
          // 同步到全局 updateThemeColor 的逻辑（如果已定义）
          try {
            if (
              window.updateThemeColor &&
              typeof window.updateThemeColor === "function"
            ) {
              /* 已更新 meta，直接调用同步状态栏 */
            }
          } catch (e) {}
          // 兼容：尝试调用全局的图标更新
          if (typeof window.updateThemeIcon === "function") {
            try {
              window.updateThemeIcon();
            } catch (e) {}
          }
        } catch (e) {}
      }

      function _pushThemeToJava(theme) {
        try {
          if (
            window.LanPlayNative &&
            typeof window.LanPlayNative.syncPageTheme === "function"
          ) {
            window.LanPlayNative.syncPageTheme(theme === "dark");
          }
        } catch (e) {}
      }

      window.applySystemDarkMode = function (isDark) {
        try {
          window.__lanplaySystemDark = !!isDark;
          try {
            localStorage.setItem("lanplay_system_dark", isDark ? "1" : "0");
          } catch (e) {}
          const manual = _getSavedManualTheme();
          if (!manual) {
            const theme = isDark ? "dark" : "light";
            _applyThemeToDom(theme);
            _pushThemeToJava(theme);
            try {
              window.dispatchEvent(
                new CustomEvent("lanplay:system-theme-changed", {
                  detail: { isDark: !!isDark },
                }),
              );
            } catch (e) {}
            // 让外层的 theme 图标也刷新
            try {
              if (typeof updateThemeIcon === "function") updateThemeIcon();
            } catch (e) {}
          } else {
            // 已手动锁定：仅缓存系统值，不切页面，但仍让 Java 知道真实系统值备用
            // 不推送，避免状态栏被强制跟随系统而与页面不一致
          }
        } catch (e) {
          console.warn("[applySystemDarkMode] failed", e);
        }
      };

      // 监听系统媒体查询（Android 11+ WebView 支持，旧版需 Java 回调兜底）
      try {
        if (window.matchMedia) {
          const mq = window.matchMedia("(prefers-color-scheme: dark)");
          const _onMqChange = function (ev) {
            try {
              const isDark = !!ev.matches;
              window.applySystemDarkMode(isDark);
            } catch (e) {}
          };
          if (typeof mq.addEventListener === "function")
            mq.addEventListener("change", _onMqChange);
          else if (typeof mq.addListener === "function")
            mq.addListener(_onMqChange);
        }
      } catch (e) {}

      // 启动时立即应用一次
      try {
        const t = _resolveTheme();
        _applyThemeToDom(t);
        // 推给 Java：需等待 bridge 注入
        const tryPush = (attempt) => {
          if (
            window.LanPlayNative &&
            typeof window.LanPlayNative.syncPageTheme === "function"
          ) {
            _pushThemeToJava(t);
          } else if (attempt < 8) {
            setTimeout(() => tryPush(attempt + 1), 250);
          } else {
            window.addEventListener("load", () =>
              setTimeout(() => _pushThemeToJava(_resolveTheme()), 100),
            );
          }
        };
        tryPush(0);
        // 若 Java 后续通过 evaluateJavascript 再次推送，会自动覆盖
      } catch (e) {}

      // 沉浸式安全区（保持原逻辑，略）
      try {
        function _applySafeArea() {
          const html = document.documentElement;
          if (!html) return;
          try {
            const probe = document.createElement("div");
            probe.style.cssText =
              "position:fixed;left:-9999px;top:-9999px;width:0;height:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);";
            document.body.appendChild(probe);
            const cs = getComputedStyle(probe);
            html.style.setProperty(
              "--safe-top",
              (parseFloat(cs.paddingTop) || 0) + "px",
            );
            html.style.setProperty(
              "--safe-bottom",
              (parseFloat(cs.paddingBottom) || 0) + "px",
            );
            html.style.setProperty(
              "--safe-left",
              (parseFloat(cs.paddingLeft) || 0) + "px",
            );
            html.style.setProperty(
              "--safe-right",
              (parseFloat(cs.paddingRight) || 0) + "px",
            );
            document.body.removeChild(probe);
          } catch (e) {}
        }
        if (document.readyState === "loading")
          document.addEventListener("DOMContentLoaded", _applySafeArea);
        else _applySafeArea();
        window.addEventListener("resize", _applySafeArea, { passive: true });
        window.addEventListener("orientationchange", _applySafeArea, {
          passive: true,
        });
      } catch (e) {}

      // 点击主题按钮逻辑已移至底部单例 bindThemeToggle()，顶部 IIFE 不再重复绑定，避免双重监听和 DOMContentLoaded 嵌套失效
      try {
        // 保留长按重置到跟随系统的全局方法已在顶部定义
      } catch (e) {}

      // 监听外部事件：当 Java 或其它脚本分发 lanplay:system-theme-changed 时刷新图标
      try {
        window.addEventListener("lanplay:system-theme-changed", () => {
          try {
            if (typeof updateThemeIcon === "function") updateThemeIcon();
          } catch (e) {}
        });
      } catch (e) {}
    })();

    // ============================================================
    // ★ 单文件版：HTML + CSS 已合并进本 JS（由 build_merged.py 生成）
    // ============================================================

    // ---------- 页面元信息（对应原 index.html <head>） ----------
    document.title = "LAN-Play 房间监控";
    // PWA 图标已内嵌在前端；后端会从 script.js 自动读取并还原为 192/512 PNG，部署时无需额外图片文件。
    const PWA_ICON_192_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAADAFBMVEX39u765Nrq6uUBx+X8RlL12dQAAAD7OUkTKDclOUgbM0PV19MG1OsIGSjMyMUwRVPsycYEttgBveLICS3lt7UEqM3a5eQu5/L8/fsGlbjZpafIwr25BCjQiJEEiLNLWGbOurnUlJnSFjUCTGoZMD7FeIaxx8sNV28DmcPzd3pUZXPvK0PUVmniGDgIdqbQRVHr6+jp6eYK4fLUJDsFaZEqGibQOUuFVFd0pbP3UlvohYhF6/KG8fjy8u/a+fTq6+cVRVfq6+fp6ucNdY+0FzTo5+iNqLHGZncpJjLr6+hPRlKvRVEXFBwLxNxOJzTyZWwzV2jtw73UmqLnJTyISE+yOEcNZHn5W2Px8e9NGCmUucOtqKkRLkG31NeSGTDirKs0iKxT8vaztrdyR1Px8u1qFyqwJTra4NsAbKCPJzcQhJon2ukld4pqmqxsKDbw8O4OorpPOUZWlq+Rk5bSK0L03uBteISPsbsnMT1GUl3v8Ox6UlN/f3+F6/GPN0WIio7plJYmlrByOkfmvcCOm6WqvMLHcnztfYOVxM6tl5trWmhpaXR5hIrj4t03UF62KULb29srZ3hLMjtudnuNMTy/v7+7wL71oZ7j490c0ttEiqxxtMeoiI6qqqrx8e0oER6MXWSx6ejSvsAlhZkk1N11xta+dYTMzMxsDiPLSmHM3uDo6Nvi49zl4twptc1acoN95OeyMj7k4t7i4t3//9AWDhkmx9tEqcRbyddqNDu1Z3CwnqHY69jw2tr//7EtTWElb4I9qMNOobtWushO2eSQL0GR0tu8VGKqqv+v8/bRUFnsgX///wD//38GWoARsL81Dx4gLkAge6UgorQkzOQ28PRODSFQcH9ckJhDzuVL099iDx5nEB9kboB3kJ9o2d9r1uSPDyWCenyAfYGAgH2O3OexH0C9TWG8U12/v/+q///f37/f39/d7u7M/8zM///kMT/k39/h39rg39rn3+cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADvvaNSAAABAHRSTlP+/v7///8A//////////////////////8G///////////////////////////////RLv//////////////0f+P/29R//8T////r///////////////////sv//////////////K/////////////+R/////////////3T/Av/////////////////////N//8K/////wT//03/////A1f//////////wf///8UKY3/////bLMF/////////w0OA////////////wP///8BAv///////////////////////////////////wQDCCgPBQX/WJHDIAAAAAAAAAAAAAAAUrC3/AAAHf5JREFUeNrNnYlDU1e+x5NATG5CvAQNJKIEIRhM1CQCaW2HJiFEA0hKlVCplLayOOAGLWWgRbROa+eptdraTqcd7TadttO+aWffl/dm396+7/u+v/cHvLPde8+999wlEJz+WkWDJN/P+f1+5/zOcu+1rDMwv3/Jv3Tdn8u9kwDW1ZXJpFI9cWS2shl6u56eVCqT6eqCn5Pz5970/wJ8tN9In2WdoflzWPipU0D6oUOHOjs7LWti4I3B2x86BQyD5HLG6gwArr+TS8BG7zm0Vqq1WIA/AAVwhX+lAH5kiUxP/OZqpyhAWGXGc89BHSvxwBf9ia5Uzy9JvAjRk+pK+K+U7oHrudz4jVOHLB8AO3Tqxngu5y8JwP+cP/FIKl7qR9lsK5MIOyK978dTj4wDSSUAPOfvSnVaPkAWT3X5v20a4Me58cwhywfLbD1d48xUtrB6n/FHOi0fOOsEYcRAUAO8mes6tTb6NQdiq9VmRb8Rw6+qCFI3ciYAQPMfWivtojqrKVMydB4CTjAAAE5as/CBwtH/JvVjCPyjAkLGr3SCRaF//NSahT/xgq1ECJkfOlPKVLbIy7Y1TV9F3K8IofORhNwHlpunX45gLYUBIAhZDTojGYEMYA3jRwZgLd2kjqnz1DgbYOkmdP8rB6AJHklQeSABXLkJw9cqAKzS2NCZGb+iBvD7u9a+fFgNAGbA9WmXlAYWKgEsH3QAkeDU+DsKgJtU/6wWwCqmgTgciAA3bkb9tmoAYUyId8kBlnJdN6V+loYBqTwQv5ZUXIA0WKIAcuOp0pRY3Spb77aa9oDdvV5p9e7SfJAaz4kA/nX+G6U5wHb42YsRaEFo+CsfOXzUbEl65FJEaYt/t740F9wAsgUAf6KECaTVfWTv488u8jwnNycX2XZH7R3AamvZ+u3Eqhv/Fvy43Diud/7MQ4fr7Uby7YSgM4WHMwzQ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";
    const PWA_ICON_512_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEXe5Nvg3tqkY25TYW/foZ3h3tmkoZ0fDhwhoLHpgH7//wAYYW4V0t1OEB5Y0d77+7QqLkCVK0H//39oLkBsl6OMDyawsP/RND4im8JnrsKy/7IA/wCKfoKZmZnrHkDovLxPbYJ/f/+s/+Xj39oAAP9VVap///+qqlWLgX6n5N7/v//39u765Nrq6uYBx+b8RlEAAAD12dT7OUkTKDcaNEMlOUgF0+vV19MJGSjMyMQxRVMEt9jsycYBveLICCwEqMza5eTmt7Uw5/EEiLHZpqm5BCjQiJHIwr3RFDTUlZr8/PoIlbYQ4vLNu7pJWGbFeIYaMD4CmcMEapPuKkILVW+xx8xI6fMLdZL0Z21UZXPzdXoHd6fON0vUJDvr6+jp6ecsGiby8vDQRlJ0pLMtJjLkGjnniIrq6ufq6+jq6ufV+fYRRVjrwr3r6+jo6OjOVWiNqLH3UluzFzMo2+oKxNzUm6KwRVHoJj0yVmZMR1PPKkXHaXiyN0fa4NyTucMRLUHw8e6509extrcPZHnOcnv3W2Pjq6tPGCmLVVetqKlWNjuOGC9OJzQvh6uUlpgJTGaNR1AUFB2y9/mwJTlSOkVvGCwOpLpvRVBsm6xuJzXy8+1IUly8dHVsc3pR8vaNKDiPOEXa2toPhJpRlK+PsrxvOkUoMT0BbaDw8O167PNnanW9wb4qZ3movcTz3uApd4rrl5bw8ezw8e1sd4QmFR2LiY128feRnKTOS2Krl5pqWGZ4hI6XxMy3KUPmeII4UF2v6ee7am3o6NhIjKzR3uDmvsDj4t3WvsAplrGOMjzk5NwjfKbSU1xwMjw0TmGwnaFytcbj4t2+vr7k490ng5bj4t2qiY6qqqrk491xx9Z/f3+L6e0xpsVQ2eW8doMtt80qxtfMzMxMq8aNWWKF8Pa2VmVuUVz8/dYnbYKsMj1RdISS1NpNDBzDboBw2eMHXYJSxtYzDBol0dtWpLtNuM1tDiOwUVrY2PI58PaNZWzZ6dkpzONVDiFiboCP3OOt2+S8oYTAAAABAHRSTlMeX////57/////Af////8E//8C////A////wMB/wX/Bv8CBMsBAwID//8E/v7+//8A/////////////////////////////////wj/////////////////////////0S7/0f//////To9v////rxL//////////////////////7H/////////////////////////////////LP///////wz///////+R//////////9Ncf///////////////////xL////O////Lf///////48EUP+v/wNu/wL///////8G//////8J////////////////////C///Ef//////m9KFegAAfc9JREFUeNrtvQtAVdeZ902b3qad3i9zf+e9fHc5mMM5hzui4vUQ8YgklMg9NEAJR6NEAaFYsdIoRh1QC8TCoYGxxsaosU1NrY1NE+PUfI1Jx0wuTTL5mqRpp++k10mnM++3nrXW3nutvdfa93MOqItWFIHg+f/2/3nWs9Z6VsaNKRjRK5ejiUQ8Gv99/Hy9Nlpa3tXS0gajFUYHjDpuBK6Kwf+b8D8T/4PxP70FBvOixOPwQsUT0SvPp0KaGzNS8l+5cvnVRBz+XfE4B0DLdQAoABkaAPiFSly+Ep3jAETRuAz/lmgCQY2UH0P/vDH0dqJFGW2a+pr8jXWNjfjXwFU00D+nDv5djQSBbRQBwkCb+oKcwC8QepniiVfx8wJucBleybkHAPzU7BOP/30tbSfJUGTHwm/Do5GOeVf1UP6V5N+M/ulHWo/gcVIZbS0n2KgQx5aQPAKSCAD6seM6p4d/6bZt6j9eFf1akF6EAQsDGegFIr7QoiYHyATOzzkAlMd/TBGfPuzXmtIuuKijKYJCQX194vwb55PmAf4DcOXVj8bPozcIZZz4265rb5OCum0cBGAD58/H428kXo3OfgBQygfi0ye/tVXx/OvPvrP4ACGyYxulgDgBctVEdC4AEK8H8Wlmv+3ai/C+Jot00oggQATEE8/PXgAg7f8/olcSUcj72lrJpO667p5JoLWDVkTA2MX45Sv/+yd8nRZm+CY+nq3Ex+rJ4w/yBwLX9fNh4FISIuAkpAMX61EygILsG35B4AsA0Y++EU1Eo2NjYydI4O/Ydv3Z9zki1HVsO9JKc8KxePT30cTl6GwB4IMfBB7H6kF+HPivq5+crACnAwQBSAhnhQNEb4x+4qPROPL+sRMnTiLrr7tu/cmLBZAOIBs4cQITEL3yfPTGD6YVgGj0VfSDvIGe/nok/8nWI0j/60IlkwFEwBGUDSAE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";
    if (document.documentElement) {
      document.documentElement.setAttribute("lang", "zh-CN");
    }
    if (!document.querySelector('meta[name="viewport"]')) {
      const __vpMeta = document.createElement("meta");
      __vpMeta.name = "viewport";
      __vpMeta.content =
        "width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover";
      document.head.appendChild(__vpMeta);
    }
    // PWA / 添加到桌面元信息（后端页面壳也会提供，这里用于兼容被单独嵌入的前端）。
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifestLink = document.createElement("link");
      manifestLink.rel = "manifest";
      manifestLink.href = "/manifest.webmanifest";
      document.head.appendChild(manifestLink);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      const appleIcon = document.createElement("link");
      appleIcon.rel = "apple-touch-icon";
      appleIcon.href = "/static/pwa-icon-192.png?v=20260808_4";
      document.head.appendChild(appleIcon);
    }
    [
      ["application-name", "LAN-Play"],
      ["mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-status-bar-style", "black-translucent"],
      ["apple-mobile-web-app-title", "LAN-Play"],
    ].forEach(function (entry) {
      if (document.querySelector('meta[name="' + entry[0] + '"]')) return;
      const meta = document.createElement("meta");
      meta.name = entry[0];
      meta.content = entry[1];
      document.head.appendChild(meta);
    });

    // ---------- 注入 CSS（原 styles.css 全文） ----------
    const __styleEl = document.createElement("style");
    __styleEl.id = "lanplay-injected-style";
    __styleEl.textContent = `/* ===== 全局禁用长按选中/复制文字 ===== */
* {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}

/* 允许输入框、聊天气泡、日志等内容正常选中与复制 */
input, textarea, select, .log-content,
.chat-input, #publicChatInput,
/* 仅消息正文可复制；名字、时间禁止选中 */
.chat-msg .msg-body,
.chat-msg .msg-body *,
.chat-msg .chat-media-img,
.chat-msg .chat-media-file-name,
.chat-msg .chat-link {
  -webkit-user-select: text !important;
  -moz-user-select: text !important;
  -ms-user-select: text !important;
  user-select: text !important;
  -webkit-touch-callout: default !important;
}
.chat-msg .msg-sender,
.chat-msg .msg-time,
.chat-msg .msg-footer,
.chat-msg .msg-footer *,
.chat-msg-row .msg-sender {
  -webkit-user-select: none !important;
  -moz-user-select: none !important;
  -ms-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none !important;
}

:root{
  --bg:#dff3ff;--card:rgba(255,255,255,.82);--white:#fff;--ink:#0c3154;--muted:#50728d;
  --blue:#d8effd;--cyan:#19c8ae;--red:#dc3048;--line:rgba(55,130,175,.12);
  --shadow:0 16px 44px rgba(65,136,178,.11);
  --green:#178a78;--green-bg:#dcf6f1;--orange:#e8820c;
  --radius-lg:28px;--radius-md:20px;--radius-sm:14px;
  --font:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --transition:all .25s cubic-bezier(.4,0,.2,1);
}
html.dark{
  --bg:#0f1923;--card:rgba(22,34,46,.85);--white:#16222e;--ink:#e0eef8;
  --muted:#7a9bb5;--blue:#1a3344;--cyan:#2ee6c8;--red:#ff5a6e;
  --line:rgba(255,255,255,.06);--shadow:0 16px 44px rgba(0,0,0,.4);
  --green:#3dd9b8;--green-bg:rgba(61,217,184,.12);--orange:#ffb347;
}
@media (prefers-color-scheme: dark){
  :root:not(.light){
    --bg:#0f1923;--card:rgba(22,34,46,.85);--white:#16222e;--ink:#e0eef8;
    --muted:#7a9bb5;--blue:#1a3344;--cyan:#2ee6c8;--red:#ff5a6e;
    --line:rgba(255,255,255,.06);--shadow:0 16px 44px rgba(0,0,0,.4);
    --green:#3dd9b8;--green-bg:rgba(61,217,184,.12);--orange:#ffb347;
  }
}
*,*::before,*::after{box-sizing:border-box}
html{
  background:var(--bg);
  scroll-behavior:smooth;
}
body{
  margin:0;min-height:100vh;color:var(--ink);font-family:var(--font);
  background:var(--bg);
  transition:background .4s ease,color .4s ease;
  -webkit-tap-highlight-color:transparent;overflow-x:hidden;
}
a{color:inherit;text-decoration:none}
button{font:inherit}
::selection{background:var(--cyan);color:#fff}
.page{width:min(1100px,calc(100%-32px));margin:auto;padding:24px 0 24px;animation:fadeIn .5s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.glass{border:1px solid rgba(255,255,255,.8);background:var(--card);box-shadow:var(--shadow);backdrop-filter:blur(15px);-webkit-backdrop-filter:blur(15px);transition:var(--transition)}
html.dark .glass{border-color:rgba(255,255,255,.05)}
@media (prefers-color-scheme: dark){:root:not(.light) .glass{border-color:rgba(255,255,255,.05)}}

.hero{margin-top:0;min-height:68px;border-radius:var(--radius-lg);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:sticky;top:12px;z-index:100}
.brand-area{
  display:flex;
  align-items:center;
  gap:8px;
  min-width:0;
  flex:1 1 auto;
  overflow-x:auto;
  overflow-y:visible;
  scrollbar-width:none;
  -ms-overflow-style:none;
  -webkit-overflow-scrolling:touch;
  touch-action:pan-x;
  padding:4px 2px;
  margin:-4px -2px;
  min-height:46px;
}
.brand-area::-webkit-scrollbar{display:none}
.brand-area > *{flex-shrink:0; position:relative; box-sizing:border-box;}
/* FIX: 透明边框占位，避免切换border时尺寸变化导致边缘缺失裁切 */
.brand-area > button{
  border:2px solid transparent!important;
  background-clip:padding-box;
  box-sizing:border-box!important;
  position:relative;
  overflow:visible;
  outline:none!important;
  -webkit-tap-highlight-color:transparent;
  /* FIX(长按排序): 让图标按钮自身禁用原生 pan-x 手势。
     .brand-area 是 touch-action:pan-x 的可横向滚动容器，若触摸点允许 pan-x，
     Android 原生横滚层会截获左右拖动并触发 pointercancel，导致长按后必须先往下拖动
     才能排序。把按钮设为 touch-action:none 后，长按即可立即左右拖动排序；
     导航栏整体仍可借助按钮间的空隙/内边距区横向滚动。 */
  touch-action:none;
}
/* 导航栏图标拖拽排序 */
.brand-area > button.nav-dragging{
  opacity:0.38;
  transform:scale(0.92);
  z-index:5;
  filter:grayscale(0.15);
  border-color:transparent!important;
  box-shadow:none!important;
}
.brand-area > button.nav-drag-over{
  border:2px dashed var(--cyan)!important;
  background:rgba(25,200,174,.14)!important;
  box-shadow:inset 0 0 0 1px rgba(25,200,174,.25);
}
html.dark .brand-area > button.nav-drag-over,
:root:not(.light) .brand-area > button.nav-drag-over{
  background:rgba(46,230,200,.18)!important;
  border-color:var(--cyan)!important;
  box-shadow:inset 0 0 0 1px rgba(46,230,200,.25);
}
.brand-area.nav-reordering,
.brand-area.nav-holding{
  touch-action:none;
  overflow-x:auto;
  overflow-y:visible;
}
/* FIX: 导航栏按钮hover上浮会因overflow被裁切，改为仅变亮，不位移 */
.brand-area > button:hover{
  transform:none!important;
  filter:brightness(1.08);
}
.brand-area > button:active{
  transform:scale(0.96)!important;
  filter:brightness(0.96);
}
/* 跟手拖影（fixed，挂在 body 上，不受导航栏裁切） */
.nav-drag-ghost{
  position:fixed;
  width:42px;
  height:42px;
  border-radius:12px;
  display:grid;
  place-items:center;
  font-size:18px;
  font-weight:700;
  pointer-events:none;
  z-index:10050;
  margin:0;
  padding:0;
  border:2px solid rgba(255,255,255,.55);
  background:linear-gradient(145deg,var(--cyan),#14a891);
  color:#fff;
  box-shadow:0 10px 28px rgba(25,200,174,.45),0 2px 8px rgba(0,0,0,.18);
  transform:translate(-50%,-50%) scale(1.08);
  opacity:0.95;
  transition:none;
  line-height:1;
  overflow:visible;
}
html.dark .nav-drag-ghost,
:root:not(.light) .nav-drag-ghost{
  color:#0f1923;
  border-color:rgba(15,25,35,.25);
  box-shadow:0 10px 28px rgba(0,0,0,.5),0 0 0 1px rgba(46,230,200,.35);
}
.nav-drag-ghost .online-count-badge,
.nav-drag-ghost .public-unread-badge{
  display:none!important;
}
.brand{display:flex;align-items:center;gap:12px;min-width:0;cursor:pointer}
.logo{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(145deg,#fff970,#ffd626);box-shadow:inset 0 0 0 2px rgba(255,255,255,.7),0 4px 12px rgba(255,200,40,.25);font-size:16px;animation:pulse 3s ease-in-out infinite;flex-shrink:0}
.plugin-toast{
  position:fixed;left:50%;top:90px;transform:translateX(-50%) translateY(-16px);
  background:linear-gradient(135deg,#19c8ae,#14a891);color:#fff;
  padding:12px 24px;border-radius:12px;font-size:14px;font-weight:700;
  box-shadow:0 8px 28px rgba(25,200,174,.35);z-index:9999;
  opacity:0;pointer-events:none;transition:opacity .3s ease,transform .3s ease;
  white-space:nowrap;
}
.plugin-toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
html.dark .plugin-toast{background:linear-gradient(135deg,#2ee6c8,#1ab89a);color:#0f1923}
@media (prefers-color-scheme: dark){:root:not(.light) .plugin-toast{background:linear-gradient(135deg,#2ee6c8,#1ab89a);color:#0f1923}}
@media (max-width:600px){
  .plugin-toast{font-size:12.5px;padding:10px 18px;top:80px;white-space:normal;text-align:center;max-width:calc(100% - 32px)}
}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}

.hero-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.theme-toggle,.icon-btn{border:0;width:38px;height:38px;border-radius:12px;background:#e1f1fa;color:var(--ink);cursor:pointer;display:grid;place-items:center;font-size:16px;transition:var(--transition);flex-shrink:0}
.theme-toggle:hover,.icon-btn:hover{background:#cce9f9;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08)}
html.dark .theme-toggle,html.dark .icon-btn{background:rgba(255,255,255,.08);color:var(--cyan)}
html.dark .theme-toggle:hover,html.dark .icon-btn:hover{background:rgba(255,255,255,.15)}
@media (prefers-color-scheme: dark){
  :root:not(.light) .theme-toggle,:root:not(.light) .icon-btn{background:rgba(255,255,255,.08);color:var(--cyan)}
  :root:not(.light) .theme-toggle:hover,:root:not(.light) .icon-btn:hover{background:rgba(255,255,255,.15)}
}

/* ===== 公共聊天数字角标（与在线成员一致） ===== */
.public-chat-btn {
  position: relative;
  overflow: hidden;
}
.public-chat-btn .public-chat-icon {
  font-size: 16px;
  line-height: 1;
}
#publicUnreadBadge.zero {
  display: none;
}

/* ===== 在线成员按钮 ===== */
.online-members-btn {
  position: relative;
  overflow: hidden; /* 角标限制在图标内 */
}
.online-members-btn .online-icon {
  font-size: 16px;
  line-height: 1;
}
.online-count-badge {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--cyan);
  color: #fff;
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  text-align: center;
  box-shadow: none;
  pointer-events: none;
  z-index: 2;
  transition: transform .2s ease, opacity .2s ease;
}
.online-count-badge.zero {
  opacity: 0.55;
  background: var(--muted);
  box-shadow: none;
}
html.dark .online-count-badge {
  color: #0f1923;
}
html.dark .online-count-badge.zero {
  color: #fff;
  background: rgba(255,255,255,.25);
}

/* ===== 在线成员列表 ===== */
.online-members-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.online-member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(125,175,210,.06);
  transition: background .2s;
}
.online-member-item:hover {
  background: rgba(125,175,210,.12);
}
.online-member-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--cyan), #14a891);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 800;
  flex-shrink: 0;
  overflow: hidden;
  cursor: default;
  position: relative;
}
.online-member-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 50%;
}
.online-member-avatar.is-me {
  cursor: pointer;
  box-shadow: 0 0 0 2px rgba(25,200,174,.35);
}
.online-member-name.is-me-name {
  cursor: pointer;
  color: var(--ink);
}
.online-member-name.is-me-name:hover {
  color: var(--cyan);
}
/* Telegram 风格消息行：对方左对齐+头像，自己右对齐无头像 */
.chat-msg-row {
  display: flex;
  width: 100%;
  max-width: 100%;
  align-items: flex-end;
  gap: 8px;
  margin: 3px 0;
  box-sizing: border-box;
}
.chat-msg-row-other {
  justify-content: flex-start;
  flex-direction: row;
  padding-right: 18%;
}
.chat-msg-row-mine {
  justify-content: flex-end;
  flex-direction: row;
  padding-left: 18%;
}
.chat-msg-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  background: linear-gradient(135deg, var(--cyan), #14a891);
  cursor: pointer;
  align-self: flex-end;
  margin-bottom: 2px;
  box-shadow: 0 1px 4px rgba(0,0,0,.12);
}
.chat-msg-avatar-fallback {
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  cursor: default;
}
.chat-msg-row .chat-msg {
  flex: 0 1 auto;
  width: fit-content;
  max-width: 100%;
  margin: 0;
}
.chat-msg-row-mine .chat-msg {
  align-self: flex-end;
}
.chat-msg-row-other .chat-msg {
  align-self: flex-start;
}
.chat-msg-row .msg-sender {
  display: block;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--cyan);
  margin: 0 0 2px;
  line-height: 1.2;
}
.chat-msg-row-mine .msg-sender { display: none; }
.avatar-crop-modal {
  position: fixed; inset: 0; z-index: 10060;
  background: rgba(0,0,0,.72); backdrop-filter: blur(4px);
  display: none; align-items: center; justify-content: center;
  padding: 16px;
}
.avatar-crop-modal.open { display: flex; }
.avatar-crop-box {
  width: min(360px, calc(100vw - 32px));
  background: var(--white);
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.avatar-crop-header {
  padding: 12px 16px; font-weight: 800; font-size: 15px;
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--line);
}
.avatar-crop-stage {
  position: relative;
  width: 100%;
  height: 300px;
  background: #0b131a;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
.avatar-crop-img {
  position: absolute;
  left: 50%; top: 50%;
  transform-origin: center center;
  will-change: transform;
  pointer-events: none;
  max-width: none;
}
.avatar-crop-mask {
  position: absolute; inset: 0;
  pointer-events: none;
  background: rgba(0,0,0,.45);
  -webkit-mask-image: radial-gradient(circle 110px at center, transparent 99%, #000 100%);
  mask-image: radial-gradient(circle 110px at center, transparent 99%, #000 100%);
}
.avatar-crop-ring {
  position: absolute; left: 50%; top: 50%;
  width: 220px; height: 220px;
  margin: -110px 0 0 -110px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,.9);
  box-shadow: 0 0 0 1px rgba(0,0,0,.25);
  pointer-events: none;
}
.avatar-crop-hint {
  text-align: center; font-size: 12px; color: var(--muted);
  padding: 8px 12px 0;
}
.avatar-crop-actions {
  display: flex; gap: 10px; padding: 12px 16px 16px;
}
.avatar-crop-actions button {
  flex: 1; border: 0; border-radius: 12px; padding: 11px;
  font-weight: 800; cursor: pointer; font-size: 14px;
}
.avatar-crop-cancel { background: rgba(125,175,210,.15); color: var(--ink); }
.avatar-crop-ok { background: var(--cyan); color: #fff; }

.online-member-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.online-member-name {
  font-size: 14px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-member-id {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-member-id.is-me-id {
  cursor: pointer;
  color: var(--muted);
}
.online-member-id.is-me-id:hover {
  color: var(--cyan);
}
.online-member-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 0 3px rgba(25,200,174,.15);
  flex-shrink: 0;
}
.online-members-empty {
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  padding: 28px 12px;
}
html.dark .online-member-item {
  background: rgba(255,255,255,.04);
}
html.dark .online-member-item:hover {
  background: rgba(255,255,255,.08);
}

.dot{width:12px;height:12px;border-radius:50%;background:#19c8ae;box-shadow:0 0 0 6px rgba(25,200,174,.13);animation:pulse-dot 2s ease-in-out infinite;flex-shrink:0}
.dot.online{background:#19c8ae;box-shadow:0 0 0 6px rgba(25,200,174,.15)}
.dot.offline{background:#dc3048;box-shadow:0 0 0 6px rgba(220,48,72,.15);animation:none}
.dot.checking{background:#e8820c;box-shadow:0 0 0 6px rgba(232,130,12,.12)}
@keyframes pulse-dot{0%,100%{box-shadow:0 0 0 6px rgba(25,200,174,.13)}50%{box-shadow:0 0 0 10px rgba(25,200,174,.06)}}

.scan{display:flex;align-items:center;gap:10px;color:var(--muted);font-weight:700;font-size:13px;flex-shrink:0;justify-content:flex-end}
.refresh{border:0;border-radius:12px;padding:10px 18px;background:#e1f1fa;color:var(--ink);font-weight:750;cursor:pointer;font-size:13.5px;transition:var(--transition);display:inline-flex;align-items:center;gap:6px}
.refresh:hover{background:#cce9f9;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08)}
.refresh:active{transform:translateY(0)}
.refresh.loading{pointer-events:none;opacity:.7}
.refresh .spinner{width:14px;height:14px;border:2.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;display:none}
.refresh.loading .spinner{display:block}
.refresh.loading .refresh-text::before{content:'刷新中'}
.refresh.loading .refresh-text span{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
html.dark .refresh{background:rgba(255,255,255,.08);color:var(--ink)}
html.dark .refresh:hover{background:rgba(255,255,255,.15)}
@media (prefers-color-scheme: dark){:root:not(.light) .refresh{background:rgba(255,255,255,.08);color:var(--ink)}:root:not(.light) .refresh:hover{background:rgba(255,255,255,.15)}}

.log-modal{position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(5px);display:none;align-items:center;justify-content:center;z-index:1000}
.log-modal.open{display:flex}
.log-box{background:var(--white);width:min(800px,calc(100% - 32px));height:500px;border-radius:var(--radius-md);box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line)}
.log-header{padding:14px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);font-weight:800;font-size:15px}
.log-autoscroll-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  font-weight: 600;
  color: var(--muted);
  background: rgba(125,175,210,.12);
  padding: 4px 10px;
  border-radius: 12px;
  transition: var(--transition);
}
.log-autoscroll-toggle:hover {
  background: rgba(125,175,210,.22);
  color: var(--ink);
}
html.dark .log-autoscroll-toggle,
:root:not(.light) .log-autoscroll-toggle {
  background: rgba(255,255,255,.08);
  color: #a8bfca;
}
html.dark .log-autoscroll-toggle:hover,
:root:not(.light) .log-autoscroll-toggle:hover {
  background: rgba(255,255,255,.16);
  color: #fff;
}
.log-close{background:none;border:0;font-size:18px;cursor:pointer;color:var(--muted)}
.log-content{flex:1;padding:16px;background:#0b131a;color:#3dd9b8;font-family:monospace;font-size:12.5px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.5}

.overview{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}
.ov-card{padding:18px 10px;background:var(--white);border-radius:var(--radius-md);box-shadow:0 6px 20px rgba(82,142,178,.06);text-align:center;transition:var(--transition);min-width:0}
.ov-card:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(82,142,178,.1)}
.ov-card span{display:block;color:var(--muted);font-size:11.5px;font-weight:600;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ov-card b{font-size:24px;font-weight:900}
.ov-card.online b{color:#2b8a6f}.ov-card.idle b{color:#b8860b}.ov-card.rooms b{color:#1a73c0}.ov-card.servers b{color:#6f42c1}
html.dark .ov-card.online b{color:#3dd9b8}html.dark .ov-card.idle b{color:#ffb347}html.dark .ov-card.rooms b{color:#7ab8ff}html.dark .ov-card.servers b{color:#c4a7ff}
@media (prefers-color-scheme: dark){
  :root:not(.light) .ov-card.online b{color:#3dd9b8}
  :root:not(.light) .ov-card.idle b{color:#ffb347}
  :root:not(.light) .ov-card.rooms b{color:#7ab8ff}
  :root:not(.light) .ov-card.servers b{color:#c4a7ff}
}

.server-list{margin-top:18px;display:grid;gap:12px;contain:layout style}

/* ===== 服务器卡片（含滑动） ===== */
.server-group{
  position: relative;
  background:var(--white);
  border-radius:var(--radius-md);
  /* 修复：原先使用 filter: drop-shadow，深色模式下会在卡片圆角、左右边缘和卡片间距处形成明显黑色块/黑色背景。
     改为更轻的 box-shadow + 细边框，保留层次感，同时避免截图中圈出的黑边。 */
  filter:none;
  box-shadow:0 6px 18px rgba(82,142,178,.06), inset 0 0 0 1px rgba(55,130,175,.08);
  overflow:hidden;
  will-change:auto;
  contain:layout style paint;
  cursor:grab;
  transition: box-shadow 0.25s ease, transform 0.25s ease, background 0.25s ease;
  touch-action:pan-y;
}
.server-group:active{cursor:grabbing}
.server-group:hover {
  filter:none;
  box-shadow:0 10px 24px rgba(82,142,178,.10), inset 0 0 0 1px rgba(55,130,175,.10);
}
.server-group.dragging{
  opacity:0.4;
  transform:scale(0.98);
  filter:none;
  box-shadow:0 14px 28px rgba(0,0,0,0.12), inset 0 0 0 1px rgba(25,200,174,.20);
  border-radius:var(--radius-md) !important;
  overflow:hidden;
}
.server-group.drag-over{border:2px dashed var(--cyan);background:rgba(25,200,174,.05)}

html.dark .server-group {
  filter:none;
  box-shadow:0 1px 0 rgba(255,255,255,.035), inset 0 0 0 1px rgba(255,255,255,.045);
}
html.dark .server-group:hover {
  filter:none;
  box-shadow:0 2px 10px rgba(46,230,200,.06), inset 0 0 0 1px rgba(46,230,200,.10);
}
html.dark .server-group.dragging {
  filter:none;
  box-shadow:0 10px 22px rgba(0,0,0,.22), inset 0 0 0 1px rgba(46,230,200,.22);
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .server-group {
    filter:none;
    box-shadow:0 1px 0 rgba(255,255,255,.035), inset 0 0 0 1px rgba(255,255,255,.045);
  }
  :root:not(.light) .server-group:hover {
    filter:none;
    box-shadow:0 2px 10px rgba(46,230,200,.06), inset 0 0 0 1px rgba(46,230,200,.10);
  }
  :root:not(.light) .server-group.dragging {
    filter:none;
    box-shadow:0 10px 22px rgba(0,0,0,.22), inset 0 0 0 1px rgba(46,230,200,.22);
  }
}

/* 动作层（右侧按钮） - 默认隐藏，滑动后显示 */
.server-actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--server-action-width, 160px);
  display: flex;
  flex-direction: row;
  align-items: stretch;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  overflow: hidden;
  /* 底层也铺与两个按钮一致的颜色，消除 WebView 合成时可能出现的 1px 透明缝。 */
  background: linear-gradient(to right, #1a73c0 0 50%, var(--red) 50% 100%);
  pointer-events: none;
  opacity: 0;
  transform: translateX(100%);
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.server-group.swipe-open .server-actions {
  pointer-events: auto;
  opacity: 1;
  transform: translateX(0);
}

.action-btn {
  flex: 1;
  border: 0;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  touch-action: manipulation;
}
.action-btn:active {
  opacity: 0.8;
}
.action-edit {
  background: #1a73c0;
}
.action-edit:hover {
  background: #155a9b;
}
.action-delete {
  background: var(--red);
}
.action-delete:hover {
  background: #b0243a;
}

/* 卡片内容容器 */
.server-card-inner {
  position: relative;
  background: var(--white);
  border-radius: var(--radius-md);
  transition: transform 0.3s cubic-bezier(.4,0,.2,1);
  will-change: transform;
  z-index: 1;
  touch-action: pan-y;
}
.server-group.swipe-open .server-card-inner {
  transform: translateX(calc(0px - var(--server-action-width, 160px)));
  /* 展开后内容层与操作按钮拼接处必须是直角；保留圆角会在上下两端露出底色。 */
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}

/* ===== 地区 / 类型标签：同一列左缘对齐（与名称、地址上下齐） ===== */
.server-tags {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  margin: 1px 0 0;
  max-width: 100%;
  min-width: 0;
  pointer-events: none;
}
.card-region,
.server-type-badge {
  display: block;
  box-sizing: border-box;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .3px;
  line-height: 1.35;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  pointer-events: none;
}
.card-region {
  color: var(--green);
}
.server-type-badge.builtin {
  color: var(--orange);
}
.server-type-badge.remote {
  color: #1a73c0;
}
.server-type-badge.manual {
  color: var(--cyan);
}

/* ===== 服务器卡片头部 ===== */
.server-head{
  position: relative;
  display:flex;
  align-items:stretch;
  gap:14px;
  padding:22px 22px 18px;
  cursor:pointer;
  user-select:none;
  -webkit-tap-highlight-color:transparent;
  touch-action:manipulation
}
.server-head:hover{background:rgba(125,175,210,.06)}
html.dark .server-head:hover{background:rgba(255,255,255,.03)}
@media (prefers-color-scheme: dark){:root:not(.light) .server-head:hover{background:rgba(255,255,255,.03)}}

.server-status-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;position:relative;align-self:center;display:block;margin:0}
.server-status-dot.online{background:#19c8ae;box-shadow:0 0 0 4px rgba(25,200,174,.15);animation:server-pulse-online 2s ease-in-out infinite}
.server-status-dot.offline{background:#dc3048;box-shadow:0 0 0 4px rgba(220,48,72,.12);animation:none}
.server-status-dot.checking{background:#e8820c;box-shadow:0 0 0 4px rgba(232,130,12,.12);animation:pulse-dot 1.5s ease-in-out infinite}
@keyframes server-pulse-online{0%,100%{box-shadow:0 0 0 4px rgba(25,200,174,.15),0 0 0 0 rgba(25,200,174,.25)}50%{box-shadow:0 0 0 8px rgba(25,200,174,.08),0 0 12px 4px rgba(25,200,174,.2)}}

.server-info {
  flex: 1;
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
  align-self: stretch;
  padding: 0;
}

/* ========== 新增省略号通用类 ========== */
.ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  display: inline-block;
  max-width: 100%;
  vertical-align: middle;
}

.server-name,
.server-address,
.game-name,
.host-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  display: inline-block;
  max-width: 100%;
  vertical-align: middle;
}
/* 移除旧的双副本滚动相关样式 */
.scroll-wrapper,
.server-name .scroll-wrapper,
.server-address .scroll-wrapper,
.game-name .scroll-wrapper,
.host-name .scroll-wrapper {
  display: none !important;
}

/* ===== 原有服务器名称和地址样式（继承 ellipsis） ===== */
.server-name {
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
  user-select: text;
  padding: 0;
  margin: 0;
  border-radius: 0;
  transition: var(--transition);
  line-height: 1.4;
}
.server-name:hover {
  background: rgba(125,175,210,.08);
  border-radius: 6px;
  padding: 0 8px;
  margin: 0 -8px;
}

.server-address {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  padding: 0;
  margin: 0;
  cursor: pointer;
  user-select: text;
  border-radius: 6px;
  transition: var(--transition);
  line-height: 1.4;
}
.server-address:hover {
  background: rgba(125,175,210,.08);
  color: var(--ink);
  border-radius: 6px;
  padding: 0 8px;
  margin: 0 -8px;
}
.server-address:active {
  background: rgba(25,200,174,.15);
  border-radius: 6px;
  padding: 0 8px;
  margin: 0 -8px;
}

.server-stats{display:grid;grid-template-columns:repeat(4,1fr);width:280px;gap:8px;align-items:center;flex-shrink:0}
.stat-item{display:flex;flex-direction:column;align-items:center;text-align:center;min-width:0}
.stat-item span{display:block;font-size:10.5px;color:var(--muted);font-weight:600;margin-bottom:2px;line-height:1.3}
.stat-item b{font-size:18px;font-weight:900;line-height:1.3;height:auto;display:flex;align-items:center;justify-content:center}
.stat-item.online b{color:#2b8a6f} .stat-item.idle b{color:#b8860b} .stat-item.rooms b{color:#1a73c0}
html.dark .stat-item.online b{color:#3dd9b8}html.dark .stat-item.idle b{color:#ffb347}html.dark .stat-item.rooms b{color:#7ab8ff}
@media (prefers-color-scheme: dark){
  :root:not(.light) .stat-item.online b{color:#3dd9b8}
  :root:not(.light) .stat-item.idle b{color:#ffb347}
  :root:not(.light) .stat-item.rooms b{color:#7ab8ff}
}
/* 延迟与其它统计项对齐，数字字号一致 */
.stat-item.latency{
  align-items:center;
  justify-content:center;
}
.stat-item.latency b,
.stat-item.latency .latency-badge{
  font-size:18px;
  font-weight:900;
  line-height:1.3;
  height:auto;
  display:flex;
  align-items:center;
  justify-content:center;
  background:transparent!important;
}
.latency-badge.fast{color:#17776b}
.latency-badge.normal{color:var(--muted)}
.latency-badge.slow{color:#a52639}
.latency-badge.error{color:var(--muted);font-weight:900}
html.dark .latency-badge.fast{color:#3dd9b8}
html.dark .latency-badge.slow{color:#ff5a6e}
@media (prefers-color-scheme: dark){
  :root:not(.light) .latency-badge.fast{color:#3dd9b8}
  :root:not(.light) .latency-badge.slow{color:#ff5a6e}
}

/* ===== 服务器卡片新消息数字角标：卡片右上角 ===== */
.unread-indicator {
  position: absolute;
  top: 6px;
  right: 8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--cyan);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  line-height: 16px;
  text-align: center;
  box-shadow: none;
  flex-shrink: 0;
  display: none;
  pointer-events: none;
  z-index: 3;
}
html.dark .unread-indicator {
  color: #0f1923;
}

.server-body{display:grid;grid-template-rows:0fr;overflow:hidden;transition:none}
.server-body > .body-inner{overflow:hidden;min-height:0}
.server-group.open .server-body{grid-template-rows:1fr;overflow:visible}
/* 展开区内边距缩小，房间更贴近卡片边缘；顶部分割线与收起态边线一致 */
.server-group.open .server-body > .body-inner{padding:0 10px 10px;overflow:visible}

/* 服务器错误角标：卡片顶部居中，无背景，红色文字 */
.server-error-badge {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(70%, 280px);
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 0;
  background: transparent;
  color: var(--red);
  font-size: 11px;
  font-weight: 800;
  line-height: 18px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: none;
  pointer-events: none;
  z-index: 4;
  display: none;
}
.server-error-badge.show {
  display: block;
}
html.dark .server-error-badge {
  color: #ff5a6e;
  background: transparent;
  box-shadow: none;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .server-error-badge {
    color: #ff5a6e;
    background: transparent;
    box-shadow: none;
  }
}
@media (max-width:600px) {
  .server-error-badge {
    top: 4px;
    max-width: min(72%, 220px);
    height: 16px;
    line-height: 16px;
    font-size: 10px;
    padding: 0 2px;
  }
}
/* 兼容旧版横幅错误（若残留则隐藏） */
.server-error { display: none !important; }

.room-list{display:grid;gap:10px;margin-top:6px;margin-bottom:0}
.room-item{padding:16px 18px;border-radius:16px;background:var(--card);box-shadow:0 4px 14px rgba(82,142,178,.05);transition:transform .15s ease,box-shadow .15s ease;contain:layout style paint;max-width:100%;overflow:hidden}
.room-item:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(82,142,178,.09)}

.room-top {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 12px;
  flex-wrap: nowrap;
}

.room-game-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}
.room-icon {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
  background: #34495e;
}

.game-name {
  font-size: 12.5px;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 999px;
  background: #e9f5fb;
  color: #326887;
  /* 继承 ellipsis 特性，已用 .ellipsis 类 */
}
.game-name.copy-game-id {
  cursor: pointer;
  border: 1px dashed var(--red);
  transition: var(--transition);
  /* 未收录标题：直接显示 16 位标题 ID，用等宽字体便于辨认/核对 */
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  letter-spacing: .2px;
}
.game-name.copy-game-id:hover {
  background: rgba(220,48,72,.15);
  transform: scale(1.02);
}
.game-name.no-copy {
  cursor: default;
  border: 1px solid var(--line);
  opacity: 0.7;
}
html.dark .game-name {
  background: rgba(97,194,233,.12);
  color: #7dd3fc;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .game-name {
    background: rgba(97,194,233,.12);
    color: #7dd3fc;
  }
}

.room-meta {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
  align-items: center;
  margin-top: 8px;
  font-size: 13px;
  color: #376482;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
}
.room-meta > * {
  white-space: nowrap;
  flex-shrink: 0;
}
.room-meta .green {
  color: var(--green);
  font-weight: 750;
}
.room-meta .red {
  color: var(--red);
  font-weight: 800;
}

.room-host-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 120px;
  overflow: hidden;
  white-space: nowrap;
  flex: 0 1 auto;
  flex-shrink: 1;
  flex-grow: 0;
  min-width: 0;
}
.host-icon-fixed {
  flex-shrink: 0;
  font-size: 15px;
}
.host-name {
  display: inline-block;
  overflow: hidden;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}

/* 移除旧的滚动动画 */
@keyframes marquee-dual {
  /* 已废弃 */
}

/* 其他原有样式保持不变... */
.room-players{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.room-players .player{
  padding:3px 10px;border-radius:999px;background:var(--green-bg);color:#17776b;
  font-size:11.5px;font-weight:600;
  white-space:normal;
  word-break:break-word;
  flex-shrink:0;
}
html.dark .room-players .player{background:rgba(61,217,184,.12);color:#3dd9b8}
@media (prefers-color-scheme: dark){:root:not(.light) .room-players .player{background:rgba(61,217,184,.12);color:#3dd9b8}}

.no-rooms{padding:20px;text-align:center;color:var(--muted);font-size:13px;background:rgba(125,175,210,.04);border-radius:14px;margin-top:8px}
.skeleton{height:60px;border-radius:14px;background:linear-gradient(100deg,#f0f6fa 20%,#e2eef5 38%,#f0f6fa 56%);background-size:300% 100%;animation:shine 1.4s infinite;margin-top:8px}
html.dark .skeleton{background:linear-gradient(100deg,#1a2530 20%,#243240 38%,#1a2530 56%);background-size:300% 100%}
@media (prefers-color-scheme: dark){:root:not(.light) .skeleton{background:linear-gradient(100deg,#1a2530 20%,#243240 38%,#1a2530 56%);background-size:300% 100%}}
@keyframes shine{to{background-position-x:-100%}}

.filters{display:flex;gap:8px;overflow-x:auto;padding:14px 0 4px;scrollbar-width:none}
.filters::-webkit-scrollbar{display:none}
.filter-tab{flex:0 0 auto;border:0;border-radius:999px;padding:9px 18px;background:#e8f3f9;color:var(--ink);font-weight:700;cursor:pointer;font-size:13px;transition:var(--transition);white-space:nowrap}
.filter-tab:hover{background:#d8eaf3}
.filter-tab.active{
  background:#cde9fa;
  color:#0c5d91;
  font-weight:800;
  filter:none;
  box-shadow:none;
}
html.dark .filter-tab{background:rgba(255,255,255,.06)}
html.dark .filter-tab:hover{background:rgba(255,255,255,.10)}
html.dark .filter-tab.active{
  background:rgba(97,194,233,.20);
  color:#7dd3fc;
  filter:none;
  box-shadow:none;
}
@media (prefers-color-scheme: dark){
  :root:not(.light) .filter-tab{background:rgba(255,255,255,.06)}
  :root:not(.light) .filter-tab:hover{background:rgba(255,255,255,.10)}
  :root:not(.light) .filter-tab.active{
    background:rgba(97,194,233,.20);
    color:#7dd3fc;
    filter:none;
    box-shadow:none;
  }
}

.custom-modal{position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(5px);display:none;align-items:center;justify-content:center;z-index:1000}
.custom-modal.open{display:flex}
.custom-modal-box{background:var(--white);width:min(450px,calc(100% - 32px));border-radius:var(--radius-md);box-shadow:var(--shadow);overflow:hidden;border:1px solid var(--line);animation:fadeIn .25s ease}
.custom-modal-header{padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);font-weight:800;font-size:15px}
.custom-modal-close{background:none;border:0;font-size:18px;cursor:pointer;color:var(--muted)}
.custom-modal-body{padding:20px}
.form-grid{display:grid;gap:12px;margin-top:4px}
.form-row input,.form-row select{width:100%;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:13.5px;outline:none;transition:var(--transition)}
.form-row input:focus,.form-row select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(25,200,174,.15)}
.form-row-group{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.submit-btn{width:100%;border:0;border-radius:12px;padding:12px;background:var(--cyan);color:#fff;font-weight:800;cursor:pointer;font-size:14px;transition:var(--transition);margin-top:4px;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.submit-btn:hover{opacity:.9;transform:translateY(-1px)}
.submit-btn:disabled{opacity:.6;cursor:not-allowed;transform:none}
.submit-btn .spinner{width:14px;height:14px;border:2.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;display:none}
.submit-btn.loading .spinner{display:block}

/* ===== 环境变量设置模态框 ===== */
.env-settings-box{width:min(560px,calc(100% - 32px));height:88vh;height:88dvh;max-height:760px;display:flex;flex-direction:column;overflow:hidden}
.env-settings-body{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:scroll;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;padding:14px 20px 20px;display:flex;flex-direction:column;gap:14px}
/* 每一块保持内容实际高度，避免 CSS Grid/弹性压缩把 R2 表单裁掉却不产生滚动条 */
.env-settings-body>*{flex:0 0 auto}
.env-file-hint{
  font-size:12px;color:var(--muted);line-height:1.5;word-break:break-all;
  background:rgba(125,175,210,.08);border:1px dashed var(--line);
  border-radius:10px;padding:8px 12px;
}
.env-section{
  border:1px solid var(--line);border-radius:14px;overflow:hidden;
  background:rgba(125,175,210,.04);
}
.env-section-title{
  display:flex;align-items:center;gap:8px;
  padding:10px 14px;font-weight:800;font-size:13.5px;
  background:rgba(125,175,210,.10);
  border-bottom:1px solid var(--line);
}
.env-section .form-grid{padding:12px 14px 14px;gap:10px}
.env-field-label{display:block;font-size:11.5px;color:var(--muted);font-weight:700;margin-bottom:4px}
.env-field-label .env-field-key{font-family:monospace;opacity:.85}
.env-field{width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:13px;outline:none;transition:var(--transition)}
.env-field:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(25,200,174,.15)}
.env-save-tip{font-size:11.5px;color:var(--muted);line-height:1.5}
html.dark .env-section{background:rgba(255,255,255,.03)}
html.dark .env-section-title{background:rgba(255,255,255,.07)}

/* ===== Toast ===== */
.global-copy-toast {
  position: fixed;
  left: 50%;
  top: 80px;
  transform: translateX(-50%) translateY(-12px);
  z-index: 9999;
  pointer-events: none;
  opacity: 0;
  transition: opacity .25s ease, transform .25s ease;
  background: linear-gradient(135deg, #19c8ae, #14a891);
  color: #fff;
  padding: 10px 22px;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 700;
  box-shadow: 0 8px 28px rgba(25, 200, 174, .35);
  white-space: normal;
  max-width: min(90vw, 400px);
  word-wrap: break-word;
  text-align: center;
}
.global-copy-toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.global-copy-toast.success {
  background: linear-gradient(135deg, #19c8ae, #14a891);
}
.global-copy-toast.error {
  background: linear-gradient(135deg, #dc3048, #b0243a);
  box-shadow: 0 8px 28px rgba(220, 48, 72, .35);
}
html.dark .global-copy-toast {
  background: linear-gradient(135deg, #2ee6c8, #1ab89a);
  color: #0f1923;
}
html.dark .global-copy-toast.error {
  background: linear-gradient(135deg, #ff5a6e, #cc3048);
  color: #fff;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .global-copy-toast {
    background: linear-gradient(135deg, #2ee6c8, #1ab89a);
    color: #0f1923;
  }
  :root:not(.light) .global-copy-toast.error {
    background: linear-gradient(135deg, #ff5a6e, #cc3048);
    color: #fff;
  }
}
@media (max-width:600px) {
  .global-copy-toast {
    font-size: 12.5px;
    padding: 8px 16px;
    top: 72px;
    max-width: 92vw;
  }
}

footer{text-align:center;padding:24px 16px 8px;color:#55758c;font-size:12px;line-height:1.9;margin-top:12px}
html.dark footer{color:var(--muted)}
@media (prefers-color-scheme: dark){:root:not(.light) footer{color:var(--muted)}}

/* ===== DPI 调节模态框 ===== */
.dpi-modal {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(4px);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dpi-modal.open {
  display: flex;
}
.dpi-modal-box {
  background: var(--white);
  width: min(320px, calc(100% - 32px));
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
  overflow: hidden;
  border: 1px solid var(--line);
  animation: fadeIn .2s ease;
}
.dpi-modal-header {
  padding: 14px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--line);
  font-weight: 800;
  font-size: 15px;
}
.dpi-modal-close {
  background: none;
  border: 0;
  font-size: 18px;
  cursor: pointer;
  color: var(--muted);
  padding: 0 4px;
}
.dpi-modal-body {
  padding: 24px 20px 20px;
}
.dpi-slider-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
#dpiLabel {
  font-size: 20px;
  font-weight: 800;
  color: var(--cyan);
}
#dpiSlider {
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--line);
  border-radius: 3px;
  outline: none;
  transition: background .2s;
}
#dpiSlider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--cyan);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(25,200,174,.3);
}
#dpiSlider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--cyan);
  cursor: pointer;
  border: 0;
}
html.dark #dpiSlider {
  background: rgba(255,255,255,.15);
}
html.dark #dpiSlider::-webkit-slider-thumb {
  background: var(--cyan);
}
html.dark #dpiSlider::-moz-range-thumb {
  background: var(--cyan);
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) #dpiSlider {
    background: rgba(255,255,255,.15);
  }
  :root:not(.light) #dpiSlider::-webkit-slider-thumb {
    background: var(--cyan);
  }
  :root:not(.light) #dpiSlider::-moz-range-thumb {
    background: var(--cyan);
  }
}

.dpi-reset-btn {
  margin-top: 4px;
  padding: 8px 20px;
  border: 0;
  border-radius: 12px;
  background: var(--cyan);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: var(--transition);
  width: 100%;
  max-width: 200px;
}
.dpi-reset-btn:hover {
  opacity: 0.85;
  transform: translateY(-1px);
}
.dpi-reset-btn:active {
  transform: scale(0.97);
}
html.dark .dpi-reset-btn {
  background: var(--cyan);
  color: #0f1923;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .dpi-reset-btn {
    background: var(--cyan);
    color: #0f1923;
  }
}

/* ===== 响应式 ===== */
@media (max-width:900px){
  .page{width:calc(100% - 20px);padding-top:14px}
  .hero{border-radius:20px;padding:10px 14px;gap:10px}
  .brand-area{min-width:0;flex:1 1 auto}
  .scan{font-size:12px;flex-shrink:0}
  .ov-card{padding:14px 6px}
  .ov-card b{font-size:20px}
  .server-head{padding:14px 16px;gap:10px}
  .server-stats{width:250px;gap:6px;align-items:center}
  .server-info{align-self:stretch;padding:0}
  .server-name{font-size:14.5px}
  .server-address{font-size:11.5px}
  .stat-item b{height:auto;line-height:1.3}
}
@media (max-width:600px){
  .page{width:calc(100% - 14px);padding:10px 0 16px}
  .hero{border-radius:16px;padding:8px 10px;gap:6px;position:sticky;top:6px}
  .brand-area{min-width:0;flex:1 1 auto;gap:6px}
  .brand strong{font-size:15px}
  .brand small{display:none}
  .logo{width:34px;height:34px;border-radius:10px;font-size:16px}
  .theme-toggle,.icon-btn{width:34px;height:34px;border-radius:10px;font-size:14px}
  .scan{margin-top:0;font-size:11.5px;flex-shrink:0}
  .scan .refresh{flex:0 0 auto;padding:7px 12px;font-size:12px}
  .overview{grid-template-columns:repeat(4,1fr);gap:5px;margin-top:14px}
  .ov-card{padding:10px 2px;border-radius:12px}
  .ov-card b{font-size:16px}
  .ov-card span{font-size:10px}
  .server-list{margin-top:14px;gap:10px}
  .server-head{padding:12px 14px;gap:8px;flex-wrap:nowrap}
  .server-status-dot{width:10px;height:10px;align-self:center;display:block;flex-shrink:0}
  .server-info{align-self:stretch;padding:0}
  .server-name{font-size:13.5px}
  .server-address{font-size:11px}
  .server-stats{width:210px;gap:4px;align-items:center}
  .server-stats .stat-item span{font-size:9.5px}
  .server-stats .stat-item b,
  .server-stats .stat-item.latency b,
  .server-stats .stat-item.latency .latency-badge{
    font-size:15px;
    height:auto;
    line-height:1.3;
  }
  .server-group.open .server-body{padding:0}
  .server-group.open .server-body > .body-inner{padding:0 8px 8px}
  .room-list{gap:8px;margin-top:6px}
  .room-item{padding:14px;border-radius:14px}
  .room-game-left .game-name{font-size:11px;padding:3px 10px;flex:0 1 auto;max-width:100%}
  .room-host-meta{max-width:100px;flex-shrink:1}
  .room-meta{font-size:12px;gap:6px;flex-wrap:nowrap}
  .room-players{gap:4px}
  .room-players .player{font-size:10.5px;padding:2px 8px;white-space:normal;word-break:break-word}
  .filters{padding:10px 0 2px}
  .filter-tab{padding:7px 14px;font-size:12px}
}
@media (max-width:380px){
  .brand strong{font-size:14px}
  .logo{width:30px;height:30px;font-size:14px}
  .theme-toggle,.icon-btn{width:30px;height:30px;font-size:12px}
  .scan{font-size:10.5px;gap:6px}
  .scan .refresh{padding:6px 10px;font-size:11px}
  .server-stats{grid-template-columns:repeat(3,1fr);width:150px;align-items:center}
  .server-stats .stat-item.idle{display:none}
  .server-name{font-size:12.5px}
  .server-address{font-size:10px}
  .room-game-left .game-name{font-size:10.5px;padding:2px 8px}
  .room-host-meta{max-width:80px;flex-shrink:1}
  .room-meta{font-size:11px;gap:4px;flex-wrap:nowrap}
  .room-players .player{font-size:10px;padding:2px 6px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}

/* ===== 聊天模块样式 ===== */
.chat-wrapper {
    margin-top: 0;
    border-top: 1px solid var(--line);
    padding-top: 8px;
    padding-bottom: 4px;
}
.chat-messages {
    max-height: 120px;
    overflow-y: auto;
    background: var(--card);
    border-radius: 12px;
    padding: 8px 12px;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.chat-msg {
    padding: 4px 10px;
    border-radius: 12px;
    max-width: 80%;
    word-break: break-word;
    background: rgba(125,175,210,.08);
    align-self: flex-start;
}
.chat-msg-mine {
    background: #fff;
    color: #17344d;
    align-self: flex-end;
}
/* QQ 风格时间分割线 */
.chat-time-divider {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    align-self: stretch;
    margin: 8px 0 4px;
    pointer-events: none;
    user-select: none;
}
.chat-time-divider span {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    background: transparent;
    padding: 2px 10px;
    border-radius: 999px;
    letter-spacing: 0.2px;
    opacity: 0.9;
}
html.dark .chat-time-divider span {
    color: var(--muted);
    opacity: 0.85;
}
.chat-input-area {
    display: flex;
    gap: 6px;
    margin-top: 8px;
}
.chat-input {
    flex: 1;
    padding: 6px 12px;
    border-radius: 20px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
    font-size: 13px;
    outline: none;
}
.chat-input:focus {
    border-color: var(--cyan);
}
.chat-send-btn {
    padding: 6px 16px;
    border: 0;
    border-radius: 20px;
    background: var(--cyan);
    color: #fff;
    font-weight: 700;
    cursor: pointer;
    transition: var(--transition);
}
.chat-send-btn:hover {
    opacity: 0.85;
}
html.dark .chat-msg {
    background: rgba(255,255,255,.06);
}
html.dark .chat-msg-mine {
    background: var(--cyan);
    color: #0f1923;
}

.image-upload-btn {
  background: none;
  border: none;
  font-size: 22px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 12px;
  transition: var(--transition);
  color: var(--muted);
}
.image-upload-btn:hover {
  background: var(--line);
  color: var(--ink);
}

/* ===== 聊天链接 - 无背景，纯亮蓝色 ===== */
.chat-link {
    color: #1e90ff;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 2px;
    text-decoration-color: #1e90ff;
    cursor: pointer;
    user-select: text;
    transition: color 0.2s, transform 0.1s;
    font-weight: 600;
}
.chat-link:hover {
    color: #0077ea;
    transform: scale(1.02);
}

html.dark .chat-link,
@media (prefers-color-scheme: dark) {
    :root:not(.light) .chat-link {
        color: #4fc3f7;
        text-decoration-color: #4fc3f7;
    }
    html.dark .chat-link:hover,
    :root:not(.light) .chat-link:hover {
        color: #81d4fa;
    }
}
/* ===== 聊天多媒体消息 ===== */
.chat-messages {
  max-height: 220px;
}
.chat-media-img {
  max-width: 200px;
  max-height: 200px;
  border-radius: 0;
  display: block;
  margin-top: 4px;
  cursor: zoom-in;
  object-fit: cover;
  background: rgba(0,0,0,.06);
}
.chat-media-video {
  max-width: 240px;
  max-height: 200px;
  border-radius: 0;
  display: block;
  margin-top: 4px;
  background: #000;
  cursor: zoom-in;
}
.chat-media-audio {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  min-width: 200px;
  max-width: 260px;
}
.chat-media-audio-el {
  display: none;
}
.chat-media-audio-label {
  display: none;
}
/* ===== 自定义音频播放器 ===== */
.audio-player-ui {
  display: flex;
  align-items: center;
  gap: 8px;
}
.audio-play-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 0;
  background: var(--cyan);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  padding: 0;
  line-height: 1;
  transition: opacity .2s, transform .2s;
}
.audio-play-btn:hover {
  opacity: .85;
  transform: scale(1.06);
}
.audio-play-btn:active {
  transform: scale(.95);
}
/* 进度条：浅色气泡(白底)用深色轨道 */
.audio-progress-bar {
  flex: 1;
  height: 6px;
  background: rgba(0,40,60,.25);
  border-radius: 3px;
  cursor: pointer;
  position: relative;
  min-width: 60px;
  overflow: hidden;
  border: 1px solid rgba(0,40,60,.08);
}
.audio-progress-fill {
  height: 100%;
  background: #19c8ae;
  border-radius: 3px;
  width: 0%;
  pointer-events: none;
  box-shadow: 0 0 4px rgba(25,200,174,.50);
}
.audio-time-display {
  font-size: 12px;
  font-weight: 600;
  color: #08786e;
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 38px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* 自己发的气泡(cyan底)：深色轨道 + 深色填充 */
/* 浅色：自己气泡(白底，与对方一致) */
.chat-msg-mine .audio-progress-bar {
  background: rgba(0,40,60,.18);
}
.chat-msg-mine .audio-progress-fill {
  background: #19c8ae;
  box-shadow: 0 0 4px rgba(25,200,174,.50);
}
.chat-msg-mine .audio-time-display {
  color: #08786e;
}

/* ===== 深色模式：深色气泡(深蓝灰底 #263746) ===== */
html.dark .audio-play-btn,
:root:not(.light) .audio-play-btn {
  background: var(--cyan);
  color: #0f1923;
}
/* 轨道大幅提亮，在 #263746 背景上清晰可见 */
html.dark .audio-progress-bar,
:root:not(.light) .audio-progress-bar {
  background: rgba(255,255,255,.35);
}
html.dark .audio-progress-fill,
:root:not(.light) .audio-progress-fill {
  background: #2ee6c8;
  box-shadow: 0 0 8px rgba(46,230,200,.65);
}
html.dark .audio-time-display,
:root:not(.light) .audio-time-display {
  color: #70ddff;
}
/* 深色模式下别人气泡内：轨道更亮 */
html.dark .chat-msg .audio-progress-bar,
:root:not(.light) .chat-msg .audio-progress-bar {
  background: rgba(255,255,255,.35);
}
html.dark .chat-msg .audio-progress-fill,
:root:not(.light) .chat-msg .audio-progress-fill {
  background: #2ee6c8;
  box-shadow: 0 0 8px rgba(46,230,200,.65);
}
/* 深色模式下自己气泡(与对方一致 #263746 底) */
html.dark .chat-msg-mine .audio-progress-bar,
:root:not(.light) .chat-msg-mine .audio-progress-bar {
  background: rgba(255,255,255,.35);
}
html.dark .chat-msg-mine .audio-progress-fill,
:root:not(.light) .chat-msg-mine .audio-progress-fill {
  background: #2ee6c8;
  box-shadow: 0 0 8px rgba(46,230,200,.65);
}
html.dark .chat-msg-mine .audio-time-display,
:root:not(.light) .chat-msg-mine .audio-time-display {
  color: #70ddff;
}
.chat-media-file {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(125,175,210,.10);
  color: var(--ink);
  text-decoration: none;
  max-width: 260px;
  transition: background .2s;
}
.chat-media-file:hover {
  background: rgba(125,175,210,.18);
}
.chat-media-file-icon {
  font-size: 22px;
  flex-shrink: 0;
}
.chat-media-file-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chat-media-file-name {
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-media-file-size {
  font-size: 11px;
  color: var(--muted);
}
html.dark .chat-media-file {
  background: rgba(255,255,255,.06);
}
html.dark .chat-media-file:hover {
  background: rgba(255,255,255,.10);
}

/* ===== 聊天图片 / 视频放大预览 ===== */
.chat-lightbox,
.chat-video-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0,0,0,.86);
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  overflow: hidden;
  overscroll-behavior: contain;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
}
.chat-lightbox.open,
.chat-video-lightbox.open {
  display: flex;
}
.chat-lightbox-stage,
.chat-video-lightbox-stage {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
}
.chat-lightbox-img {
  position: absolute;
  top: 50%;
  left: 50%;
  width: auto;
  height: auto;
  max-width: none;
  max-height: none;
  border-radius: 0 !important;
  object-fit: contain;
  box-shadow: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-touch-callout: none;
  transform: translate3d(-50%, -50%, 0) translate3d(0, 0, 0) scale(1);
  transform-origin: center center;
  will-change: transform;
}
.chat-lightbox-img.is-dragging {
  cursor: grabbing;
}
/* ===== 聊天内视频播放器：严格自适应，控件不出框 ===== */
.chat-video-player {
  position: relative;
  display: inline-block;
  width: fit-content;
  max-width: 100%;
  border-radius: 12px !important;
  overflow: hidden !important;
  background: transparent !important;
  isolation: isolate;
  padding: 0;
  margin: 0;
  vertical-align: top;
  box-sizing: border-box;
}
.chat-video-player .chat-media-video {
  display: block;
  width: auto;
  height: auto;
  max-width: min(62vw, 240px);
  max-height: 280px;
  border-radius: 12px !important;
  object-fit: contain;
  background: transparent !important;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: manipulation;
}
/* 竖屏视频自适应尺寸与控件布局 */
.chat-video-player.is-portrait .chat-media-video {
  width: auto;
  height: auto;
  max-width: min(60vw, 200px);
  max-height: min(55vh, 280px);
  object-fit: contain;
  background: transparent !important;
}
.chat-video-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 26px;
  padding: 16px 3px 3px;
  color: #fff;
  background: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.85) 100%);
  line-height: 1;
  opacity: .96;
  z-index: 5;
  overflow: hidden;
}
.chat-video-control-btn {
  flex: 0 0 19px;
  width: 19px;
  height: 19px;
  min-width: 19px;
  max-width: 19px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: transparent;
  color: #fff;
  font-size: 10.5px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.chat-video-control-btn:hover {
  background: rgba(255,255,255,.2);
}
.chat-video-time {
  flex: 0 0 auto;
  min-width: 18px;
  color: #fff;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}
.chat-video-duration {
  display: none !important;
}
.chat-video-progress {
  flex: 1 1 0%;
  width: 0;
  min-width: 10px;
  height: 3px;
  margin: 0 1px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  appearance: none;
  -webkit-appearance: none;
  outline: none;
  cursor: pointer;
  background: linear-gradient(to right, #25d8bd var(--video-progress, 0%), rgba(255,255,255,.42) var(--video-progress, 0%));
}
.chat-video-progress::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 999px;
  background: transparent;
}
.chat-video-progress::-webkit-slider-thumb {
  width: 8px;
  height: 8px;
  margin-top: -2.5px;
  border: 0;
  border-radius: 50%;
  appearance: none;
  -webkit-appearance: none;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.4);
}
.chat-video-center-play { 
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 4;
  width: 44px;
  height: 44px;
  padding: 0 0 0 3px;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  transform: translate(-50%, -50%);
  background: rgba(255,255,255,.78);
  color: #000;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,.32);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform .18s ease, background .18s ease;
}
.chat-video-center-play:hover {
  transform: translate(-50%, -50%) scale(1.06);
  background: rgba(255,255,255,.92);
}
.chat-video-center-play:active {
  transform: translate(-50%, -50%) scale(.94);
}
.chat-video-center-play.is-hidden {
  display: none !important;
}

/* 全屏大窗口视频播放器控件 */
.chat-video-lightbox-player {
  position: relative;
  width: 100%;
  max-width: min(96vw, 1200px);
  max-height: 90vh;
  border-radius: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.28s cubic-bezier(.4,0,.2,1);
}
.chat-video-lightbox-player .chat-lightbox-video {
  width: 100%;
  max-width: min(96vw, 1200px);
  max-height: 90vh;
  object-fit: contain;
}
.chat-video-lightbox-player .chat-video-controls {
  min-height: 46px;
  padding: 24px 12px 10px;
  gap: 8px;
}
.chat-video-lightbox-player .chat-video-control-btn {
  width: 34px;
  height: 34px;
  min-width: 34px;
  font-size: 19px;
}
.chat-video-lightbox-player .chat-video-time {
  font-size: 13px;
  min-width: 34px;
}
.chat-video-lightbox-player .chat-video-duration {
  display: inline-block !important;
}
.chat-video-lightbox-player .chat-video-progress {
  height: 5px;
}
.chat-video-lightbox-player .chat-video-center-play {
  width: 64px;
  height: 64px;
  font-size: 28px;
}

/* 横屏视频 90° 旋转拉伸满屏：完全填满手机屏幕 (100vh × 100vw)，保持真实宽高比 */
.chat-video-lightbox-player.is-rotated {
  position: fixed !important;
  left: 50% !important;
  top: 50% !important;
  width: 100vh !important;
  height: 100vw !important;
  max-width: 100vh !important;
  max-height: 100vw !important;
  transform: translate(-50%, -50%) rotate(90deg) !important;
  transform-origin: center center !important;
  z-index: 1000 !important;
}
.chat-video-lightbox-player.is-rotated .chat-lightbox-video {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: contain !important;
}
.chat-video-lightbox-player.is-rotated .chat-video-controls {
  position: absolute !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
}

/* 图片与视频大图查看器右上角关闭按钮（避开手机顶部状态栏/电量栏，靠右上角对齐） */
.chat-lightbox-close,
.chat-video-lightbox-close {
  position: fixed !important;
  top: max(calc(58px + var(--safe-top, 0px)), 58px) !important;
  right: max(calc(18px + var(--safe-right, 0px)), 18px) !important;
  z-index: 100000 !important;
  width: 40px !important;
  height: 40px !important;
  border: 1px solid rgba(255, 255, 255, 0.3) !important;
  border-radius: 50% !important;
  background: rgba(0, 0, 0, 0.6) !important;
  color: #ffffff !important;
  font-size: 18px !important;
  font-weight: 700 !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  line-height: 1 !important;
  backdrop-filter: blur(10px) !important;
  -webkit-backdrop-filter: blur(10px) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5) !important;
  transition: transform 0.15s ease, background 0.15s ease !important;
  touch-action: manipulation !important;
}
.chat-lightbox-close:hover,
.chat-video-lightbox-close:hover {
  background: rgba(0, 0, 0, 0.85) !important;
  transform: scale(1.08) !important;
}
.chat-lightbox-close:active,
.chat-video-lightbox-close:active {
  transform: scale(0.92) !important;
}

/* 视频内部右边缘中间悬浮旋转全屏按钮 */
.chat-video-player .chat-video-rotate-btn,
.chat-video-rotate-btn {
  position: absolute !important;
  right: 12px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  z-index: 30 !important;
  width: 44px !important;
  height: 44px !important;
  border-radius: 50% !important;
  border: 1px solid rgba(255, 255, 255, 0.35) !important;
  background: rgba(0, 0, 0, 0.65) !important;
  color: #ffffff !important;
  font-size: 22px !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  line-height: 1 !important;
  backdrop-filter: blur(10px) !important;
  -webkit-backdrop-filter: blur(10px) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5) !important;
  transition: transform 0.2s ease, background 0.2s ease !important;
  touch-action: manipulation !important;
}
.chat-video-rotate-btn:hover {
  background: rgba(0, 0, 0, 0.85) !important;
  transform: translateY(-50%) scale(1.1) !important;
}
.chat-video-rotate-btn:active {
  transform: translateY(-50%) scale(0.9) !important;
}
.chat-video-lightbox-hint {
  position: absolute;
  left: 50%;
  bottom: 18px;
  z-index: 2;
  transform: translateX(-50%);
  padding: 6px 10px;
  border-radius: 8px;
  color: rgba(255,255,255,.78);
  background: rgba(0,0,0,.35);
  font-size: 12px;
  pointer-events: none;
}

.chat-plus-wrap {
  position: relative;
  flex-shrink: 0;
}
.chat-plus-btn,
.chat-voice-btn {
  border: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(125,175,210,.12);
  color: var(--ink);
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: var(--transition);
  flex-shrink: 0;
  padding: 0;
  line-height: 1;
}
.chat-plus-btn:hover,
.chat-voice-btn:hover {
  background: rgba(125,175,210,.22);
  transform: translateY(-1px);
}
.chat-voice-btn.recording {
  background: var(--red);
  color: #fff;
  animation: voice-pulse 1s ease-in-out infinite;
  font-size: 12px;
  font-weight: 800;
}
@keyframes voice-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220,48,72,.35); }
  50% { box-shadow: 0 0 0 8px rgba(220,48,72,.08); }
}
.chat-plus-wrap {
  position: static;
  flex-shrink: 0;
}
.chat-plus-panel {
  display: none;
  width: 100%;
  box-sizing: border-box;
  margin: 6px 0;
  padding: 6px 8px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  flex-direction: row;
  align-items: center;
  gap: 6px;
  animation: plus-panel-fade .18s cubic-bezier(.4,0,.2,1);
}
.chat-plus-panel.open {
  display: flex !important;
}
.chat-plus-panel button {
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  border: 0;
  background: rgba(125,175,210,.10);
  text-align: center;
  padding: 8px 6px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
  cursor: pointer;
  white-space: nowrap;
  transition: var(--transition);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.chat-plus-panel button:hover,
.chat-plus-panel button:active {
  background: rgba(125,175,210,.22);
}
html.dark .chat-plus-btn,
html.dark .chat-voice-btn {
  background: rgba(255,255,255,.08);
  color: var(--cyan);
}
html.dark .chat-plus-btn:hover,
html.dark .chat-voice-btn:hover {
  background: rgba(255,255,255,.14);
}
html.dark .chat-plus-panel,
:root:not(.light) .chat-plus-panel {
  background: #172735;
  border-color: rgba(255,255,255,.08);
}
html.dark .chat-plus-panel button,
:root:not(.light) .chat-plus-panel button {
  background: rgba(255,255,255,.08);
  color: #e7f1f5;
}
html.dark .chat-plus-panel button:hover,
:root:not(.light) .chat-plus-panel button:hover {
  background: rgba(255,255,255,.16);
}
@keyframes plus-panel-fade {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.chat-input-area .chat-input {
  flex: 1;
  min-width: 0;
}

/* 聊天身份、长文本与待发送附件 */
.chat-msg .msg-content { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 4px; line-height:1.5; }
.chat-msg .msg-content strong { display:inline-block; }
.msg-sender-id { flex-basis:100%; display:block; margin-top:-2px; color:var(--muted); font-size:10px; font-weight:500; line-height:1.1; }
.chat-msg-mine .msg-sender-id { color:rgba(100,130,150,.72); }
.msg-separator { white-space:pre; }
.chat-input { min-height:36px; max-height:120px; resize:none; overflow-y:auto; line-height:1.45; }
.chat-pending { flex:0 1 auto; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-radius:12px; padding:7px 8px; background:rgba(25,200,174,.14); color:var(--ink); font-size:11px; }
.chat-pending button { border:0; background:none; color:var(--red); cursor:pointer; font-size:15px; padding:0 0 0 4px; }
@media (max-width:600px) {
  .chat-msg { max-width:92%; }
  .chat-pending { max-width:120px; }
}

/* ===== 手机 QQ 风格聊天重制 ===== */
.chat-wrapper {
  margin: 8px -2px 2px;
  padding: 10px 8px 6px;
  border-top: 1px solid rgba(255,255,255,.07);
  background: linear-gradient(180deg, rgba(10,22,33,.32), rgba(10,22,33,.08));
  border-radius: 16px;
}
.chat-messages,
#publicChatMessages {
  max-height: 300px;
  min-height: 78px;
  overflow-y: auto;
  padding: 12px 10px;
  gap: 6px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  background: #101d29;
  border: 1px solid rgba(255,255,255,.055);
  border-radius: 16px;
  scrollbar-width: thin;
  scrollbar-color: rgba(141,170,190,.35) transparent;
}
html.light .chat-messages,
html.light #publicChatMessages {
  background: #f3f7fa;
  border-color: rgba(55,130,175,.10);
}
.chat-msg {
  display: block;
  flex: 0 0 auto;
  width: fit-content;
  max-width: min(82%, 360px);
  padding: 8px 12px;
  border-radius: 17px 17px 17px 5px;
  background: #263746;
  color: #e8f1f6;
  box-shadow: 0 2px 5px rgba(0,0,0,.12);
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
  overflow-wrap: anywhere;
  touch-action: manipulation;
  -webkit-touch-callout: none;
  position: relative;
}
/* 气泡内媒体元素不拦截长按：视频/音频/图片的 pointer-events 由气泡接管 */
.chat-msg .chat-media-video,
.chat-msg .chat-media-audio-el,
.chat-msg .chat-media-img,
.chat-msg .chat-media-audio,
.chat-msg .audio-player-ui,
.chat-msg .audio-play-btn,
.chat-msg .audio-progress-bar,
.chat-msg .chat-media-file,
.chat-msg .msg-content strong,
.chat-msg .msg-content .msg-body {
  -webkit-touch-callout: none;
  touch-action: manipulation;
}
/* 视频和音频播放器的控件仍需可点击，但长按由气泡接管 */
.chat-msg video::-webkit-media-controls {
  -webkit-touch-callout: none;
}
/* 气泡内允许文字长按呼出系统复制菜单 */
.chat-msg .msg-body,
.chat-msg .msg-body * {
  -webkit-touch-callout: default !important;
  -webkit-user-select: text !important;
  user-select: text !important;
}
.chat-msg .msg-sender,
.chat-msg .msg-time,
.chat-msg .msg-footer,
.chat-msg .msg-footer * {
  -webkit-touch-callout: none !important;
  -webkit-user-select: none !important;
  user-select: none !important;
}
/* 播放器控件是按钮不是正文：长按播放键/音量键不触发系统文字选择与“复制”菜单。
   选择器优先级 (0,3,0) 高于上面 .chat-msg .msg-body * 的 (0,2,0)，同为 !important 时后者被覆盖。 */
.chat-msg .msg-body .chat-video-wrap,
.chat-msg .msg-body .chat-video-wrap *,
.chat-msg .msg-body .audio-player-ui,
.chat-msg .msg-body .audio-player-ui * {
  -webkit-user-select: none !important;
  -moz-user-select: none !important;
  -ms-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none !important;
}
.chat-msg img,
.chat-msg video,
.chat-msg audio {
  -webkit-touch-callout: none !important;
  -webkit-user-drag: none;
  user-drag: none;
  outline: none;
}
/* 防止视频/音频长按弹出系统菜单 */
.chat-msg .chat-media-video,
.chat-msg .chat-media-audio {
  -webkit-touch-callout: none !important;
  touch-callout: none;
}
html.light .chat-msg {
  background: #fff;
  color: #17344d;
  box-shadow: 0 2px 8px rgba(39,91,120,.10);
}
.chat-msg-mine {
  align-self: flex-end;
  width: fit-content;
  max-width: min(82%, 360px);
  border-radius: 17px 17px 5px 17px;
  background: #fff;
  color: #17344d;
}
html.dark .chat-msg-mine { background: #263746; color: #e7f1f5; }
.chat-msg .msg-content {
  display: block;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
}
.chat-msg .msg-content strong {
  display: block;
  margin-bottom: 1px;
  font-size: 13px;
  line-height: 1.2;
  color: #65d8ff;
}
.chat-msg-mine .msg-content strong { color: #08786e; }
.chat-msg .msg-sender-id {
  display: block;
  margin: 0 0 5px;
  color: #8ba5b6;
  font-size: 10px;
  line-height: 1.15;
  opacity: .9;
  overflow-wrap: anywhere;
}
.chat-msg-mine .msg-sender-id { color: rgba(100,130,150,.72); }
.msg-separator { display: none; }
.chat-media-audio { min-width: 200px; max-width: 255px; }
.chat-media-video { max-width: 255px; max-height: 180px; }
.chat-media-img { max-width: 220px; max-height: 220px; }
.chat-media-file { max-width: 255px; background: rgba(0,0,0,.08); }
.chat-time-divider { margin: 5px 0 1px; }
.chat-time-divider span {
  padding: 3px 10px;
  color: #7891a2;
  font-size: 10px;
  background: rgba(125,175,210,.08);
}
.chat-input-area {
  gap: 7px;
  padding: 2px 0 0;
}
.chat-input-area .chat-input {
  min-height: 42px;
  padding: 9px 15px;
  border-radius: 22px;
  background: #172735;
  border-color: rgba(255,255,255,.08);
  color: #edf7fb;
  font-size: 14px;
}
html.light .chat-input-area .chat-input {
  background: #fff;
  border-color: rgba(55,130,175,.14);
  color: #17344d;
}
.chat-input-area .chat-input::placeholder { color: #7891a2; }
.chat-plus-btn, .chat-voice-btn {
  width: 42px;
  height: 42px;
  background: #253746;
  color: #9cb6c5;
  font-size: 21px;
}
html.light .chat-plus-btn,
html.light .chat-voice-btn { background: #e8f0f4; color: #55768b; }
/* 录音中固定语音按钮尺寸，计时显示为小角标，避免按钮横向撑大。 */
.chat-input-area .chat-voice-btn.recording {
  width: 42px !important;
  min-width: 42px !important;
  max-width: 42px !important;
  flex: 0 0 42px !important;
  height: 42px !important;
  min-height: 42px !important;
  max-height: 42px !important;
  padding: 0 !important;
  overflow: visible;
  position: relative;
  transform: none !important;
  font-size: 18px !important;
  line-height: 1 !important;
  white-space: nowrap;
}
.chat-input-area .chat-voice-btn.recording::after {
  content: attr(data-recording-seconds) 's';
  position: absolute;
  top: -5px;
  right: -9px;
  min-width: 25px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  line-height: 17px;
  text-align: center;
  box-shadow: 0 1px 5px rgba(0,0,0,.28);
  pointer-events: none;
}
.chat-send-btn {
  min-width: 78px;
  height: 42px;
  padding: 0 18px;
  border-radius: 22px;
  background: #25d8bd;
  color: #062a2b;
  font-size: 15px;
  box-shadow: 0 4px 12px rgba(37,216,189,.20);
}
.chat-pending {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 5;
  max-width: 210px;
  background: #263746;
  color: #e8f1f6;
  box-shadow: 0 6px 18px rgba(0,0,0,.22);
}
@media (max-width:600px) {
  .chat-msg, .chat-msg-mine { max-width: 86%; }
  .chat-media-audio { min-width: 180px; max-width: 235px; }
  .chat-send-btn { min-width: 70px; padding: 0 14px; }
}
@media (prefers-color-scheme: light) {
  .chat-messages, #publicChatMessages { background:#f3f7fa; border-color:rgba(55,130,175,.10); }
  .chat-msg { background:#fff; color:#17344d; box-shadow:0 2px 8px rgba(39,91,120,.10); }
  .chat-input-area .chat-input { background:#fff; border-color:rgba(55,130,175,.14); color:#17344d; }
  .chat-plus-btn, .chat-voice-btn { background:#e8f0f4; color:#55768b; }
}

/* 恢复聊天区域原本的主题背景色，仅保留 QQ 气泡布局 */
.chat-wrapper { background: transparent; }
.chat-messages, #publicChatMessages { background: var(--card); }
.chat-msg { background: rgba(125,175,210,.08); color: var(--ink); }
html.dark .chat-msg { background: rgba(255,255,255,.06); color: var(--ink); }
.chat-input-area .chat-input { background: var(--card); color: var(--ink); }
.chat-plus-btn, .chat-voice-btn { background: rgba(125,175,210,.12); color: var(--ink); }
html.dark .chat-plus-btn, html.dark .chat-voice-btn { background: rgba(255,255,255,.08); color: var(--cyan); }
@media (prefers-color-scheme: dark) {
  :root:not(.light) .chat-msg { background: rgba(255,255,255,.06); color: var(--ink); }
  :root:not(.light) .chat-plus-btn, :root:not(.light) .chat-voice-btn { background: rgba(255,255,255,.08); color: var(--cyan); }
}

/* Telegram 风格消息时间：不显示用户 ID，时间放在气泡右下角 */
.chat-msg .msg-sender-id { display: none !important; }
.chat-msg .msg-content { position: relative; padding-bottom: 2px; }
.chat-msg .msg-time {
  display: inline-block;
  margin-left: 8px;
  color: rgba(145,169,181,.9);
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  vertical-align: bottom;
}
.chat-msg-mine .msg-time { color: rgba(100,130,150,.72); }
.chat-msg .msg-content strong { margin-right: 2px; }
/* 聊天相关界面不展示用户 ID（在线成员列表也仅显示昵称） */
.online-member-id { display: block; }
.online-member-item { cursor: default; }

/* ===== 聊天气泡可读性优化：浅色 / 深色高对比 ===== */
/* 默认浅色 */
.chat-messages, #publicChatMessages { color: #17344d; }
.chat-msg {
  background: #ffffff;
  color: #17344d;
  border: 1px solid rgba(42,91,119,.10);
  box-shadow: 0 2px 8px rgba(37,82,108,.12);
}
.chat-msg .msg-content { color: #17344d; }
.chat-msg .msg-content strong { color: #08786e; }
.chat-msg .msg-time { color: #66808f; }
.chat-msg-mine {
  background: #fff;
  color: #17344d;
  border-color: rgba(42,91,119,.10);
  box-shadow: 0 2px 8px rgba(37,82,108,.12);
}
.chat-msg-mine .msg-content,
.chat-msg-mine .msg-content strong { color: #17344d; }
.chat-msg-mine .msg-time { color: #66808f; }
.chat-msg .chat-media-audio-label,
.chat-msg .chat-media-file-size { color: #5c7888; }
.chat-msg-mine .chat-media-audio-label,
.chat-msg-mine .chat-media-file-size { color: #5c7888; }
.chat-link { color: #075fc4; text-decoration-color: #075fc4; }

/* 深色模式 */
html.dark .chat-messages, html.dark #publicChatMessages,
:root:not(.light) .chat-messages, :root:not(.light) #publicChatMessages { color: #e7f1f5; }
html.dark .chat-msg,
:root:not(.light) .chat-msg {
  background: #263746;
  color: #e7f1f5;
  border-color: rgba(255,255,255,.08);
  box-shadow: 0 2px 8px rgba(0,0,0,.22);
}
html.dark .chat-msg .msg-content,
:root:not(.light) .chat-msg .msg-content { color: #e7f1f5; }
html.dark .chat-msg .msg-content strong,
:root:not(.light) .chat-msg .msg-content strong { color: #70ddff; }
html.dark .chat-msg .msg-time,
:root:not(.light) .chat-msg .msg-time { color: #a8bfca; }
html.dark .chat-msg-mine,
:root:not(.light) .chat-msg-mine {
  background: #263746;
  color: #e7f1f5;
  border-color: rgba(255,255,255,.08);
  box-shadow: 0 2px 8px rgba(0,0,0,.22);
}
html.dark .chat-msg-mine .msg-content,
html.dark .chat-msg-mine .msg-content strong,
:root:not(.light) .chat-msg-mine .msg-content,
:root:not(.light) .chat-msg-mine .msg-content strong { color: #e7f1f5; }
html.dark .chat-msg-mine .msg-time,
:root:not(.light) .chat-msg-mine .msg-time { color: #a8bfca; }
html.dark .chat-msg .chat-media-audio-label,
html.dark .chat-msg .chat-media-file-size,
:root:not(.light) .chat-msg .chat-media-audio-label,
:root:not(.light) .chat-msg .chat-media-file-size { color: #b5c8d1; }
html.dark .chat-msg-mine .chat-media-audio-label,
html.dark .chat-msg-mine .chat-media-file-size,
:root:not(.light) .chat-msg-mine .chat-media-audio-label,
:root:not(.light) .chat-msg-mine .chat-media-file-size { color: #b5c8d1; }
html.dark .chat-link,
:root:not(.light) .chat-link { color: #72cfff; text-decoration-color: #72cfff; }

@media (prefers-color-scheme: light) {
  :root:not(.dark) .chat-msg { background:#fff; color:#17344d; border-color:rgba(42,91,119,.10); }
  :root:not(.dark) .chat-msg .msg-content { color:#17344d; }
  :root:not(.dark) .chat-msg .msg-content strong { color:#08786e; }
  :root:not(.dark) .chat-msg .msg-time { color:#66808f; }
  :root:not(.dark) .chat-msg-mine { background:#fff; color:#17344d; }
  :root:not(.dark) .chat-msg-mine .msg-content,
  :root:not(.dark) .chat-msg-mine .msg-content strong { color:#17344d; }
  :root:not(.dark) .chat-msg-mine .msg-time { color:#66808f; }
  :root:not(.dark) .chat-link { color:#075fc4; text-decoration-color:#075fc4; }
}

/* 深色模式链接提高亮度，避免被深色气泡吞掉 */
html.dark .chat-link,
html.dark .chat-msg .chat-link,
:root:not(.light) .chat-link,
:root:not(.light) .chat-msg .chat-link { color:#8bdcff !important; text-decoration-color:#8bdcff !important; text-shadow:0 0 1px rgba(139,220,255,.25); }
html.dark .chat-link:hover,
:root:not(.light) .chat-link:hover { color:#c1efff !important; }
.chat-audio-duration { display: none !important; }

/* 待发送附件的取消按钮始终完整可见 */
.chat-pending {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  padding-right: 5px;
}
.chat-pending-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-pending button {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  line-height: 1;
  font-size: 18px;
}

/* 图片消息支持下载 */
.chat-image-wrap {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  max-width: 100%;
}
.chat-image-download {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 8px;
  color: #0876b8;
  background: rgba(25,150,210,.10);
  font-size: 11px;
  font-weight: 700;
  text-decoration: none;
}
.chat-image-download:hover { background: rgba(25,150,210,.20); }
html.dark .chat-image-download,
:root:not(.light) .chat-image-download { color: #8bdcff; background: rgba(80,190,240,.14); }

/* 媒体消息：时间放在媒体和下载按钮之间 */
.chat-msg.media-message .msg-content { display:flex; flex-direction:column; align-items:flex-start; }
.chat-msg.media-message .msg-content > strong { order:1; }
.chat-msg.media-message .chat-image-wrap,
.chat-msg.media-message .chat-video-wrap { order:2; }
.chat-msg.media-message .msg-time { order:3; margin:4px 0 0; }
.chat-msg.media-message .chat-image-download,
.chat-msg.media-message .chat-video-download { order:4; }
.chat-image-download, .chat-video-download {
  display:inline-flex;
  align-items:center;
  margin-top:4px;
  padding:4px 9px;
  border-radius:8px;
  color:#075d91;
  background:rgba(25,150,210,.12);
  font-size:11px;
  font-weight:700;
  text-decoration:none;
}
.chat-image-download:hover, .chat-video-download:hover { background:rgba(25,150,210,.22); }
html.dark .chat-image-download, html.dark .chat-video-download,
:root:not(.light) .chat-image-download, :root:not(.light) .chat-video-download {
  color:#d7f5ff !important;
  background:rgba(79,190,240,.24);
  text-shadow:0 1px 2px rgba(0,0,0,.65);
}
.chat-video-wrap {
  position: relative;
  display: inline-block;
  max-width: 100%;
  line-height: 0;
}
/* 最终消息格式：用户名： / 消息 / 时间 下载图片或下载视频 */
.chat-msg .msg-content { display:block; width:fit-content; max-width:100%; }
.chat-msg .msg-sender { display:block; margin:0 0 4px; line-height:1.25; }
.chat-msg .msg-body { display:block; line-height:1.45; }
.chat-msg .msg-footer { display:flex; align-items:center; gap:8px; margin-top:6px; min-height:14px; }
.chat-msg .msg-footer .msg-time,
.chat-msg .msg-footer .chat-media-download {
  display:inline-flex;
  align-items:center;
  margin:0;
  font-size:10px;
  line-height:1.2;
  white-space:nowrap;
}
.chat-media-download { text-decoration:none; font-weight:700; }
.chat-msg .msg-footer .chat-media-download { color:#075d91; }
.chat-msg-mine .msg-footer .chat-media-download { color:#075d91; }
html.dark .chat-msg .msg-footer .chat-media-download,
:root:not(.light) .chat-msg .msg-footer .chat-media-download { color:#d7f5ff !important; text-shadow:0 1px 2px rgba(0,0,0,.65); }
/* 移除旧版媒体排序规则对新页脚的影响 */
.chat-msg.media-message .msg-content { display:block; }
.chat-msg.media-message .msg-time { order:initial; }

/* 深色模式链接颜色与浅色模式统一 */
html.dark .chat-link,
html.dark .chat-msg .chat-link,
:root:not(.light) .chat-link,
:root:not(.light) .chat-msg .chat-link {
  color: #075fc4 !important;
  text-decoration-color: #075fc4 !important;
  text-shadow: none !important;
}
html.dark .chat-link:hover,
:root:not(.light) .chat-link:hover {
  color: #075fc4 !important;
}

/* 气泡时间与用户名使用同等深度的文字颜色 */
.chat-msg .msg-footer .msg-time { color:#08786e; opacity:1; }
.chat-msg-mine .msg-footer .msg-time { color:#66808f; opacity:1; }
html.dark .chat-msg .msg-footer .msg-time,
:root:not(.light) .chat-msg .msg-footer .msg-time { color:#70ddff; opacity:1; }
html.dark .chat-msg-mine .msg-footer .msg-time,
:root:not(.light) .chat-msg-mine .msg-footer .msg-time { color:#a8bfca; opacity:1; }
@media (prefers-color-scheme: light) {
  :root:not(.dark) .chat-msg .msg-footer .msg-time { color:#08786e; }
  :root:not(.dark) .chat-msg-mine .msg-footer .msg-time { color:#66808f; }
}

.chat-audio-duration { display: none !important; }
html.dark .chat-audio-duration,
:root:not(.light) .chat-audio-duration { display: none !important; }
.chat-msg-mine .chat-audio-duration { display: none !important; }

/* ===== 消息操作菜单（撤回/删除） ===== */
.msg-action-menu {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.msg-action-menu.open {
  pointer-events: auto;
}
.msg-action-mask {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0);
  transition: background .25s ease;
}
.msg-action-menu.open .msg-action-mask {
  background: rgba(0,0,0,.35);
}
.msg-action-sheet {
  position: relative;
  z-index: 1;
  width: min(280px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 0;
  border-radius: 18px;
  background: var(--white);
  box-shadow: 0 12px 40px rgba(0,0,0,.2);
  overflow: hidden;
  transform: scale(.85);
  opacity: 0;
  transition: transform .2s cubic-bezier(.4,0,.2,1), opacity .2s ease;
}
.msg-action-menu.open .msg-action-sheet {
  transform: scale(1);
  opacity: 1;
}
.msg-action-btn {
  width: 100%;
  border: 0;
  background: transparent;
  text-align: center;
  padding: 16px 20px;
  font-size: 16px;
  font-weight: 700;
  color: var(--ink);
  cursor: pointer;
  transition: background .15s;
}
.msg-action-btn:hover {
  background: rgba(125,175,210,.08);
}
.msg-action-btn:active {
  background: rgba(125,175,210,.15);
}
.msg-action-btn.recall {
  color: var(--red);
}
.msg-action-btn.delete {
  color: var(--muted);
}
.msg-action-btn.cancel {
  color: var(--muted);
  border-top: 1px solid var(--line);
  font-weight: 600;
}
html.dark .msg-action-sheet {
  background: #1a2a38;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
html.dark .msg-action-btn:hover {
  background: rgba(255,255,255,.06);
}
html.dark .msg-action-btn.recall {
  color: #ff5a6e;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .msg-action-sheet { background: #1a2a38; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  :root:not(.light) .msg-action-btn:hover { background: rgba(255,255,255,.06); }
  :root:not(.light) .msg-action-btn.recall { color: #ff5a6e; }
}
/* ============================================================
   CSS 补丁：沉浸式状态栏适配
   把这段追加到 script.js 注入的 __styleEl.textContent 模板字符串最末尾。
   ============================================================ */

/* 安全区变量由前端 JS 在启动时通过 getComputedStyle(env(safe-area-inset-*))
   计算并写入 :root；此处仅作 fallback。 */
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
}

/* ====== 沉浸式状态栏：让顶部 hero 留出状态栏高度 ======
   WebView 已延伸到状态栏下方（FLAG_LAYOUT_NO_LIMITS / setDecorFitsSystemWindows(false)），
   所以我们需要给：
     1) .hero（导航栏）— 加 top padding，避免被状态栏遮挡
     2) .page — 加左右 padding，避免被手势条/导航条遮挡
     3) body — 保持背景色延伸到顶部 */
body {
  background: var(--bg);
  /* 防止在沉浸式下底部出现白条（导航条透明后仍要画背景） */
  background-attachment: fixed;
  /* 底部安全区 */
  padding-bottom: var(--safe-bottom);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}

/* hero（导航栏）自身需要顶部 padding，避开状态栏 */
.hero {
  margin-top: var(--safe-top);
  /* 替代原来的 sticky top:12px，改为可计算的安全距离 */
  top: var(--safe-top);
}

/* log-modal、custom-modal、dpi-modal、chat-lightbox、msg-action-menu 也要避开状态栏 */
.log-modal,
.custom-modal,
.dpi-modal,
.chat-lightbox,
.chat-video-lightbox,
.msg-action-menu {
  /* 这些是全屏模态，顶部不需 padding（背景已铺满到顶部） */
}

/* 在 600px 以下的小屏，hero 的 padding 还需要更紧凑 */
@media (max-width: 600px) {
  .hero {
    border-radius: 16px;
    padding: 8px 10px;
  }
  .hero .theme-toggle,
  .hero .icon-btn {
    width: 34px;
    height: 34px;
  }
}

/* ====== 暗色模式下状态栏图标变白（由 Java 端控制） ======
   下面这条规则仅作 fallback，真实场景下 Java 已经在
   WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS 切了。 */
html.dark {
  /* 让浏览器知道：当前背景是深色，状态栏应切白图标 */
  color-scheme: dark;
}
html:not(.dark) {
  color-scheme: light;
}

/* ====== 沉浸式下 hero 玻璃效果稍微调整 ====== */
.hero {
  /* 沉浸式下，hero 顶部留出状态栏后，整体看上去更"悬浮" */
  margin-top: max(var(--safe-top), 6px);
  margin-left: max(var(--safe-left), 0px);
  margin-right: max(var(--safe-right), 0px);
}

/* 任何 fixed 在顶部的元素都要避开状态栏 */
.global-copy-toast,
.plugin-toast {
  top: calc(80px + var(--safe-top));
}
@media (max-width: 600px) {
  .global-copy-toast,
  .plugin-toast {
    top: calc(72px + var(--safe-top));
  }
}

/* ============================================================
 * DPI 缩放体系（基于 CSS 变量 --dpi，默认 1）
 * 作用范围严格限制在 #serverList 内部，不影响顶部栏/统计计数/标签页
 * 保证卡片始终 100% 占满屏幕宽度，左右边距自然贴合，无黑边无裁剪；
 * 展开的聊天区（+ 按钮、输入框、🎤 语音、发送）和房间列表随 DPI 等比缩放且不溢出。
 * ============================================================ */
#serverList, .server-list {
  --dpi: 1;
  /* 操作区跟随 DPI；JS 会读取同一实际宽度作为滑动终点。 */
  --server-action-width: calc(150px * var(--dpi, 1));
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
  display: grid;
  gap: calc(12px * var(--dpi, 1));
  margin-top: calc(18px * var(--dpi, 1));
  overflow-x: hidden !important;
  contain: none !important;
}

/* 卡片外层与滑动层 */
.server-group {
  border-radius: calc(16px * var(--dpi, 1)) !important;
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
}
.server-card-inner {
  border-radius: calc(16px * var(--dpi, 1)) !important;
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
}

/* 服务器卡片头部 */
.server-head {
  padding: calc(14px * var(--dpi, 1)) calc(16px * var(--dpi, 1)) !important;
  gap: calc(10px * var(--dpi, 1)) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  flex-wrap: nowrap !important;
}
.server-status-dot {
  width: calc(11px * var(--dpi, 1)) !important;
  height: calc(11px * var(--dpi, 1)) !important;
  flex-shrink: 0 !important;
}
.server-info {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  justify-content: center !important;
  overflow: hidden !important;
  align-self: stretch !important;
  padding: 0 !important;
}
.server-name {
  font-size: calc(14.5px * var(--dpi, 1)) !important;
  font-weight: 700 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  line-height: 1.35 !important;
  max-width: 100% !important;
}
.server-address {
  font-size: calc(11.5px * var(--dpi, 1)) !important;
  color: var(--muted) !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  line-height: 1.35 !important;
  max-width: 100% !important;
}
.server-tags {
  gap: calc(1px * var(--dpi, 1)) !important;
  margin: calc(1px * var(--dpi, 1)) 0 0 !important;
  max-width: 100% !important;
}
.card-region,
.server-type-badge {
  font-size: calc(10px * var(--dpi, 1)) !important;
  line-height: 1.35 !important;
  max-width: 100% !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  display: block !important;
}

/* 头部右侧 4 项指标 */
.server-stats {
  display: grid !important;
  grid-template-columns: repeat(4, 1fr) !important;
  gap: calc(5px * var(--dpi, 1)) !important;
  align-items: center !important;
  flex-shrink: 0 !important;
  width: calc(215px * var(--dpi, 1)) !important;
  max-width: 58% !important;
  box-sizing: border-box !important;
}
.stat-item {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  text-align: center !important;
  min-width: 0 !important;
}
.stat-item span {
  font-size: calc(10px * var(--dpi, 1)) !important;
  line-height: 1.25 !important;
  margin-bottom: 2px !important;
}
.stat-item b {
  font-size: calc(16px * var(--dpi, 1)) !important;
  line-height: 1.25 !important;
  font-weight: 900 !important;
  height: auto !important;
}
.stat-item.latency b,
.stat-item.latency .latency-badge {
  font-size: calc(15px * var(--dpi, 1)) !important;
  height: auto !important;
  line-height: 1.25 !important;
}
.server-error-badge {
  font-size: calc(10px * var(--dpi, 1)) !important;
  top: calc(5px * var(--dpi, 1)) !important;
}

/* 展开区域 */
.server-group.open .server-body {
  overflow-x: hidden !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
.server-group.open .server-body > .body-inner {
  padding: 0 calc(12px * var(--dpi, 1)) calc(12px * var(--dpi, 1)) !important;
  overflow-x: hidden !important;
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
}

/* 聊天模块跟随 DPI 缩放 */
.chat-wrapper {
  margin: calc(6px * var(--dpi, 1)) 0 calc(2px * var(--dpi, 1)) !important;
  padding: calc(10px * var(--dpi, 1)) calc(8px * var(--dpi, 1)) calc(6px * var(--dpi, 1)) !important;
  border-radius: calc(16px * var(--dpi, 1)) !important;
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  overflow: visible !important;
}
.chat-messages, #publicChatMessages {
  max-height: calc(260px * var(--dpi, 1)) !important;
  min-height: calc(75px * var(--dpi, 1)) !important;
  padding: calc(10px * var(--dpi, 1)) calc(8px * var(--dpi, 1)) !important;
  gap: calc(8px * var(--dpi, 1)) !important;
  border-radius: calc(14px * var(--dpi, 1)) !important;
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  overflow-x: hidden !important;
}
.chat-msg, .chat-msg-mine {
  font-size: calc(13.5px * var(--dpi, 1)) !important;
  padding: calc(7px * var(--dpi, 1)) calc(11px * var(--dpi, 1)) !important;
  border-radius: calc(16px * var(--dpi, 1)) calc(16px * var(--dpi, 1)) calc(16px * var(--dpi, 1)) calc(4px * var(--dpi, 1)) !important;
  max-width: min(84%, calc(360px * var(--dpi, 1))) !important;
  box-sizing: border-box !important;
  word-break: break-word !important;
  overflow-wrap: anywhere !important;
}
.chat-msg-mine {
  border-radius: calc(16px * var(--dpi, 1)) calc(16px * var(--dpi, 1)) calc(4px * var(--dpi, 1)) calc(16px * var(--dpi, 1)) !important;
}
.chat-msg .msg-time {
  font-size: calc(9.5px * var(--dpi, 1)) !important;
  margin-left: calc(6px * var(--dpi, 1)) !important;
}
.chat-media-audio {
  min-width: calc(180px * var(--dpi, 1)) !important;
  max-width: calc(240px * var(--dpi, 1)) !important;
  gap: calc(5px * var(--dpi, 1)) !important;
}
.chat-media-img {
  max-width: calc(200px * var(--dpi, 1)) !important;
  max-height: calc(200px * var(--dpi, 1)) !important;
}
.chat-media-video {
  max-width: calc(220px * var(--dpi, 1)) !important;
  max-height: calc(180px * var(--dpi, 1)) !important;
}
.chat-media-file {
  max-width: calc(240px * var(--dpi, 1)) !important;
  padding: calc(8px * var(--dpi, 1)) calc(10px * var(--dpi, 1)) !important;
  border-radius: calc(12px * var(--dpi, 1)) !important;
}
.chat-media-file-icon {
  font-size: calc(20px * var(--dpi, 1)) !important;
}
.chat-media-file-name {
  font-size: calc(12px * var(--dpi, 1)) !important;
}
.chat-media-file-size {
  font-size: calc(10px * var(--dpi, 1)) !important;
}

/* 聊天输入栏：+ 按钮、输入框、语音按钮、发送按钮在同一行自适应无溢出 */
.chat-input-area {
  display: flex !important;
  align-items: center !important;
  gap: calc(6px * var(--dpi, 1)) !important;
  margin-top: calc(7px * var(--dpi, 1)) !important;
  width: 100% !important;
  box-sizing: border-box !important;
  position: relative !important;
}
.chat-plus-wrap {
  position: relative !important;
  flex-shrink: 0 !important;
}
.chat-plus-btn,
.chat-voice-btn {
  width: calc(38px * var(--dpi, 1)) !important;
  height: calc(38px * var(--dpi, 1)) !important;
  min-width: calc(38px * var(--dpi, 1)) !important;
  max-width: calc(38px * var(--dpi, 1)) !important;
  flex: 0 0 calc(38px * var(--dpi, 1)) !important;
  border-radius: 50% !important;
  font-size: calc(18px * var(--dpi, 1)) !important;
  padding: 0 !important;
  display: grid !important;
  place-items: center !important;
  flex-shrink: 0 !important;
}
.chat-input {
  flex: 1 1 0% !important;
  width: 0 !important;
  min-width: 0 !important;
  min-height: calc(38px * var(--dpi, 1)) !important;
  max-height: calc(100px * var(--dpi, 1)) !important;
  padding: calc(7px * var(--dpi, 1)) calc(12px * var(--dpi, 1)) !important;
  border-radius: calc(20px * var(--dpi, 1)) !important;
  font-size: calc(13.5px * var(--dpi, 1)) !important;
  box-sizing: border-box !important;
}
.chat-send-btn {
  height: calc(38px * var(--dpi, 1)) !important;
  min-width: calc(64px * var(--dpi, 1)) !important;
  padding: 0 calc(12px * var(--dpi, 1)) !important;
  border-radius: calc(20px * var(--dpi, 1)) !important;
  font-size: calc(14px * var(--dpi, 1)) !important;
  font-weight: 700 !important;
  flex-shrink: 0 !important;
  white-space: nowrap !important;
}

/* 房间列表跟随 DPI 缩放 */
.room-list {
  display: grid !important;
  gap: calc(8px * var(--dpi, 1)) !important;
  margin-top: calc(6px * var(--dpi, 1)) !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
.room-item {
  padding: calc(12px * var(--dpi, 1)) calc(14px * var(--dpi, 1)) !important;
  border-radius: calc(14px * var(--dpi, 1)) !important;
  width: 100% !important;
  max-width: 100% !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
}
.room-top {
  display: flex !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: calc(10px * var(--dpi, 1)) !important;
  flex-wrap: nowrap !important;
}
.room-game-left {
  display: flex !important;
  align-items: center !important;
  gap: calc(6px * var(--dpi, 1)) !important;
  min-width: 0 !important;
  flex: 1 1 auto !important;
  overflow: hidden !important;
}
.room-icon {
  width: calc(20px * var(--dpi, 1)) !important;
  height: calc(20px * var(--dpi, 1)) !important;
  border-radius: calc(4px * var(--dpi, 1)) !important;
  flex-shrink: 0 !important;
}
.room-game-left .game-name {
  font-size: calc(11.5px * var(--dpi, 1)) !important;
  padding: calc(2px * var(--dpi, 1)) calc(8px * var(--dpi, 1)) !important;
  border-radius: calc(6px * var(--dpi, 1)) !important;
  max-width: 100% !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
.room-meta {
  display: flex !important;
  align-items: center !important;
  gap: calc(6px * var(--dpi, 1)) !important;
  margin-top: calc(6px * var(--dpi, 1)) !important;
  font-size: calc(11.5px * var(--dpi, 1)) !important;
  max-width: 100% !important;
  overflow: hidden !important;
  white-space: nowrap !important;
}
.room-host-meta {
  font-size: calc(11.5px * var(--dpi, 1)) !important;
  max-width: calc(100px * var(--dpi, 1)) !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
.room-players {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: calc(4px * var(--dpi, 1)) !important;
  margin-top: calc(6px * var(--dpi, 1)) !important;
}
.room-players .player {
  font-size: calc(10.5px * var(--dpi, 1)) !important;
  padding: calc(2px * var(--dpi, 1)) calc(7px * var(--dpi, 1)) !important;
  border-radius: calc(6px * var(--dpi, 1)) !important;
  white-space: normal !important;
  word-break: break-word !important;
}
.no-rooms, .no-rooms-empty, .no-rooms-match {
  padding: calc(16px * var(--dpi, 1)) !important;
  font-size: calc(12.5px * var(--dpi, 1)) !important;
  border-radius: calc(12px * var(--dpi, 1)) !important;
  margin-top: calc(6px * var(--dpi, 1)) !important;
}
.unread-indicator {
  font-size: calc(10px * var(--dpi, 1)) !important;
  min-width: calc(16px * var(--dpi, 1)) !important;
  height: calc(16px * var(--dpi, 1)) !important;
  line-height: calc(16px * var(--dpi, 1)) !important;
}
.server-actions {
  width: var(--server-action-width) !important;
}
.action-btn {
  font-size: calc(13.5px * var(--dpi, 1)) !important;
}
`;
    document.head.appendChild(__styleEl);

    // === PATCH: 房间布局 - 图标跨两行，meta 与游戏名左对齐并微右移 ===
    (function () {
      const __roomPatch = document.createElement("style");
      __roomPatch.id = "lanplay-room-patch";
      __roomPatch.textContent = `
/* --- Patch: 游戏图标扩到第二行，第二行与游戏名对齐并往右微移 --- */
.room-item{
  display: grid;
  grid-template-columns: calc(40px * var(--dpi, 1)) 1fr !important;
  column-gap: calc(10px * var(--dpi, 1)) !important;
  row-gap: 0 !important;
  align-items: start !important;
}
.room-item[style*="display: none"]{
  display: none !important;
}
.room-item .room-top,
.room-item .room-game-left{
  display: contents !important;
}
.room-item .room-icon{
  grid-column: 1 !important;
  grid-row: 1 / span 2 !important;
  width: calc(40px * var(--dpi, 1)) !important;
  height: calc(40px * var(--dpi, 1)) !important;
  border-radius: calc(8px * var(--dpi, 1)) !important;
  align-self: start !important;
  margin: 0 !important;
  object-fit: cover !important;
  flex-shrink: 0 !important;
  cursor: zoom-in !important;
  transition: transform .15s ease, filter .15s ease !important;
}
.room-item .room-icon:hover{
  transform: scale(1.04) !important;
  filter: brightness(1.05) !important;
}
.room-item .room-icon:active{
  transform: scale(0.98) !important;
}
.room-item span.room-icon{
  display: grid !important;
  place-items: center !important;
  line-height: 1 !important;
  font-size: calc(16px * var(--dpi, 1)) !important;
}
.room-item .game-name{
  grid-column: 2 !important;
  grid-row: 1 !important;
  align-self: center !important;
  justify-self: start !important;
  margin: 0 !important;
}
.room-item .room-meta{
  grid-column: 2 !important;
  grid-row: 2 !important;
  margin-top: calc(6px * var(--dpi, 1)) !important;
  margin-left: calc(2px * var(--dpi, 1)) !important;
  padding-left: 0 !important;
  align-self: center !important;
  justify-content: flex-start !important;
}
.room-item .room-players{
  grid-column: 1 / -1 !important;
  margin-top: calc(10px * var(--dpi, 1)) !important;
}
.room-top{ gap: 0 !important; }
`;
      document.head.appendChild(__roomPatch);
    })();

    // ---------- 注入页面结构（原 index.html 的 <body> 内容） ----------
    document.body.innerHTML = `
<div class="page">
  <section class="hero glass">
    <div class="brand-area" id="brandArea">
      <!-- 顺序：主题切换 → 公共聊天 → 在线成员 → 日志 → 添加服务器 → 重置排序 → DPI → 更新 → 安装应用 → 自动展开 → 插件 → 环境变量设置 -->
      <button id="themeToggleBtn" class="theme-toggle" title="切换浅色/深色主题">🌙</button>
      <button id="openPublicChatBtn" class="icon-btn public-chat-btn" title="公共聊天">
        <span class="public-chat-icon">💬</span>
        <span id="publicUnreadBadge" class="online-count-badge zero">0</span>
      </button>
      <button id="onlineMembersBtn" class="icon-btn online-members-btn" title="在线成员">
        <span class="online-icon">👥</span>
        <span id="onlineCountBadge" class="online-count-badge">0</span>
      </button>
      <button id="openLogModalBtn" class="icon-btn" title="查看运行日志">💻</button>
      <button id="openAddModalBtn" class="icon-btn" title="添加自定义服务器">➕</button>
      <button id="resetOrderBtn" class="icon-btn" title="恢复默认排序">🔄</button>
      <button id="dpiToggleBtn" class="icon-btn" title="调节界面缩放 (DPI)">🔍</button>
      <button id="manualUpdateBtn" class="icon-btn" title="点击检查并更新前后端">⬆️</button>
      <button id="pwaInstallBtn" class="icon-btn" title="安装为桌面应用" aria-label="安装为桌面应用" style="display:none;">📲</button>
      <button id="toggleAutoExpandBtn" class="icon-btn" title="切换自动展开房间">📂</button>
      <button id="copyPluginBtn" class="icon-btn" title="点击下载最新版联机插件">🎮</button>
      <button id="envSettingsBtn" class="icon-btn" title="设置环境变量 (GoEasy / CF R2 / 腾讯云 COS)">⚙️</button>
    </div>
    <div class="scan">
      <i id="netDot" class="dot" title="检测网络连接中..."></i>
    </div>
  </section>

  <!-- 在线成员模态框 -->
  <div id="onlineMembersModal" class="custom-modal">
    <div class="custom-modal-box" style="width:min(400px,calc(100% - 32px));">
      <div class="custom-modal-header">
        <span>👥 在线成员 <span id="onlineMembersTitleCount" style="color:var(--cyan);font-weight:700;">(0)</span></span>
        <button id="closeOnlineMembersBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="custom-modal-body" style="padding:12px 16px 16px;">
        <div id="onlineMembersList" class="online-members-list">
          <div class="online-members-empty">暂无在线成员</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 公共聊天模态框 -->
  <div id="publicChatModal" class="custom-modal">
    <div class="custom-modal-box" style="width:min(500px,calc(100% - 32px));">
      <div class="custom-modal-header">
        <span>💬 公共聊天</span>
        <button id="closePublicChatBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="custom-modal-body">
        <div id="publicChatMessages" style="height:300px;overflow-y:auto;background:var(--card);border-radius:12px;padding:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:4px;border:1px solid var(--line);">
          <div style="color:var(--muted);text-align:center;padding:20px;font-size:14px;">暂无消息</div>
        </div>
        <div id="publicChatPlusPanel" class="chat-plus-panel">
          <button type="button" data-plus-action="image">🖼️ 图片</button>
          <button type="button" data-plus-action="video">🎬 视频</button>
          <button type="button" data-plus-action="file">📎 文件</button>
        </div>
        <div class="chat-input-area">
          <button type="button" id="publicChatPlusBtn" class="chat-plus-btn" title="添加附件" disabled>＋</button>
          <textarea id="publicChatInput" rows="1" placeholder="输入公共消息..." style="flex:1;min-width:120px;padding:8px 14px;border-radius:20px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:14px;outline:none;resize:none;overflow-y:hidden;line-height:1.45;max-height:120px;"></textarea>
          <button type="button" id="publicChatVoiceBtn" class="chat-voice-btn" title="录制语音" disabled>🎤</button>
          <button id="publicChatSendBtn" disabled style="padding:8px 20px;border:0;border-radius:20px;background:var(--cyan);color:#fff;font-weight:700;cursor:pointer;transition:var(--transition);">发送</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 日志模态框 -->
  <div id="logModal" class="log-modal">
    <div class="log-box">
      <div class="log-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <span>🖥️ 实时运行日志</span>
          <label class="log-autoscroll-toggle" title="切换是否自动滚动到底部">
            <input type="checkbox" id="logAutoScrollCheckbox" checked style="cursor:pointer;accent-color:var(--cyan);width:14px;height:14px;margin:0;">
            <span>自动滚动</span>
          </label>
        </div>
        <button id="closeLogBtn" class="log-close">✕</button>
      </div>
      <div id="logContent" class="log-content">正在加载日志...</div>
    </div>
  </div>

  <!-- 添加服务器模态框 -->
  <div id="addServerModal" class="custom-modal">
    <div class="custom-modal-box">
      <div class="custom-modal-header">
        <span>➕ 添加自定义服务器</span>
        <button id="closeAddModalBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="custom-modal-body">
        <form id="addServerForm" class="form-grid">
          <div class="form-row">
            <input type="text" id="addId" placeholder="服务器ID (可选，不填自动生成)" pattern="[A-Za-z0-9_ -]{1,64}" title="仅允许字母、数字、下划线、空格和连字符，长度1-64">
          </div>
          <div class="form-row">
            <input type="text" id="addName" placeholder="服务器名称 (必填)" required>
          </div>
          <div class="form-row">
            <input type="text" id="addHost" placeholder="主机地址 (例如: example.com 或 IP)" required>
          </div>
          <div class="form-row-group">
            <input type="number" id="addPort" value="11451" placeholder="端口" required>
            <select id="addType">
              <option value="graphql">GraphQL</option>
              <option value="rest">REST</option>
            </select>
          </div>
          <div class="form-row">
            <input type="text" id="addRegion" placeholder="地区标签 (例如: 🇨🇳 中国 上海，不填默认 🌐 未知)">
          </div>
          <button type="submit" class="submit-btn">
            <span class="spinner"></span>
            <span class="btn-text">立即添加并保存</span>
          </button>
        </form>
      </div>
    </div>
  </div>

  <!-- 删除确认模态框 -->
  <div id="deleteConfirmModal" class="custom-modal">
    <div class="custom-modal-box" style="width:min(380px,calc(100% - 32px));">
      <div class="custom-modal-header">
        <span>⚠️ 确认删除</span>
        <button id="closeDeleteModalBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="custom-modal-body">
        <p id="deleteConfirmText" style="margin:0 0 20px;font-size:14px;color:var(--ink);line-height:1.6;"></p>
        <div style="display:flex;gap:10px;">
          <button id="deleteCancelBtn" style="flex:1;border:0;border-radius:12px;padding:11px;background:rgba(125,175,210,.15);color:var(--ink);font-weight:700;cursor:pointer;font-size:14px;transition:var(--transition);">取消</button>
          <button id="deleteConfirmBtn" style="flex:1;border:0;border-radius:12px;padding:11px;background:var(--red);color:#fff;font-weight:800;cursor:pointer;font-size:14px;transition:var(--transition);display:inline-flex;align-items:center;justify-content:center;gap:6px;">确认删除</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 恢复默认排序模态框 -->
  <div id="resetOrderModal" class="custom-modal">
    <div class="custom-modal-box" style="width:min(380px,calc(100% - 32px));">
      <div class="custom-modal-header">
        <span>🔄 恢复默认排序</span>
        <button id="closeResetModalBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="custom-modal-body">
        <p style="margin:0 0 20px;font-size:14px;color:var(--ink);line-height:1.6;">确定要恢复默认排序吗？服务器卡片与导航栏图标的自定义排序将被清除。</p>
        <div style="display:flex;gap:10px;">
          <button id="resetCancelBtn" style="flex:1;border:0;border-radius:12px;padding:11px;background:rgba(125,175,210,.15);color:var(--ink);font-weight:700;cursor:pointer;font-size:14px;transition:var(--transition);">取消</button>
          <button id="resetConfirmBtn" style="flex:1;border:0;border-radius:12px;padding:11px;background:var(--cyan);color:#fff;font-weight:800;cursor:pointer;font-size:14px;transition:var(--transition);display:inline-flex;align-items:center;justify-content:center;gap:6px;">确认恢复</button>
        </div>
      </div>
    </div>
  </div>

  <!-- DPI 调节模态框 -->
  <div id="dpiModal" class="dpi-modal">
    <div class="dpi-modal-box">
      <div class="dpi-modal-header">
        <span>🔍 缩放调节</span>
        <button id="closeDpiModalBtn" class="dpi-modal-close">✕</button>
      </div>
      <div class="dpi-modal-body">
        <div class="dpi-slider-container">
          <span id="dpiLabel">100%</span>
          <input type="range" id="dpiSlider" min="60" max="150" value="100" step="5">
          <button id="dpiResetBtn" class="dpi-reset-btn">恢复默认 (100%)</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 手动更新前后端模态框 -->
  <div id="updateModal" class="custom-modal">
    <div class="custom-modal-box" style="width:min(420px,calc(100% - 32px));">
      <div class="custom-modal-header">
        <span>⬆️ 手动远程更新</span>
        <button id="closeUpdateModalBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="custom-modal-body" style="display:grid;gap:12px;">
        <p style="margin:0;color:var(--muted);font-size:13px;line-height:1.6;">对比本地与远程哈希值，哈希一致则跳过更新。更新完成后请重启应用。</p>
        <div id="updateStatus" style="display:grid;gap:8px;"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <button id="updateFrontendBtn" style="border:0;border-radius:12px;padding:11px;background:var(--cyan);color:#fff;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;">🖼️ 更新前端</button>
          <button id="updateBackendBtn" style="border:0;border-radius:12px;padding:11px;background:#1a73c0;color:#fff;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;">⚙️ 更新后端</button>
        </div>
        <button id="updateAllBtn" style="border:0;border-radius:12px;padding:11px;background:linear-gradient(135deg,#19c8ae,#1a73c0);color:#fff;font-weight:800;cursor:pointer;">⬆️ 一键更新前后端</button>

      </div>
    </div>
  </div>

  <!-- 环境变量设置模态框 -->
  <div id="envSettingsModal" class="custom-modal">
    <div class="custom-modal-box env-settings-box">
      <div class="custom-modal-header">
        <span>⚙️ 环境变量配置</span>
        <button id="closeEnvSettingsBtn" class="custom-modal-close">✕</button>
      </div>
      <div class="env-settings-body">
        <div class="env-file-hint" id="envFilePath">配置文件：加载中…</div>

        <div class="env-section">
          <div class="env-section-title">💬 GoEasy 聊天配置</div>
          <div class="form-grid">
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">appkey</span> · 聊天应用密钥</label>
              <input type="text" class="env-field" id="envGoEasyAppkey" placeholder="请输入 GoEasy AppKey" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">host</span> · GoEasy 主机</label>
              <input type="text" class="env-field" id="envGoEasyHost" placeholder="请输入 GoEasy 主机" autocomplete="off" spellcheck="false">
            </div>
            <div class="env-save-tip">修改 GoEasy 配置后，需重新加载页面（或重启应用）使聊天重新连接生效。</div>
          </div>
        </div>

        <div class="env-section">
          <div class="env-section-title">🗄️ 对象存储提供方</div>
          <div class="form-grid">
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">provider</span> · 存储桶服务商</label>
              <select class="env-field" id="envStorageProvider">
                <option value="r2">Cloudflare R2</option>
                <option value="cos">腾讯云 COS</option>
              </select>
            </div>
            <div class="env-save-tip">选择聊天媒体 / 头像上传使用的对象存储；仅需填写所选服务商的配置。</div>
          </div>
        </div>

        <div class="env-section" id="envSectionR2">
          <div class="env-section-title">☁️ Cloudflare R2 存储桶配置</div>
          <div class="form-grid">
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">account_id</span> · 账户 ID</label>
              <input type="text" class="env-field" id="envR2AccountId" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-row-group">
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">access_key_id</span></label>
                <input type="text" class="env-field" id="envR2AccessKey" autocomplete="off" spellcheck="false">
              </div>
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">bucket_name</span> · 桶名</label>
                <input type="text" class="env-field" id="envR2Bucket" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">secret_access_key</span> · 密钥</label>
              <input type="password" class="env-field" id="envR2Secret" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">public_url</span> · 公共访问域名</label>
              <input type="text" class="env-field" id="envR2PublicUrl" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-row-group">
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">max_upload_mb</span> · 单文件上限 MB</label>
                <input type="number" class="env-field" id="envR2MaxUploadMb" min="1" step="1">
              </div>
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">max_storage_mb</span> · 桶容量上限 MB</label>
                <input type="number" class="env-field" id="envR2MaxStorageMb" min="1" step="1">
              </div>
            </div>
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">cf_api_token</span> · Cloudflare API Token（可选，自动关闭公共访问）</label>
              <input type="password" class="env-field" id="envR2CfApiToken" autocomplete="off" spellcheck="false">
            </div>
            <div class="env-save-tip">R2 配置保存后立即生效（含容量阈值、上传上限、桶访问地址）。敏感字段已用密码框掩码显示。</div>
          </div>
        </div>

        <div class="env-section" id="envSectionCos">
          <div class="env-section-title">☁️ 腾讯云 COS 存储桶配置</div>
          <div class="form-grid">
            <div class="form-row-group">
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">secret_id</span> · SecretId</label>
                <input type="text" class="env-field" id="envCosSecretId" autocomplete="off" spellcheck="false">
              </div>
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">secret_key</span> · SecretKey</label>
                <input type="password" class="env-field" id="envCosSecretKey" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div class="form-row-group">
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">bucket</span> · 桶名（含 APPID）</label>
                <input type="text" class="env-field" id="envCosBucket" placeholder="例：mybucket-1250000000" autocomplete="off" spellcheck="false">
              </div>
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">region</span> · 地域</label>
                <input type="text" class="env-field" id="envCosRegion" placeholder="例：ap-guangzhou" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">public_url</span> · 公共访问域名（可选，CDN/自定义域名）</label>
              <input type="text" class="env-field" id="envCosPublicUrl" placeholder="留空则使用桶默认域名（需开启公有读）" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-row-group">
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">max_upload_mb</span> · 单文件上限 MB</label>
                <input type="number" class="env-field" id="envCosMaxUploadMb" min="1" step="1">
              </div>
              <div class="form-row">
                <label class="env-field-label"><span class="env-field-key">max_storage_mb</span> · 桶容量上限 MB</label>
                <input type="number" class="env-field" id="envCosMaxStorageMb" min="1" step="1">
              </div>
            </div>
            <div class="env-save-tip">COS 使用 S3 兼容接口与 V4 签名；桶名需包含 APPID 后缀。保存后立即生效。</div>
          </div>
        </div>

        <div class="env-section" id="envSectionSecurity">
          <div class="env-section-title">🔒 安全密码</div>
          <div class="form-grid">
            <div class="form-row">
              <label class="env-field-label"><span class="env-field-key">password</span> · 环境变量配置安全密码（明文）</label>
              <input type="password" class="env-field" id="envSecurityPassword" placeholder="至少 4 位；留空表示清除（仅文件来源）" autocomplete="new-password" spellcheck="false">
            </div>
            <div class="env-save-tip" id="envSecurityTip">用于保护环境变量配置页。也可通过 OS 环境变量 <code>SECURITY_PASSWORD</code> 注入（优先级更高）。保存时会写入 env.json 的 security.password。</div>
          </div>
        </div>

        <button type="button" id="envSettingsSaveBtn" class="submit-btn">
          <span class="spinner"></span>
          <span class="btn-text">💾 保存并应用</span>
        </button>
      </div>
    </div>
  </div>

  <!-- 统计概览 -->
  <div class="overview" id="overview">
    <div class="ov-card servers"><span>在线服务器</span><b id="ovServers">—</b></div>
    <div class="ov-card online"><span>总在线</span><b id="ovOnline">—</b></div>
    <div class="ov-card idle"><span>空闲</span><b id="ovIdle">—</b></div>
    <div class="ov-card rooms"><span>总房间</span><b id="ovRooms">—</b></div>
  </div>

  <div class="filters" id="filters"></div>
  <div class="server-list" id="serverList">
    <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
  </div>
</div>
`;

    // ---------- PWA：Service Worker + 浏览器原生安装提示 ----------
    (function initPwaInstallSupport() {
      const installBtn = document.getElementById("pwaInstallBtn");
      let deferredInstallPrompt = null;
      const isStandalone = function () {
        try {
          return (
            window.matchMedia("(display-mode: standalone)").matches ||
            window.matchMedia("(display-mode: window-controls-overlay)")
              .matches ||
            window.navigator.standalone === true
          );
        } catch (_) {
          return false;
        }
      };

      function hideInstallButton() {
        if (installBtn) installBtn.style.display = "none";
      }
      function showInstallButton() {
        if (installBtn && !isStandalone()) installBtn.style.display = "grid";
      }

      if (isStandalone()) hideInstallButton();

      window.addEventListener("beforeinstallprompt", function (event) {
        // 保存浏览器原生提示，等待用户主动点击导航栏安装按钮。
        event.preventDefault();
        deferredInstallPrompt = event;
        showInstallButton();
      });

      if (installBtn) {
        installBtn.addEventListener("click", async function () {
          if (isStandalone()) {
            hideInstallButton();
            showToast("✅ 当前已作为桌面应用运行", 1800, true);
            return;
          }
          if (!deferredInstallPrompt) {
            showToast(
              "ℹ️ 请使用浏览器菜单中的“安装应用/添加到桌面”",
              2800,
              true,
            );
            return;
          }
          try {
            deferredInstallPrompt.prompt();
            const choice = await deferredInstallPrompt.userChoice;
            if (choice && choice.outcome === "accepted") {
              hideInstallButton();
              showToast("✅ 已确认安装桌面应用", 2200, true);
            }
          } catch (e) {
            console.warn("[PWA] 调起安装提示失败", e);
          } finally {
            deferredInstallPrompt = null;
          }
        });
      }

      window.addEventListener("appinstalled", function () {
        deferredInstallPrompt = null;
        hideInstallButton();
        showToast("✅ LAN-Play 已安装到桌面", 2200, true);
      });

      if (
        "serviceWorker" in navigator &&
        /^https?:$/i.test(window.location.protocol)
      ) {
        window.addEventListener(
          "load",
          function () {
            navigator.serviceWorker
              .register("/service-worker.js", { scope: "/" })
              .then(function (registration) {
                try {
                  registration.update();
                } catch (_) {}
                console.log(
                  "[PWA] Service Worker 已注册，scope=",
                  registration.scope,
                );
              })
              .catch(function (error) {
                console.warn("[PWA] Service Worker 注册失败", error);
              });
          },
          { once: true },
        );
      }
    })();

    // ---------- 按需加载 GoEasy SDK（原 <head> 中的 goeasy.min.js） ----------
    function ensureGoEasySdk(cb) {
      if (typeof GoEasy !== "undefined") {
        if (typeof cb === "function") cb();
        return;
      }
      const __sdkEl = document.createElement("script");
      __sdkEl.src = "https://cdn.goeasy.io/goeasy-2.13.3.min.js";
      __sdkEl.onload = function () {
        if (typeof cb === "function") cb();
      };
      __sdkEl.onerror = function () {
        if (typeof cb === "function") cb();
      };
      document.head.appendChild(__sdkEl);
    }

    document.addEventListener("contextmenu", (e) => {
      // 播放器控件（视频/语音按钮、进度条）不是正文：长按不呼出系统复制/选择菜单
      if (
        e.target &&
        e.target.closest &&
        e.target.closest(".chat-video-wrap, .audio-player-ui")
      ) {
        e.preventDefault();
        return;
      }
      // 允许输入框、文本区域与聊天气泡长按呼出复制/粘贴/选择菜单
      if (
        e.target &&
        (e.target.closest(".chat-msg") ||
          e.target.closest(".chat-input") ||
          e.target.closest("input, textarea, select, .log-content"))
      ) {
        return;
      }
      e.preventDefault();
    });
    document.addEventListener("selectstart", (e) => {
      // 播放器控件上不启动文字选择，防止长按播放键弹出“复制”
      if (
        e.target &&
        e.target.closest &&
        e.target.closest(".chat-video-wrap, .audio-player-ui")
      ) {
        e.preventDefault();
        return;
      }
      // 允许输入框、文本区域与聊天气泡内文字自由选择与复制
      if (
        e.target &&
        (e.target.closest(".chat-msg") ||
          e.target.closest(".chat-input") ||
          e.target.closest("input, textarea, select, .log-content"))
      ) {
        return;
      }
      e.preventDefault();
    });

    const CHAT_STORAGE_KEY = "lanplay_chat_messages";
    const PUBLIC_STORAGE_KEY = "lanplay_public_messages";
    const USERNAME_KEY = "lan_play_username";
    const USER_ID_KEY = "lan_play_user_id";
    const KNOWN_USER_IDS_KEY = "lan_play_known_user_ids";
    const USER_PROFILES_BY_ID_KEY = "lan_play_user_profiles_by_id"; // userId -> {username, avatar}
    const AVATAR_KEY = "lan_play_avatar";
    const UNREAD_STORAGE_KEY = "lanplay_unread_status";
    const PUBLIC_UNREAD_KEY = "lanplay_public_unread";
    const AUTO_EXPAND_KEY = "lan_play_auto_expand";
    const HISTORY_LIMIT = 30;

    const state = {
      servers: [],
      rooms: [],
      game: "all",
      expanded: new Set(),
      loading: false,
      firstLoad: true,
      firstExpand: true,
      _domCache: new Map(),
      _defaultOrder: null,
      pollInterval: null,
      pollPaused: false,
      chatMessages: {},
      chatSubscribed: {},
      chatSubscribing: {}, // serverId -> true，防止订阅成功前被每秒渲染重复订阅
      goEasyReady: false,
      goEasyRetries: 0,
      goEasyConfig: {}, // 来自 /api/env 的 goeasy 配置 {appkey, host, force_tls}
      r2Config: {}, // 来自 /api/env 的存储桶上传限制（R2 或腾讯云 COS，当前生效提供方）
      storageConfig: {}, // 来自 /api/env 的 storage 配置 {provider: 'r2'|'cos'}
      publicMessages: [],
      publicChatReady: false,
      publicChatSubscribing: false,
      username: "",
      userId: "",
      avatar: "",
      hasChatHistoryCache: false,
      hasPublicHistoryCache: false,
      forceHistoryOnce: false, // 换回曾用过的用户 ID 时拉一次历史
      usernameConflictOpen: false,
      usernameConflictOffline: false, // 用户名冲突导致主动下线，改名后才重连
      pendingSelfConflictCheck: false, // 仅自己上线后检查一次，避免对方上线时双方都弹窗
      pendingAttachments: {},
      publicModalOpen: false,
      frozenCardId: null,
      unreadStatus: {},
      autoExpand: false,
      onlineMembers: [],
      onlineCount: 0,
      presenceReady: false,
      memberProfiles: {}, // userId -> {nickname, avatar} 覆盖 hereNow 旧资料
    };

    // 自动展开默认关闭；首次升级时清理旧版本默认写入的 true。
    const AUTO_EXPAND_DEFAULT_VERSION_KEY = "lan_play_auto_expand_default_v2";
    const savedAuto = localStorage.getItem(AUTO_EXPAND_KEY);
    const autoExpandDefaultMigrated =
      localStorage.getItem(AUTO_EXPAND_DEFAULT_VERSION_KEY) === "1";
    if (!autoExpandDefaultMigrated) {
      state.autoExpand = false;
      localStorage.setItem(AUTO_EXPAND_KEY, "false");
      localStorage.setItem(AUTO_EXPAND_DEFAULT_VERSION_KEY, "1");
    } else if (savedAuto !== null) {
      state.autoExpand = savedAuto === "true";
    } else {
      state.autoExpand = false;
      localStorage.setItem(AUTO_EXPAND_KEY, "false");
    }

    const $ = (id) => document.getElementById(id);
    const esc = (v) =>
      String(v ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );

    const generateMsgId = () =>
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).substring(2, 8);

    const QUESTION_ICON_DATA =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
          '<circle cx="24" cy="24" r="22" fill="#34495e"/>' +
          '<text x="24" y="34" text-anchor="middle" font-size="30" fill="white" font-family="sans-serif" font-weight="bold">?</text>' +
          "</svg>",
      );
    const UNKNOWN_ID = "FFFFFFFFFFFFFFFF";

    // 标题 ID 形态：16 位十六进制
    const TITLE_ID_RE = /^[0-9A-F]{16}$/;

    /**
     * 房间显示用的游戏名。
     * - 有映射            → 映射名
     * - 无映射但有标题 ID → 直接显示标题 ID（不再显示「未知游戏」）
     * - 连 ID 都没有      → 「未知游戏」
     * 同时兼容旧后端返回的 "未知游戏 (0100XXXX...)" 形式。
     */
    function resolveRoomGameLabel(room) {
      const raw = (room && room.game == null ? "" : String(room.game)).trim();
      const cid = String((room && room.content_id) || "").toUpperCase();
      const hasId = !!cid && cid !== UNKNOWN_ID;

      // 旧后端占位名：未知游戏 / 未知游戏 (TITLEID) / 其它「未知」开头占位
      if (!raw || /^未知/.test(raw)) {
        return hasId ? cid : "未知游戏";
      }
      return raw;
    }


    // ---------- 滚动位置存储（聊天用） ----------
    const CHAT_SCROLL_PREFIX = "lanplay_chat_scroll_";
    const PUBLIC_SCROLL_KEY = "lanplay_public_scroll";

    function saveChatScroll(serverId, scrollTop) {
      try {
        localStorage.setItem(CHAT_SCROLL_PREFIX + serverId, String(scrollTop));
      } catch (e) {}
    }
    function getChatScroll(serverId) {
      try {
        const v = localStorage.getItem(CHAT_SCROLL_PREFIX + serverId);
        return v !== null ? parseInt(v, 10) : null;
      } catch (e) {
        return null;
      }
    }
    function savePublicScroll(scrollTop) {
      try {
        localStorage.setItem(PUBLIC_SCROLL_KEY, String(scrollTop));
      } catch (e) {}
    }
    function getPublicScroll() {
      try {
        const v = localStorage.getItem(PUBLIC_SCROLL_KEY);
        return v !== null ? parseInt(v, 10) : null;
      } catch (e) {
        return null;
      }
    }

    // ---------- Toast ----------
    let _globalToast = null;
    let _globalToastTimer = null;

    function _dismissToast() {
      if (_globalToast && _globalToast.parentElement) {
        try {
          _globalToast.parentElement.removeChild(_globalToast);
        } catch (e) {}
      }
      _globalToast = null;
      if (_globalToastTimer) {
        clearTimeout(_globalToastTimer);
        _globalToastTimer = null;
      }
    }

    function showToast(text, duration, isSuccess) {
      _dismissToast();
      const t = document.createElement("div");
      t.className = "global-copy-toast";
      if (isSuccess === true) t.classList.add("success");
      else if (isSuccess === false) t.classList.add("error");
      t.textContent = text || "✓ 已复制";
      document.body.appendChild(t);
      t.offsetHeight;
      t.classList.add("show");
      _globalToast = t;
      const dur = duration || 2000;
      _globalToastTimer = setTimeout(() => {
        t.classList.remove("show");
        setTimeout(() => {
          if (_globalToast === t) _dismissToast();
        }, 300);
      }, dur);
    }

    // ---------- 复制功能 ----------
    function copyServerName(text, el) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(String(text))
          .then(() => showToast("📋 已复制服务器名称: " + text))
          .catch(() => fallbackCopyName(String(text)));
      } else {
        fallbackCopyName(String(text));
      }
    }
    function fallbackCopyName(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {}
      document.body.removeChild(ta);
      showToast("📋 已复制服务器名称: " + text);
    }

    function copyServerAddress(text, el) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(String(text))
          .then(() => showToast("🔗 已复制服务器地址: " + text))
          .catch(() => fallbackCopyAddress(String(text)));
      } else {
        fallbackCopyAddress(String(text));
      }
    }
    function fallbackCopyAddress(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {}
      document.body.removeChild(ta);
      showToast("🔗 已复制服务器地址: " + text);
    }

    function copyWithMessage(text, successMsg) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(String(text))
          .then(() => showToast(successMsg || "✓ 已复制"))
          .catch(() => fallbackCopyWithMessage(String(text), successMsg));
      } else {
        fallbackCopyWithMessage(String(text), successMsg);
      }
    }
    function fallbackCopyWithMessage(text, successMsg) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {}
      document.body.removeChild(ta);
      showToast(successMsg || "✓ 已复制");
    }

    // ===== 主题切换（已修复 v7：单例 + 实时同步状态栏 + 修复点击无反应） =====
    const themeToggleBtn = $("themeToggleBtn");
    const htmlEl = document.documentElement;

    function _getSavedManualThemeCompat() {
      try {
        const v = localStorage.getItem("lan_play_theme");
        if (v === "light" || v === "dark") return v;
        if (v === "auto") return null;
      } catch (e) {}
      return null;
    }
    function _fetchSystemDarkFromJavaCompat() {
      try {
        if (
          window.LanPlayNative &&
          typeof window.LanPlayNative.getInfo === "function"
        ) {
          const raw = window.LanPlayNative.getInfo();
          const info = JSON.parse(raw);
          if (info && typeof info.isSystemDark === "boolean")
            return info.isSystemDark;
        }
      } catch (e) {}
      return null;
    }
    function _resolveThemeCompat() {
      const manual = _getSavedManualThemeCompat();
      if (manual) return manual;
      const fromJava = _fetchSystemDarkFromJavaCompat();
      if (fromJava !== null) return fromJava ? "dark" : "light";
      try {
        const cached = localStorage.getItem("lanplay_system_dark");
        if (cached === "1") return "dark";
        if (cached === "0") return "light";
      } catch (e) {}
      if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      )
        return "dark";
      return "light";
    }
    function _applyThemeToDomCompat(theme) {
      if (!htmlEl) return;
      if (theme === "dark") {
        htmlEl.classList.add("dark");
        htmlEl.classList.remove("light");
      } else if (theme === "light") {
        htmlEl.classList.add("light");
        htmlEl.classList.remove("dark");
      } else {
        htmlEl.classList.remove("light", "dark");
      }
    }
    function _pushThemeToJavaCompat(theme) {
      try {
        if (
          window.LanPlayNative &&
          typeof window.LanPlayNative.syncPageTheme === "function"
        ) {
          window.LanPlayNative.syncPageTheme(theme === "dark");
        }
      } catch (e) {}
    }
    function _syncStatusBarFromDom(isDark) {
      _pushThemeToJavaCompat(isDark ? "dark" : "light");
    }

    // 兼容兜底：顶部 IIFE 可能没来得及写 html class
    const __savedThemeCompat = _getSavedManualThemeCompat();
    if (__savedThemeCompat) {
      if (__savedThemeCompat === "dark") {
        htmlEl.classList.add("dark");
        htmlEl.classList.remove("light");
      } else if (__savedThemeCompat === "light") {
        htmlEl.classList.add("light");
        htmlEl.classList.remove("dark");
      }
    }

    window.updateThemeColor =
      window.updateThemeColor ||
      function () {
        const isDark = htmlEl.classList.contains("dark");
        const color = isDark ? "#0f1923" : "#dff3ff";
        document
          .querySelectorAll('meta[name="theme-color"]')
          .forEach((m) => m.remove());
        const meta = document.createElement("meta");
        meta.name = "theme-color";
        meta.content = color;
        document.head.appendChild(meta);
        const iosMeta = document.querySelector(
          'meta[name="apple-mobile-web-app-status-bar-style"]',
        );
        if (iosMeta) iosMeta.content = isDark ? "black-translucent" : "default";
        _syncStatusBarFromDom(isDark);
      };
    function updateThemeColor() {
      return window.updateThemeColor();
    }

    window.updateThemeIcon =
      window.updateThemeIcon ||
      function () {
        const manual = localStorage.getItem("lan_play_theme");
        const isDark =
          htmlEl.classList.contains("dark") ||
          (!manual &&
            window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches);
        if (themeToggleBtn) themeToggleBtn.textContent = isDark ? "🌞" : "🌙";
      };
    function updateThemeIcon() {
      return window.updateThemeIcon();
    }

    updateThemeIcon();
    updateThemeColor();

    let scrollColorTimer = null;
    document.addEventListener(
      "scroll",
      () => {
        if (scrollColorTimer) cancelAnimationFrame(scrollColorTimer);
        scrollColorTimer = requestAnimationFrame(() => {
          if (!localStorage.getItem("lan_play_theme")) {
            updateThemeColor();
          }
          scrollColorTimer = null;
        });
      },
      { passive: true },
    );

    // 单例绑定：确保只绑定一次，点击真正生效
    function bindThemeToggle() {
      if (!themeToggleBtn) return false;
      if (themeToggleBtn.dataset.__themeBound === "1") return true;
      themeToggleBtn.dataset.__themeBound = "1";

      // 点击：light -> dark -> 跟随系统 三态
      themeToggleBtn.addEventListener("click", (e) => {
        // 如果正在拖拽导航栏，忽略点击
        if (themeToggleBtn.classList.contains("nav-dragging")) return;
        e.preventDefault();
        e.stopPropagation();
        const manual = _getSavedManualThemeCompat();
        let next;
        if (!manual) {
          const curIsDark =
            htmlEl.classList.contains("dark") ||
            (!htmlEl.classList.contains("light") &&
              window.matchMedia &&
              window.matchMedia("(prefers-color-scheme: dark)").matches);
          next = curIsDark ? "light" : "dark";
          try {
            localStorage.setItem("lan_play_theme", next);
          } catch (e2) {}
        } else if (manual === "light") {
          next = "dark";
          try {
            localStorage.setItem("lan_play_theme", "dark");
          } catch (e2) {}
        } else {
          try {
            localStorage.removeItem("lan_play_theme");
          } catch (e2) {}
          next = _resolveThemeCompat();
        }
        _applyThemeToDomCompat(next);
        _pushThemeToJavaCompat(next);
        updateThemeIcon();
        updateThemeColor();
        // 轻微缩放动效
        document.body.style.transform = "scale(0.999)";
        const hero = document.querySelector(".hero");
        if (hero) hero.style.transform = "scale(0.999)";
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            document.body.style.transform = "";
            if (hero) hero.style.transform = "";
          }),
        );
        try {
          if (typeof showToast === "function") {
            const label = !localStorage.getItem("lan_play_theme")
              ? "已切换为跟随系统"
              : next === "dark"
                ? "已切换为深色"
                : "已切换为浅色";
            showToast(label, 1200, true);
          }
        } catch (e2) {}
      });

      // 长按 600ms 回到跟随系统
      let lpTimer = null,
        sx = 0,
        sy = 0;
      themeToggleBtn.addEventListener("pointerdown", (ev) => {
        if (ev.button != null && ev.button !== 0) return;
        sx = ev.clientX;
        sy = ev.clientY;
        lpTimer = setTimeout(() => {
          // 若本次长按是导航栏图标排序拖拽（380ms 已进入拖拽），则取消主题的“回到跟随系统”长按，
          // 避免长按排序时误触发主题切换/重置。
          if (
            themeToggleBtn.classList.contains("nav-dragging") ||
            (themeToggleBtn.closest("#brandArea") &&
              themeToggleBtn
                .closest("#brandArea")
                .classList.contains("nav-reordering"))
          ) {
            lpTimer = null;
            return;
          }
          try {
            localStorage.removeItem("lan_play_theme");
          } catch (e3) {}
          const next = _resolveThemeCompat();
          _applyThemeToDomCompat(next);
          _pushThemeToJavaCompat(next);
          updateThemeIcon();
          updateThemeColor();
          try {
            if (navigator.vibrate) navigator.vibrate(20);
          } catch (e3) {}
          try {
            if (typeof showToast === "function")
              showToast("已切换为跟随系统", 1500, true);
          } catch (e3) {}
          // 阻止随后的 click
          const blocker = (e4) => {
            e4.preventDefault();
            e4.stopImmediatePropagation();
          };
          themeToggleBtn.addEventListener("click", blocker, {
            capture: true,
            once: true,
          });
          setTimeout(() => {
            try {
              themeToggleBtn.removeEventListener("click", blocker, {
                capture: true,
              });
            } catch (e3) {}
          }, 700);
        }, 600);
      });
      ["pointerup", "pointercancel", "pointerleave", "pointermove"].forEach(
        (evName) => {
          themeToggleBtn.addEventListener(
            evName,
            (ev) => {
              if (evName === "pointermove" && lpTimer) {
                const dx = ev.clientX - sx,
                  dy = ev.clientY - sy;
                if (dx * dx + dy * dy > 64) {
                  clearTimeout(lpTimer);
                  lpTimer = null;
                }
              } else {
                clearTimeout(lpTimer);
                lpTimer = null;
              }
            },
            { passive: true },
          );
        },
      );

      return true;
    }

    // 立即尝试绑定 + DOMContentLoaded 再试一次，解决之前嵌套 DOMContentLoaded 导致不触发的 bug
    if (!bindThemeToggle()) {
      document.addEventListener("DOMContentLoaded", bindThemeToggle);
    } else {
      // 即使已绑定，也再监听一次以防按钮被重新渲染
      document.addEventListener("DOMContentLoaded", bindThemeToggle);
    }
    // 暴露给顶部 IIFE 或外部调用
    window.__bindThemeToggle = bindThemeToggle;

    // ===== DPI 缩放 =====
    const dpiToggleBtn = document.getElementById("dpiToggleBtn");
    const dpiModal = document.getElementById("dpiModal");
    const closeDpiModalBtn = document.getElementById("closeDpiModalBtn");
    const dpiSlider = document.getElementById("dpiSlider");
    const dpiLabel = document.getElementById("dpiLabel");
    const dpiResetBtn = document.getElementById("dpiResetBtn");
    const DPI_STORAGE_KEY = "lan_play_dpi_percent";

    if (dpiToggleBtn) dpiToggleBtn.textContent = "🔍";
    let currentDpiPercent =
      parseInt(localStorage.getItem(DPI_STORAGE_KEY), 10) || 100;

    function applyDpi(percent) {
      const clamped = Math.min(150, Math.max(60, percent));
      const scale = clamped / 100;
      const serverList = document.getElementById("serverList");
      if (serverList) {
        serverList.style.zoom = "";
        serverList.style.transform = "";
        serverList.style.transformOrigin = "";
        serverList.style.width = "100%";
        // 核心：设置 CSS 变量 --dpi，卡片宽度保持 100% 贴满屏幕，内部元素自适应等比缩放
        serverList.style.setProperty("--dpi", String(scale));
        // DPI 改变后操作区宽度也会改变；同步已打开卡片，避免再次出现宽度差和色缝。
        requestAnimationFrame(function () {
          serverList
            .querySelectorAll(".server-group")
            .forEach(function (card) {
              if (typeof card._syncSwipe === "function") card._syncSwipe();
            });
        });
      }
      // 若 DOM 中残留有旧的 __dpiWrap，则解包移除
      const wrapper = document.getElementById("__dpiWrap");
      if (wrapper && serverList && wrapper.contains(serverList)) {
        wrapper.parentNode.insertBefore(serverList, wrapper);
        wrapper.remove();
      }
      document.body.style.overflowX = "hidden";
      if (dpiLabel) dpiLabel.textContent = Math.round(clamped) + "%";
      if (dpiSlider) dpiSlider.value = clamped;
      localStorage.setItem(DPI_STORAGE_KEY, String(clamped));
      currentDpiPercent = clamped;
    }
    applyDpi(currentDpiPercent);

    if (dpiToggleBtn && dpiModal) {
      dpiToggleBtn.addEventListener("click", () => {
        dpiModal.classList.add("open");
        if (dpiSlider) dpiSlider.value = currentDpiPercent;
        if (dpiLabel)
          dpiLabel.textContent = Math.round(currentDpiPercent) + "%";
      });
    }

    function closeDpiModal() {
      if (dpiModal) dpiModal.classList.remove("open");
    }
    if (closeDpiModalBtn)
      closeDpiModalBtn.addEventListener("click", closeDpiModal);
    if (dpiSlider) {
      dpiSlider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        applyDpi(val);
      });
    }

    if (dpiResetBtn) {
      dpiResetBtn.addEventListener("click", () => {
        applyDpi(100);
        showToast("✅ 已恢复默认缩放 (100%)", 1500, true);
      });
    }

    try {
      const oldIndex = localStorage.getItem("lan_play_dpi_index");
      if (oldIndex !== null) {
        const levels = [0.8, 0.9, 1.0, 1.1, 1.2];
        const idx = parseInt(oldIndex, 10);
        if (!isNaN(idx) && idx >= 0 && idx < levels.length) {
          const pct = levels[idx] * 100;
          localStorage.setItem(DPI_STORAGE_KEY, String(pct));
          applyDpi(pct);
        }
        localStorage.removeItem("lan_play_dpi_index");
      }
    } catch (e) {
      /* ignore */
    }

    // ===== 插件链接下载 =====
    // 统一下载入口会先检测访问网络：公网交给浏览器，局域网使用内置下载器。
    const PLUGIN_DOWNLOAD_URL =
      "https://www.tomodachilife.cn/downloads/ldn-mitm/latest";
    // 已知该 URL 永远返回 application/zip 压缩包
    // 提前写好 .zip 后缀，避免 HEAD 请求被 CORS/中间件拦截时丢失扩展名
    const PLUGIN_DOWNLOAD_NAME = "ldn-mitm-latest.zip";
    function downloadPlugin() {
      _builtInDownload(PLUGIN_DOWNLOAD_URL, PLUGIN_DOWNLOAD_NAME, false);
    }
    $("copyPluginBtn").addEventListener("click", downloadPlugin);

    // ===== 模态框管理 =====
    const addServerModal = $("addServerModal");
    $("openAddModalBtn").addEventListener("click", () =>
      addServerModal.classList.add("open"),
    );
    $("closeAddModalBtn").addEventListener("click", () =>
      addServerModal.classList.remove("open"),
    );

    // ============================================================
    // ★★★ 严格 IPv4 校验 ★★★
    // ============================================================
    function isValidHost(host) {
      if (!host || !host.trim()) return false;
      const trimmed = host.trim();
      if (/^[\d.]+$/.test(trimmed)) {
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) return false;
        const parts = trimmed.split(".");
        return parts.every((p) => {
          const num = parseInt(p, 10);
          return num >= 0 && num <= 255 && p === String(num);
        });
      }
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const ipv6 = trimmed.slice(1, -1);
        return /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::|^([0-9a-fA-F]{1,4}:){1,7}:$/.test(
          ipv6,
        );
      }
      return /^(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/.test(trimmed);
    }

    // ===== 自动解析 host:port =====
    function setupHostPortAutoFill(hostInput, portInput) {
      if (!hostInput || !portInput) return;
      hostInput.addEventListener("input", function (e) {
        const value = this.value.trim();
        if (value.includes(":")) {
          const parts = value.split(":");
          if (parts.length === 2) {
            const hostPart = parts[0].trim();
            const portPart = parts[1].trim();
            if (hostPart && /^\d+$/.test(portPart)) {
              const portNum = parseInt(portPart, 10);
              if (portNum >= 1 && portNum <= 65535) {
                this.value = hostPart;
                portInput.value = portNum;
              }
            }
          }
        }
      });
    }

    // ===== 添加服务器（含 ID） =====
    $("addServerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = e.target.querySelector(".submit-btn");
      if (submitBtn.classList.contains("loading")) return;

      const id = document.getElementById("addId").value.trim();
      const name = document.getElementById("addName").value.trim();
      const host = document.getElementById("addHost").value.trim();
      const port = parseInt(document.getElementById("addPort").value) || 11451;
      const type = document.getElementById("addType").value;
      const region = document.getElementById("addRegion").value.trim();

      if (id && !/^[A-Za-z0-9_ -]{1,64}$/.test(id)) {
        showToast(
          "❌ ID 格式无效，仅允许字母、数字、下划线、空格和连字符，长度1-64",
          2500,
          false,
        );
        document.getElementById("addId").focus();
        return;
      }
      if (!name) {
        showToast("❌ 请输入服务器名称", 2500, false);
        document.getElementById("addName").focus();
        return;
      }
      if (!isValidHost(host)) {
        showToast("❌ 请输入有效的主机地址（域名或IP）", 2500, false);
        document.getElementById("addHost").focus();
        return;
      }

      submitBtn.classList.add("loading");
      submitBtn.disabled = true;
      const btnTextEl = submitBtn.querySelector(".btn-text");
      const originalText = btnTextEl.textContent;
      btnTextEl.textContent = "提交中...";

      try {
        const res = await fetch("/api/servers/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: id || undefined,
            name,
            host,
            port,
            type,
            region,
          }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.ok) throw new Error(d.error || "添加失败");
        document.getElementById("addId").value = "";
        document.getElementById("addName").value = "";
        document.getElementById("addHost").value = "";
        document.getElementById("addRegion").value = "";
        addServerModal.classList.remove("open");
        await load(true);
        showToast("✅ 服务器「" + name + "」添加成功！", 2000, true);
      } catch (err) {
        showToast("❌ 添加失败：" + err.message, 2500, false);
      } finally {
        submitBtn.classList.remove("loading");
        submitBtn.disabled = false;
        btnTextEl.textContent = originalText;
      }
    });

    // ===== 删除确认 =====
    const deleteModal = $("deleteConfirmModal");
    let pendingDelete = null;
    function openDeleteConfirm(serverId, serverName, cardEl) {
      pendingDelete = { id: serverId, name: serverName, cardEl };
      document.getElementById("deleteConfirmText").textContent =
        `确定要删除服务器「${serverName}」吗？此操作不可恢复。`;
      deleteModal.classList.add("open");
    }
    document
      .getElementById("closeDeleteModalBtn")
      .addEventListener("click", () => {
        deleteModal.classList.remove("open");
        pendingDelete = null;
      });
    document.getElementById("deleteCancelBtn").addEventListener("click", () => {
      deleteModal.classList.remove("open");
      pendingDelete = null;
    });

    document
      .getElementById("deleteConfirmBtn")
      .addEventListener("click", async () => {
        if (!pendingDelete) return;
        const { id, name } = pendingDelete;
        deleteModal.classList.remove("open");
        pendingDelete = null;

        const btn = document.getElementById("deleteConfirmBtn");
        const originalText = btn.textContent;
        btn.textContent = "提交中...";
        btn.disabled = true;

        try {
          const res = await fetch("/api/servers/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const d = await res.json().catch(() => ({}));
          if (!res.ok || !d.ok) throw new Error(d.error || "删除失败");
          // 立刻从本地状态与缓存剔除，避免多实例/旧 cache 造成「删了还在」
          try {
            state.servers = (state.servers || []).filter(function (s) {
              return s && s.id !== id;
            });
            state.rooms = (state.rooms || []).filter(function (r) {
              return r && r.server_id !== id;
            });
            if (state._domCache && state._domCache.get) {
              var el = state._domCache.get(id);
              if (el && el.remove) el.remove();
              state._domCache.delete(id);
            }
            localStorage.setItem(
              "lan_play_cache_servers",
              JSON.stringify(state.servers),
            );
            localStorage.setItem(
              "lan_play_cache_rooms",
              JSON.stringify(state.rooms),
            );
            var orderRaw = localStorage.getItem("lan_play_server_order");
            if (orderRaw) {
              var orderArr = JSON.parse(orderRaw);
              if (Array.isArray(orderArr)) {
                localStorage.setItem(
                  "lan_play_server_order",
                  JSON.stringify(orderArr.filter(function (x) { return x !== id; })),
                );
              }
            }
            render();
          } catch (cacheErr) {
            console.warn("[删除] 清理本地缓存失败", cacheErr);
          }
          await load(true);
          showToast("🗑️ 服务器「" + name + "」删除成功！", 2000, true);
        } catch (e) {
          showToast("❌ 删除失败：" + e.message, 2500, false);
        } finally {
          btn.textContent = originalText;
          btn.disabled = false;
        }
      });

    // ===== 导航栏图标长按拖动排序 =====
    const NAV_ORDER_KEY = "lan_play_nav_order";
    const DEFAULT_NAV_ORDER = [
      "themeToggleBtn",
      "openPublicChatBtn",
      "onlineMembersBtn",
      "openLogModalBtn",
      "openAddModalBtn",
      "resetOrderBtn",
      "dpiToggleBtn",
      "manualUpdateBtn",
      "pwaInstallBtn",
      "toggleAutoExpandBtn",
      "copyPluginBtn",
    ];

    function applyNavOrder(order) {
      const area = document.getElementById("brandArea");
      if (!area || !Array.isArray(order) || !order.length) return;
      const map = {};
      [...area.children].forEach((el) => {
        if (el.id) map[el.id] = el;
      });
      order.forEach((id) => {
        if (map[id]) {
          area.appendChild(map[id]);
          delete map[id];
        }
      });
      // 未在保存列表中的图标（新版本新增）追加到末尾，保持相对稳定
      Object.keys(map).forEach((id) => area.appendChild(map[id]));
    }

    function saveNavOrder() {
      const area = document.getElementById("brandArea");
      if (!area) return;
      const ids = [...area.children].map((el) => el.id).filter(Boolean);
      try {
        localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(ids));
      } catch (e) {
        /* ignore */
      }
    }

    function loadNavOrder() {
      try {
        const raw = localStorage.getItem(NAV_ORDER_KEY);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) applyNavOrder(arr);
      } catch (e) {
        /* ignore */
      }
    }

    function resetNavOrder() {
      try {
        localStorage.removeItem(NAV_ORDER_KEY);
      } catch (e) {
        /* ignore */
      }
      applyNavOrder(DEFAULT_NAV_ORDER);
    }

    function initNavIconReorder() {
      const area = document.getElementById("brandArea");
      if (!area || area.dataset.navDragBound === "1") return;
      area.dataset.navDragBound = "1";

      let dragEl = null;
      let longPressTimer = null;
      let startX = 0;
      let startY = 0;
      let dragging = false;
      let suppressClick = false;
      let activePointerId = null;
      let ghostEl = null;
      let lastX = 0;
      let lastY = 0;
      let autoScrollRAF = null;
      let scrollPanning = false;

      function clearTimer() {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }

      function clearDragOver() {
        area
          .querySelectorAll(".nav-drag-over")
          .forEach((el) => el.classList.remove("nav-drag-over"));
      }

      function removeGhost() {
        if (ghostEl) {
          try {
            ghostEl.remove();
          } catch (_) {
            /* ignore */
          }
          ghostEl = null;
        }
      }

      function moveGhost(x, y) {
        if (!ghostEl) return;
        ghostEl.style.left = x + "px";
        ghostEl.style.top = y + "px";
      }

      function createGhost(btn, x, y) {
        removeGhost();
        const g = document.createElement("div");
        g.className = "nav-drag-ghost";
        // 只复制可见图标文字/emoji，避免角标干扰
        const icon =
          btn.querySelector(".public-chat-icon, .online-icon") || null;
        g.textContent = icon
          ? icon.textContent.trim()
          : (btn.textContent || "").trim().charAt(0) || "•";
        // 若按钮本身就是 emoji（无子 span），取完整文本首个非空白
        if (!icon) {
          const t =
            btn.childNodes && btn.childNodes.length
              ? [...btn.childNodes]
                  .filter((n) => n.nodeType === 3)
                  .map((n) => n.textContent.trim())
                  .join("")
              : "";
          if (t) g.textContent = t;
          else if (btn.firstChild && btn.firstChild.nodeType === 3)
            g.textContent = btn.firstChild.textContent.trim();
          else {
            // 回退：去掉角标数字后的文本
            const clone = btn.cloneNode(true);
            clone
              .querySelectorAll(
                ".online-count-badge, #publicUnreadBadge, #onlineCountBadge",
              )
              .forEach((n) => n.remove());
            g.textContent = (clone.textContent || "•").trim() || "•";
          }
        }
        g.style.left = x + "px";
        g.style.top = y + "px";
        document.body.appendChild(g);
        ghostEl = g;
      }

      function endDragVisual() {
        stopAutoScroll();
        clearDragOver();
        if (dragEl) dragEl.classList.remove("nav-dragging");
        area.classList.remove("nav-reordering");
        removeGhost();
      }

      function getBtnFromPoint(x, y) {
        // 拖影 pointer-events:none，可直接取下方元素
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const btn = el.closest("#brandArea > button");
        return btn && area.contains(btn) ? btn : null;
      }

      function restoreAreaTouchAction() {
        try {
          area.style.touchAction = "";
        } catch (_) {
          /* ignore */
        }
        area.classList.remove("nav-holding");
      }

      // ---- 拖拽时靠近左右边缘自动翻滚导航栏 ----
      function stopAutoScroll() {
        if (autoScrollRAF) {
          cancelAnimationFrame(autoScrollRAF);
          autoScrollRAF = null;
        }
      }

      function tickAutoScroll() {
        autoScrollRAF = null;
        if (!dragging || !dragEl) return;
        const rect = area.getBoundingClientRect();
        const EDGE = 56; // 触发自动翻滚的边缘距离（px）
        const MAX_SPEED = 14; // 每帧最大滚动像素（越贴近边缘越快）
        let scrollBy = 0;
        if (rect.width > 0) {
          if (lastX < rect.left + EDGE) {
            const d = rect.left + EDGE - lastX;
            scrollBy = -Math.min(MAX_SPEED, Math.round((d / EDGE) * MAX_SPEED));
          } else if (lastX > rect.right - EDGE) {
            const d = lastX - (rect.right - EDGE);
            scrollBy = Math.min(MAX_SPEED, Math.round((d / EDGE) * MAX_SPEED));
          }
        }
        if (scrollBy !== 0) {
          area.scrollLeft += scrollBy;
          // 滚动后指针下方的图标可能已变化，刷新落点高亮
          clearDragOver();
          const over = getBtnFromPoint(lastX, lastY);
          if (over && over !== dragEl) over.classList.add("nav-drag-over");
        }
        autoScrollRAF = requestAnimationFrame(tickAutoScroll);
      }

      function onPointerDown(e) {
        if (e.button != null && e.button !== 0) return;
        const btn = e.target.closest("#brandArea > button");
        if (!btn || !area.contains(btn)) return;
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        lastX = e.clientX;
        lastY = e.clientY;
        dragging = false;
        dragEl = null;
        scrollPanning = false;
        clearTimer();
        // 按下即禁用原生 pan-x，长按后可直接左右拖排序
        try {
          area.style.touchAction = "none";
        } catch (_) {
          /* ignore */
        }
        area.classList.add("nav-holding");
        longPressTimer = setTimeout(() => {
          dragging = true;
          dragEl = btn;
          btn.classList.add("nav-dragging");
          area.classList.add("nav-reordering");
          createGhost(btn, lastX, lastY);
          try {
            if (btn.setPointerCapture && activePointerId != null) {
              btn.setPointerCapture(activePointerId);
            }
          } catch (_) {
            /* ignore */
          }
          try {
            if (navigator.vibrate) navigator.vibrate(12);
          } catch (_) {
            /* ignore */
          }
          tickAutoScroll();
        }, 380);
      }

      function onPointerMove(e) {
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        lastX = e.clientX;
        lastY = e.clientY;
        if (!dragging) {
          if (longPressTimer) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (dx * dx + dy * dy > 400) {
              // ~20px
              clearTimer();
              restoreAreaTouchAction();
              // 转为手动横向滚动：跟手滚动导航栏（按钮 touch-action:none 下原生横滚不可用）
              scrollPanning = true;
              area.scrollLeft -= dx;
              startX = e.clientX;
              startY = e.clientY;
              e.preventDefault();
            }
          } else if (scrollPanning) {
            area.scrollLeft -= e.clientX - startX;
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
          }
          return;
        }
        e.preventDefault();
        moveGhost(e.clientX, e.clientY);
        clearDragOver();
        const over = getBtnFromPoint(e.clientX, e.clientY);
        if (over && over !== dragEl) over.classList.add("nav-drag-over");
      }

      function onPointerUp(e) {
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        clearTimer();
        if (!dragging || !dragEl) {
          dragging = false;
          dragEl = null;
          scrollPanning = false;
          activePointerId = null;
          endDragVisual();
          restoreAreaTouchAction();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 50);

        const x = e.clientX,
          y = e.clientY;
        const over = getBtnFromPoint(x, y);
        if (over && over !== dragEl && area.contains(over)) {
          const children = [...area.children];
          const di = children.indexOf(dragEl);
          const ti = children.indexOf(over);
          if (di >= 0 && ti >= 0) {
            if (di < ti) area.insertBefore(dragEl, over.nextSibling);
            else area.insertBefore(dragEl, over);
            saveNavOrder();
          }
        }
        endDragVisual();
        dragging = false;
        dragEl = null;
        activePointerId = null;
        restoreAreaTouchAction();
      }

      function onPointerCancel(e) {
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        clearTimer();
        endDragVisual();
        dragging = false;
        dragEl = null;
        scrollPanning = false;
        activePointerId = null;
        restoreAreaTouchAction();
      }

      area.addEventListener("pointerdown", onPointerDown);
      area.addEventListener("pointermove", onPointerMove, { passive: false });
      area.addEventListener("pointerup", onPointerUp);
      area.addEventListener("pointercancel", onPointerCancel);
      // 拖拽结束后吞掉一次 click，避免误触打开功能
      area.addEventListener(
        "click",
        (e) => {
          if (suppressClick) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        },
        true,
      );

      loadNavOrder();
    }

    initNavIconReorder();

    // ===== 恢复默认排序 =====
    const resetModal = document.getElementById("resetOrderModal");
    document
      .getElementById("resetOrderBtn")
      .addEventListener("click", () => resetModal.classList.add("open"));
    document
      .getElementById("closeResetModalBtn")
      .addEventListener("click", () => resetModal.classList.remove("open"));
    document
      .getElementById("resetCancelBtn")
      .addEventListener("click", () => resetModal.classList.remove("open"));
    document
      .getElementById("resetConfirmBtn")
      .addEventListener("click", async () => {
        resetModal.classList.remove("open");
        try {
          localStorage.removeItem("lan_play_server_order");
          localStorage.removeItem(NAV_ORDER_KEY);
          resetNavOrder();
          await fetch("/api/servers/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: [], reset: true }),
          });
          await load(true, true);
          showToast("🔄 已恢复默认排序", 2000, true);
        } catch (e) {
          showToast("❌ 恢复默认排序失败：" + e.message, 2500, false);
        }
      });

    // ===== 网络检测 =====
    async function getJSON(url) {
      const r = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false)
        throw new Error(d.error || `请求失败 (${r.status})`);
      return d;
    }

    const netDot = document.getElementById("netDot");
    let netCheckTimer = null;
    let networkCheckInFlight = false;
    let lastNetState = "";
    async function checkNetwork(force) {
      if (!netDot || networkCheckInFlight) return;
      if (!navigator.onLine) {
        netDot.classList.remove("online", "offline", "checking");
        netDot.classList.add("offline");
        netDot.title = "网络已断开";
        lastNetState = "offline";
        return;
      }
      networkCheckInFlight = true;
      netDot.classList.remove("online", "offline");
      netDot.classList.add("checking");
      netDot.title = "检测网络...";
      lastNetState = "checking";
      try {
        const url =
          "/api/network-status" + (force ? "?refresh=1" : "?_=" + Date.now());
        const data = await getJSON(url);
        netDot.classList.remove("checking");
        if (data.ok && data.online) {
          netDot.classList.add("online");
          netDot.title = "网络正常";
          lastNetState = "online";
        } else {
          netDot.classList.add("offline");
          netDot.title = "无网络连接";
          lastNetState = "offline";
        }
      } catch (e) {
        netDot.classList.remove("checking");
        netDot.classList.add("offline");
        netDot.title = "网络检测失败：" + e.message;
        lastNetState = "offline";
      } finally {
        networkCheckInFlight = false;
      }
    }
    function scheduleNetworkCheck() {
      if (netCheckTimer) clearInterval(netCheckTimer);
      // 与后端 5 秒状态缓存对齐，避免 2 秒轮询反复拿同一缓存结果。
      netCheckTimer = setInterval(checkNetwork, 5000);
    }
    checkNetwork();
    scheduleNetworkCheck();

    // ===== 日志 =====
    const logModal = document.getElementById("logModal");
    const logContent = document.getElementById("logContent");
    const logAutoScrollCheckbox = document.getElementById(
      "logAutoScrollCheckbox",
    );
    let logPollToken = 0;
    let logAbortController = null;
    let logVersion = -1;
    let logPointerSelecting = false;
    let logPendingData = null;
    let logSelectionFlushTimer = null;
    const LOG_AUTOSCROLL_KEY = "lanplay_log_autoscroll";
    let logAutoScroll = localStorage.getItem(LOG_AUTOSCROLL_KEY) !== "0";

    if (logAutoScrollCheckbox) {
      logAutoScrollCheckbox.checked = logAutoScroll;
      logAutoScrollCheckbox.addEventListener("change", (e) => {
        logAutoScroll = e.target.checked;
        localStorage.setItem(LOG_AUTOSCROLL_KEY, logAutoScroll ? "1" : "0");
        if (logAutoScroll && logContent) {
          logContent.scrollTop = logContent.scrollHeight;
        }
      });
    }

    function hasActiveLogSelection() {
      if (!logContent || typeof window.getSelection !== "function") return false;
      try {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount < 1)
          return false;
        const anchorInside =
          !!selection.anchorNode && logContent.contains(selection.anchorNode);
        const focusInside =
          !!selection.focusNode && logContent.contains(selection.focusNode);
        if (anchorInside || focusInside) return true;
        // 兼容从日志区域内拖到区域外的跨节点选择。
        const range = selection.getRangeAt(0);
        return typeof range.intersectsNode === "function"
          ? range.intersectsNode(logContent)
          : false;
      } catch (_) {
        return false;
      }
    }

    function applyLogText(d) {
      if (!d || !Array.isArray(d.logs) || !logContent) return;
      const nextText = d.logs.join("\n");
      // 内容没有变化时不要重设 textContent，否则也会清除浏览器选区。
      if (logContent.textContent !== nextText) logContent.textContent = nextText;
      if (logAutoScroll) logContent.scrollTop = logContent.scrollHeight;
    }

    function flushPendingLogsWhenSafe() {
      if (
        !logPendingData ||
        logPointerSelecting ||
        hasActiveLogSelection() ||
        !logModal.classList.contains("open")
      )
        return;
      const pending = logPendingData;
      logPendingData = null;
      applyLogText(pending);
    }

    function schedulePendingLogFlush() {
      if (logSelectionFlushTimer) clearTimeout(logSelectionFlushTimer);
      logSelectionFlushTimer = setTimeout(() => {
        logSelectionFlushTimer = null;
        flushPendingLogsWhenSafe();
      }, 120);
    }

    function renderLogs(d) {
      if (!d || !Array.isArray(d.logs) || !logContent) return;
      // 即使暂缓 DOM 更新也要推进长轮询版本，避免服务端对同一版本立即重复响应。
      if (Number.isFinite(Number(d.version))) logVersion = Number(d.version);
      if (logPointerSelecting || hasActiveLogSelection()) {
        // 只保留最新快照；用户取消选区后一次性刷新，避免积压多次重绘。
        logPendingData = d;
        return;
      }
      logPendingData = null;
      applyLogText(d);
    }

    // 用户长按、拖动选择或复制日志时暂停 DOM 重绘，防止轮询清空选区。
    if (logContent) {
      logContent.addEventListener("pointerdown", () => {
        logPointerSelecting = true;
      });
      logContent.addEventListener("pointerup", () => {
        logPointerSelecting = false;
        schedulePendingLogFlush();
      });
      logContent.addEventListener("pointercancel", () => {
        logPointerSelecting = false;
        schedulePendingLogFlush();
      });
      logContent.addEventListener("touchend", schedulePendingLogFlush, {
        passive: true,
      });
      logContent.addEventListener("copy", schedulePendingLogFlush);
      document.addEventListener("selectionchange", schedulePendingLogFlush);
    }

    async function fetchLogs(waitForChange, token) {
      if (!logModal.classList.contains("open") || token !== logPollToken)
        return;
      if (logAbortController) logAbortController.abort();
      logAbortController = new AbortController();
      const params = new URLSearchParams({
        version: String(logVersion),
        wait: waitForChange ? "1" : "0",
        _: String(Date.now()),
      });
      try {
        const r = await fetch("/api/logs?" + params.toString(), {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: logAbortController.signal,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false)
          throw new Error(d.error || `请求失败 (${r.status})`);
        if (token !== logPollToken || !logModal.classList.contains("open"))
          return;
        renderLogs(d);
        // 服务端仅在日志版本发生变化后返回；随后立即进入下一次等待。
        await fetchLogs(true, token);
      } catch (e) {
        if (e && e.name === "AbortError") return;
        if (token !== logPollToken || !logModal.classList.contains("open"))
          return;
        renderLogs({
          logs: ["加载日志失败: " + e.message],
          version: logVersion,
        });
        // 网络短暂异常时低频重试，不影响正常的日志变化同步。
        setTimeout(() => fetchLogs(true, token), 1500);
      }
    }

    document.getElementById("openLogModalBtn").addEventListener("click", () => {
      logModal.classList.add("open");
      if (logAutoScrollCheckbox) logAutoScrollCheckbox.checked = logAutoScroll;
      logPollToken += 1;
      logVersion = -1;
      logPointerSelecting = false;
      logPendingData = null;
      fetchLogs(false, logPollToken);
    });
    document.getElementById("closeLogBtn").addEventListener("click", () => {
      logModal.classList.remove("open");
      logPollToken += 1;
      logPointerSelecting = false;
      logPendingData = null;
      if (logSelectionFlushTimer) {
        clearTimeout(logSelectionFlushTimer);
        logSelectionFlushTimer = null;
      }
      if (logAbortController) {
        logAbortController.abort();
        logAbortController = null;
      }
    });
    // ===== 辅助函数 =====
    const statusDot = (s) =>
      s === "online" ? "online" : s === "checking" ? "checking" : "offline";
    function latencyHTML(s) {
      if (
        s.status !== "online" ||
        s.error ||
        s.latency_ms == null ||
        s.latency_ms < 0
      )
        return '<b class="latency-badge error">-</b>';
      const lat = s.latency_ms;
      if (lat <= 300) return `<b class="latency-badge fast">${lat}ms</b>`;
      return `<b class="latency-badge slow">${lat}ms</b>`;
    }

    // ===== 时间格式化 =====
    function formatMessageTime(timestamp) {
      const date = new Date(timestamp);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, "0");
      const hour12 = hours % 12 || 12;

      let period;
      if (hours < 5) period = "凌晨";
      else if (hours < 12) period = "上午";
      else if (hours < 13) period = "中午";
      else if (hours < 18) period = "下午";
      else period = "晚上";

      if (date >= today) {
        return `${period} ${hour12}:${minutes}`;
      } else if (date >= yesterday) {
        return `昨天 ${hour12}:${minutes}`;
      } else {
        const month = (date.getMonth() + 1).toString().padStart(2, "0");
        const day = date.getDate().toString().padStart(2, "0");
        return `${month}/${day} ${hour12}:${minutes}`;
      }
    }

    // QQ 风格：两条消息间隔超过 5 分钟则插入时间分割线
    const CHAT_TIME_GAP_MS = 5 * 60 * 1000;

    function shouldShowTimeDivider(prevTs, currTs) {
      if (prevTs == null || currTs == null) return true;
      const a = Number(prevTs);
      const b = Number(currTs);
      if (!a || !b || isNaN(a) || isNaN(b)) return true;
      return Math.abs(b - a) >= CHAT_TIME_GAP_MS;
    }

    function formatChatTime(timestamp) {
      const d = new Date(Number(timestamp) || Date.now());
      const h = d.getHours();
      let period;
      if (h < 6) period = "凌晨";
      else if (h < 9) period = "早上";
      else if (h < 12) period = "上午";
      else if (h < 14) period = "中午";
      else if (h < 19) period = "下午";
      else period = "晚上";
      const hour12 = h % 12 || 12;
      return (
        period + " " + hour12 + ":" + String(d.getMinutes()).padStart(2, "0")
      );
    }

    function resolveMsgAvatar(msg) {
      if (!msg) return "";
      const sid = String(msg.senderId || msg.sender || "");
      const myId = String(state.userId || getStoredUserId() || "");
      const isMine = !!(msg.isMine || (sid && myId && sid === myId));
      if (isMine)
        return state.avatar || getStoredAvatar() || msg.senderAvatar || "";
      // 1) 资料缓存 2) 在线列表 3) 消息内嵌
      const cached = sid && state.memberProfiles && state.memberProfiles[sid];
      if (cached && cached.avatar) return cached.avatar;
      if (sid && Array.isArray(state.onlineMembers)) {
        const m = state.onlineMembers.find((x) => x && String(x.id) === sid);
        if (m && m.avatar) return m.avatar;
      }
      return msg.senderAvatar || "";
    }

    function resolveMsgSenderName(msg) {
      if (!msg) return "匿名用户";
      const sid = String(msg.senderId || msg.sender || "");
      const myId = String(state.userId || getStoredUserId() || "");
      if (msg.isMine || (sid && myId && sid === myId))
        return state.username || msg.senderName || "我";
      const cached = sid && state.memberProfiles && state.memberProfiles[sid];
      if (cached && cached.nickname) return cached.nickname;
      if (sid && Array.isArray(state.onlineMembers)) {
        const m = state.onlineMembers.find((x) => x && String(x.id) === sid);
        if (m && m.nickname) return m.nickname;
      }
      return (msg.senderName || msg.sender || "匿名用户").trim() || "匿名用户";
    }

    function patchOwnMessagesProfile() {
      const myId = String(state.userId || getStoredUserId() || "");
      const nick = state.username || "";
      const av = state.avatar || "";
      Object.keys(state.chatMessages || {}).forEach(function (sid) {
        (state.chatMessages[sid] || []).forEach(function (m) {
          if (!m) return;
          if (m.isMine || String(m.senderId || m.sender || "") === myId) {
            m.senderName = nick || m.senderName;
            m.senderAvatar =
              av && String(av).indexOf("data:") === 0
                ? undefined
                : av || undefined;
            m.isMine = true;
          }
        });
      });
      (state.publicMessages || []).forEach(function (m) {
        if (!m) return;
        if (m.isMine || String(m.senderId || m.sender || "") === myId) {
          m.senderName = nick || m.senderName;
          m.senderAvatar =
            av && String(av).indexOf("data:") === 0
              ? undefined
              : av || undefined;
          m.isMine = true;
        }
      });
      try {
        saveChatMessages();
        savePublicMessages();
      } catch (e) {}
    }

    function refreshAllChatUI() {
      state.servers.forEach(function (s) {
        renderChatMessages(s.id, false);
      });
      renderPublicChat(false);
      updateOnlineMembersUI();
      updateChatUI();
    }

    function buildChatMessagesHtml(messages) {
      if (!messages || !messages.length) return "";
      let html = "";
      let prevTime = null;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const t = msg.time || 0;
        if (shouldShowTimeDivider(prevTime, t)) {
          html += `<div class="chat-time-divider"><span>${esc(formatMessageTime(t))}</span></div>`;
        }
        prevTime = t;
        // 渲染时按当前 userId 实时判断左右，换 ID 后立即生效
        const isMineNow = isMessageMine(msg);
        msg.isMine = isMineNow;
        const cls = isMineNow ? "chat-msg-mine" : "chat-msg-other";
        const sender = resolveMsgSenderName(msg);
        const contentHtml = renderMessageContent(msg);
        const mediaType = msg.mediaType || "";
        const url = msg.url || "";
        let downloadHtml = "";
        // 图片/视频直接走 R2 CDN；文件/语音走后端代理绕过 R2 下载限制
        if (url && mediaType === "image") {
          downloadHtml = `<a class="chat-media-download" href="${esc(url)}" download="${esc(msg.fileName || "image")}" target="_blank" rel="noopener noreferrer">下载图片</a>`;
        } else if (url && mediaType === "video") {
          downloadHtml = `<a class="chat-media-download" href="${esc(url)}" download="${esc(msg.fileName || "video")}" target="_blank" rel="noopener noreferrer">下载视频</a>`;
        } else if (url && mediaType === "file") {
          if (_isXorMsg(msg)) {
            downloadHtml = `<a class="chat-media-download" data-xor-url="${esc(url)}" data-xor-name="${esc(msg.fileName || "文件")}" data-xor-mime="${esc(msg.mimeType || "")}">下载文件</a>`;
          } else {
            downloadHtml = `<a class="chat-media-download" href="${esc(url)}" download="${esc(msg.fileName || "文件")}" target="_blank" rel="noopener noreferrer">下载文件</a>`;
          }
        } else if (url && mediaType === "audio") {
          if (_isXorMsg(msg)) {
            downloadHtml = `<a class="chat-media-download" data-xor-url="${esc(url)}" data-xor-name="${esc(msg.fileName || "语音")}" data-xor-mime="${esc(msg.mimeType || "audio/mpeg")}">下载语音</a>`;
          } else {
            downloadHtml = `<a class="chat-media-download" href="${esc(url)}" download="${esc(msg.fileName || "语音")}" target="_blank" rel="noopener noreferrer">下载语音</a>`;
          }
        }

        // Telegram 风格：对方头像在左，自己消息右对齐且不显示头像
        const avatarUrl = resolveMsgAvatar(msg);
        const initial = String(sender || "?")
          .charAt(0)
          .toUpperCase();
        const avatarHtml = msg.isMine
          ? ""
          : avatarUrl
            ? `<img class="chat-msg-avatar" src="${esc(avatarUrl)}" alt="" data-full="${esc(avatarUrl)}" loading="lazy" draggable="false" title="点击查看头像">`
            : `<div class="chat-msg-avatar chat-msg-avatar-fallback" title="${esc(sender)}">${esc(initial)}</div>`;
        const senderHtml = msg.isMine
          ? ""
          : `<strong class="msg-sender">${esc(sender)}</strong>`;
        const rowCls = msg.isMine
          ? "chat-msg-row chat-msg-row-mine"
          : "chat-msg-row chat-msg-row-other";
        html += `<div class="${rowCls}" data-msg-id="${esc(msg.id || "")}">
        ${avatarHtml}
        <div class="chat-msg ${cls}" data-msg-id="${esc(msg.id || "")}">
          <div class="msg-content">
            ${senderHtml}
            <div class="msg-body">${contentHtml}</div>
            <div class="msg-footer"><span class="msg-time">${esc(formatChatTime(t))}</span>${downloadHtml}</div>
          </div>
        </div>
      </div>`;
      }
      return html;
    }

    // ===== 双副本 HTML（改为省略号） =====
    function makeServerNameHtml(name, copyText) {
      const escaped = esc(name);
      return `<span class="server-name ellipsis" data-copytext="${esc(copyText)}" title="点击复制服务器名称">${escaped}</span>`;
    }

    function makeServerAddressHtml(address, copyText) {
      const escaped = esc(address);
      return `<span class="server-address ellipsis" data-copytext="${esc(copyText)}" title="点击复制服务器地址: ${esc(copyText)}">${escaped}</span>`;
    }

    /**
     * 生成单个房间卡片的 HTML
     * @param {Object} room - 房间数据
     * @param {string} display - 初始显示状态 ('none' 或 ''，默认为 '' 显示)
     * @returns {string} HTML 字符串
     */
    function roomCard(room, display) {
      const players = Array.isArray(room.players) ? room.players : [];
      const count = `${room.node_count || players.length}${room.node_count_max ? " / " + room.node_count_max : ""} 人`;
      const contentId = String(room.content_id || "").toUpperCase();
      // 无标题 ID / FFFF 哨兵值 → 真·未知游戏；其余一律有 ID 可显示
      const isPlaceholder = !contentId || contentId === UNKNOWN_ID;
      // 未映射：后端标记，或名字本身就等于标题 ID（兼容旧后端）
      const gameVal = resolveRoomGameLabel(room);
      const isUnmapped =
        !isPlaceholder &&
        (room.game_unmapped === true || gameVal === contentId);

      const iconUrl = room.game_icon || "";
      const finalIcon =
        isPlaceholder || !iconUrl ? QUESTION_ICON_DATA : iconUrl;

      let iconHtml;
      if (isPlaceholder) {
        iconHtml = `<span class="room-icon" style="display:inline-block;width:22px;height:22px;border-radius:4px;background:#34495e;color:white;text-align:center;line-height:22px;font-weight:bold;font-size:14px;cursor:default;" title="${esc(gameVal)}">?</span>`;
      } else {
        // 未映射的 ID 也先尝试拉真实图标，失败再回退问号
        iconHtml = `<img src="${finalIcon}" alt="${esc(gameVal)}" title="点击放大查看 - ${esc(gameVal)}" class="room-icon" loading="lazy" data-full="${esc(finalIcon)}" draggable="false" style="cursor:zoom-in;" onerror="this.onerror=null;this.src='${QUESTION_ICON_DATA}'">`;
      }

      const gameDisplay = gameVal;
      const canCopy = isUnmapped;
      const copyClass = canCopy ? "copy-game-id" : "no-copy";
      const gameTitle = canCopy ? `点击复制游戏 ID: ${contentId}` : gameVal;

      let gameNameHtml = `<span class="game-name ${copyClass} ellipsis" data-contentid="${esc(contentId)}" data-isunknown="${canCopy ? "true" : "false"}" title="${esc(gameTitle)}">${esc(gameDisplay)}</span>`;

      const hostName = room.host || "未知房间";
      let hostHtml = `<span class="room-host-meta"><span class="host-icon-fixed">🏠</span><span class="host-name ellipsis">${esc(hostName)}</span></span>`;

      const roomId = esc(room.id || "");
      const gameKey = gameVal; // 已是最终标签（游戏名 / 标题 ID / 未知游戏）
      // ★★★ 修复：通过 display 参数控制初始显示状态，避免闪现 ★★★
      const displayStyle = display === "none" ? "display:none;" : "";
      return `<div class="room-item" data-game="${esc(gameVal)}" data-game-key="${esc(gameKey)}" data-room-id="${roomId}" style="${displayStyle}">
    <div class="room-top">
      <div class="room-game-left">
        ${iconHtml}
        ${gameNameHtml}
      </div>
    </div>
    <div class="room-meta">
      <span class="green">● 正在联机</span>
      <span>|</span>
      <span>${esc(count)}</span>
      <span>|</span>
      ${hostHtml}
    </div>
    <div class="room-players">${players.map((p) => `<span class="player">${esc(p)}</span>`).join("")}</div>
  </div>`;
    }

    // ===== 新消息数字角标相关函数 =====
    function normalizeUnreadCount(v) {
      if (v === true) return 1; // 兼容旧布尔值
      const n = parseInt(v, 10);
      return isNaN(n) || n < 0 ? 0 : n;
    }

    function getUnreadCount(serverId) {
      return normalizeUnreadCount(state.unreadStatus[serverId]);
    }

    function loadUnreadStatus() {
      try {
        const data = localStorage.getItem(UNREAD_STORAGE_KEY);
        if (data) {
          const parsed = JSON.parse(data);
          if (typeof parsed === "object" && parsed !== null) {
            const normalized = {};
            Object.keys(parsed).forEach((k) => {
              const n = normalizeUnreadCount(parsed[k]);
              if (n > 0) normalized[k] = n;
            });
            state.unreadStatus = normalized;
            return;
          }
        }
      } catch (e) {
        /* ignore */
      }
      state.unreadStatus = {};
    }

    function saveUnreadStatus() {
      try {
        localStorage.setItem(
          UNREAD_STORAGE_KEY,
          JSON.stringify(state.unreadStatus),
        );
      } catch (e) {
        /* ignore */
      }
    }

    function applyUnreadToElement(el, count) {
      if (!el) return;
      if (count > 0) {
        el.textContent = count > 99 ? "99+" : String(count);
        el.style.display = "inline-block";
      } else {
        el.textContent = "";
        el.style.display = "none";
      }
    }

    function updateUnreadIndicators() {
      document.querySelectorAll(".unread-indicator").forEach((el) => {
        const sid = el.dataset.serverId;
        applyUnreadToElement(el, getUnreadCount(sid));
      });
    }

    function syncUnreadWithExpanded() {
      let changed = false;
      state.expanded.forEach((id) => {
        if (getUnreadCount(id) > 0) {
          delete state.unreadStatus[id];
          changed = true;
        }
      });
      if (changed) {
        saveUnreadStatus();
        updateUnreadIndicators();
      }
    }

    function ensureUnreadIndicator(card, serverId) {
      let indicator = card.querySelector(".unread-indicator");
      if (!indicator) {
        const stats = card.querySelector(".server-stats");
        if (stats) {
          indicator = document.createElement("span");
          indicator.className = "unread-indicator";
          indicator.dataset.serverId = serverId;
          stats.parentNode.insertBefore(indicator, stats);
        }
      }
      applyUnreadToElement(indicator, getUnreadCount(serverId));
    }

    // 服务器错误角标（卡片顶部居中，文案随错误变化）
    function ensureErrorBadge(card, errorText) {
      if (!card) return;
      const host = card.querySelector(".server-card-inner") || card;
      card.querySelectorAll(".server-error").forEach((el) => el.remove());
      let badge = host.querySelector(".server-error-badge");
      if (!badge) badge = card.querySelector(".server-error-badge");
      const text = (errorText || "").trim();
      if (!text) {
        if (badge) {
          badge.classList.remove("show");
          badge.textContent = "";
          badge.removeAttribute("title");
        }
        return;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "server-error-badge";
        host.appendChild(badge);
      } else if (badge.parentElement !== host) {
        host.appendChild(badge);
      }
      const label = text.length > 28 ? text.slice(0, 28) + "…" : text;
      if (badge.textContent !== label) badge.textContent = label;
      badge.title = text;
      badge.classList.add("show");
    }

    // ===== 滑动交互（仅对自定义服务器启用） =====
    const SWIPE_THRESHOLD = 40;
    const ACTION_WIDTH_FALLBACK = 160;

    function initSwipe(card) {
      const serverId = card.dataset.id;
      const server = state.servers.find((s) => s.id === serverId);
      const actions = card.querySelector(".server-actions");
      if (!server || !server.is_manual) {
        if (actions) actions.style.display = "none";
        return;
      }
      if (card.dataset.swipeBound === "true") return;
      card.dataset.swipeBound = "true";

      let startX = 0;
      let currentX = 0;
      let isDragging = false;
      let isSwiping = false;
      let startTime = 0;
      let offset = 0;

      const inner = card.querySelector(".server-card-inner");
      if (!inner || !actions) return;

      // 不能再把滑动距离写死为 160px：操作层会随 DPI 缩放。
      // 每次开始滑动时读取按钮层的真实 CSS 宽度，确保内容层右缘与蓝色按钮左缘完全重合。
      let actionWidth = ACTION_WIDTH_FALLBACK;
      function readActionWidth() {
        const measured = actions.getBoundingClientRect().width;
        if (Number.isFinite(measured) && measured > 0) {
          actionWidth = measured;
        } else {
          const cssValue = parseFloat(
            getComputedStyle(card).getPropertyValue("--server-action-width"),
          );
          actionWidth =
            Number.isFinite(cssValue) && cssValue > 0
              ? cssValue
              : ACTION_WIDTH_FALLBACK;
        }
        return actionWidth;
      }
      readActionWidth();

      function updateTransform(x) {
        const width = actionWidth || readActionWidth();
        const clamped = Math.min(0, Math.max(-width, x));
        offset = Math.abs(clamped);
        inner.style.transform = `translate3d(${clamped}px, 0, 0)`;
        if (offset >= width - 1) {
          card.classList.add("swipe-open");
        } else {
          card.classList.remove("swipe-open");
        }
      }

      function onStart(e) {
        const touch = e.touches ? e.touches[0] : e;
        readActionWidth();
        startX = touch.clientX;
        currentX = startX;
        startTime = Date.now();
        isDragging = true;
        isSwiping = false;
        if (card.classList.contains("swipe-open")) {
          offset = actionWidth;
          inner.style.transform = `translate3d(${-actionWidth}px, 0, 0)`;
        } else {
          offset = 0;
          inner.style.transform = `translateX(0px)`;
        }
      }

      function onMove(e) {
        if (!isDragging) return;
        const touch = e.touches ? e.touches[0] : e;
        const deltaX = touch.clientX - startX;
        const deltaY =
          touch.clientY - (e.changedTouches ? e.changedTouches[0].clientY : 0);
        if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
          isSwiping = true;
          e.preventDefault();
        }
        if (!isSwiping) return;
        const newOffset = offset - deltaX;
        updateTransform(-newOffset);
        currentX = touch.clientX;
      }

      function onEnd(e) {
        if (!isDragging) return;
        isDragging = false;
        const dt = Date.now() - startTime;
        const dx = Math.abs(currentX - startX);
        if (dx < 10 && dt < 300) {
          isSwiping = false;
          if (card.classList.contains("swipe-open")) {
            updateTransform(-actionWidth);
          } else {
            updateTransform(0);
          }
          return;
        }
        if (isSwiping) {
          if (offset > SWIPE_THRESHOLD) {
            updateTransform(-actionWidth);
            card.classList.add("swipe-open");
          } else {
            updateTransform(0);
            card.classList.remove("swipe-open");
          }
        }
        isSwiping = false;
      }

      card.addEventListener("touchstart", onStart, { passive: true });
      card.addEventListener("touchmove", onMove, { passive: false });
      card.addEventListener("touchend", onEnd, { passive: true });

      let mouseDown = false;
      card.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        mouseDown = true;
        onStart(e);
      });
      document.addEventListener("mousemove", (e) => {
        if (!mouseDown) return;
        onMove(e);
      });
      document.addEventListener("mouseup", (e) => {
        if (!mouseDown) return;
        mouseDown = false;
        onEnd(e);
      });

      const head = card.querySelector(".server-head");
      if (head) {
        head.addEventListener("click", (e) => {
          if (card.classList.contains("swipe-open")) {
            e.stopPropagation();
            card.classList.remove("swipe-open");
            updateTransform(0);
            return;
          }
          if (isSwiping) {
            e.stopPropagation();
            isSwiping = false;
            return;
          }
        });
      }

      const editBtn = card.querySelector(".action-edit");
      const deleteBtn = card.querySelector(".action-delete");
      if (editBtn) {
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const sid = card.dataset.id;
          const server = state.servers.find((s) => s.id === sid);
          if (server) {
            openEditModal(sid, server.name, card);
          }
          card.classList.remove("swipe-open");
          updateTransform(0);
        });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const sid = card.dataset.id;
          const server = state.servers.find((s) => s.id === sid);
          if (server) {
            openDeleteConfirm(sid, server.name, card);
          }
          card.classList.remove("swipe-open");
          updateTransform(0);
        });
      }

      card._resetSwipe = function () {
        card.classList.remove("swipe-open");
        updateTransform(0);
      };
      card._syncSwipe = function () {
        readActionWidth();
        updateTransform(card.classList.contains("swipe-open") ? -actionWidth : 0);
      };
    }

    // ===== 获取类型标签 HTML =====
    function getTypeBadge(server) {
      let type = "";
      let cls = "";
      if (server.is_builtin) {
        type = "内置";
        cls = "builtin";
      } else if (server.is_remote) {
        type = "远程";
        cls = "remote";
      } else if (server.is_manual) {
        type = "自定义";
        cls = "manual";
      } else {
        return "";
      }
      return `<span class="server-type-badge ${cls}">${type}</span>`;
    }

    // 地区 + 内置/远程/自定义 放进同一列容器，保证左缘对齐
    function buildServerTagsHtml(regionHtml, typeBadgeHtml) {
      if (!regionHtml && !typeBadgeHtml) return "";
      return `<div class="server-tags">${regionHtml || ""}${typeBadgeHtml || ""}</div>`;
    }

    // ===== 筛选应用 =====
    function applyFilter(autoExpand) {
      if (autoExpand === undefined) autoExpand = false;
      // 正在卡片内聊天时，不允许筛选逻辑把其它卡片自动展开
      let chattingNow = false;
      if (state.autoExpand) {
        for (let i = 0; i < state.servers.length; i++) {
          if (isServerChatActive(state.servers[i].id)) {
            chattingNow = true;
            break;
          }
        }
      }
      const effectiveAutoExpand =
        autoExpand && state.autoExpand && !chattingNow;

      const g = state.game;
      const isAll = g === "all";
      const isAllServers = g === "all_servers";
      const filteredRooms =
        isAllServers || isAll
          ? state.rooms
          : state.rooms.filter((r) => roomMatchesFilterGame(r, g));
      const onlineCount = state.servers.filter(
        (s) => s.status === "online",
      ).length;
      document.getElementById("ovServers").textContent =
        `${onlineCount}/${state.servers.length}`;
      document.getElementById("ovOnline").textContent = state.servers
        .filter((s) => s.status === "online")
        .reduce((a, s) => a + (s.online || 0), 0);
      document.getElementById("ovIdle").textContent = state.servers
        .filter((s) => s.status === "online")
        .reduce((a, s) => a + (s.idle || 0), 0);
      document.getElementById("ovRooms").textContent = filteredRooms.length;
      document.querySelectorAll(".room-item").forEach((el) => {
        const roomGame = el.dataset.gameKey || el.dataset.game || "";
        el.style.display =
          isAll || isAllServers || roomGame === g ? "" : "none";
      });
      state.servers.forEach((s) => {
        const group = document.querySelector(
          `.server-group[data-id="${s.id}"]`,
        );
        if (!group) return;
        const items = group.querySelectorAll(".room-item");
        let visible = 0;
        items.forEach((el) => {
          if (el.style.display !== "none") visible++;
        });
        const isOnline = s.status === "online" && !s.error;
        if (isAllServers) {
          group.style.display = "";
          // ★★★ 修改点：只有该服务器实际有房间时才自动展开 ★★★
          const hasRooms = state.rooms.some((r) => r.server_id === s.id);
          if (
            effectiveAutoExpand &&
            !group.classList.contains("open") &&
            hasRooms
          ) {
            group.classList.add("open");
            state.expanded.add(s.id);
          }
          group
            .querySelectorAll(".no-rooms,.no-rooms-empty,.no-rooms-match")
            .forEach((el) => el.remove());
          // 以数据源判断是否有房间，避免 DOM 尚未刷出房间列表时误显示“暂无公开房间”
          const serverRoomCount = state.rooms.filter(
            (r) => r.server_id === s.id,
          ).length;
          if (serverRoomCount === 0 && items.length === 0 && isOnline) {
            let m = group.querySelector(".no-rooms-empty");
            if (!m) {
              m = document.createElement("div");
              m.className = "no-rooms-empty no-rooms";
              m.textContent = "📭 该服务器暂无公开房间";
              const body = group.querySelector(".server-body > .body-inner");
              if (body) {
                const chat = body.querySelector(".chat-wrapper");
                if (chat) {
                  if (chat.nextSibling) body.insertBefore(m, chat.nextSibling);
                  else body.appendChild(m);
                } else {
                  body.appendChild(m);
                }
              }
            }
            m.style.display = "";
          }
        } else if (isAll) {
          // 总房间：有保活房间就显示（不因短暂离线/超时隐藏）
          const hasKept = state.rooms.some((r) => r.server_id === s.id);
          const hasAny = items.length > 0 || hasKept;
          group.style.display = hasAny ? "" : "none";
          if (
            effectiveAutoExpand &&
            hasAny &&
            !group.classList.contains("open")
          ) {
            group.classList.add("open");
            state.expanded.add(s.id);
          }
          group
            .querySelectorAll(".no-rooms,.no-rooms-empty,.no-rooms-match")
            .forEach((el) => el.remove());
        } else {
          // 游戏筛选（含未知游戏）：有匹配保活房间就显示，不要求服务器当前在线
          const hasKeptMatch = state.rooms.some(
            (r) => r.server_id === s.id && roomMatchesFilterGame(r, g),
          );
          if (visible > 0 || hasKeptMatch) {
            group.style.display = "";
            if (effectiveAutoExpand && !group.classList.contains("open")) {
              group.classList.add("open");
              state.expanded.add(s.id);
            }
            group
              .querySelectorAll(".no-rooms,.no-rooms-empty")
              .forEach((el) => (el.style.display = "none"));
          } else {
            group.style.display = "none";
            group
              .querySelectorAll(".no-rooms,.no-rooms-empty")
              .forEach((el) => (el.style.display = "none"));
          }
        }
      });
      let gm = document.getElementById("no-server-match");
      if (
        !isAll &&
        !isAllServers &&
        document.querySelectorAll('.server-group:not([style*="display: none"])')
          .length === 0
      ) {
        if (!gm) {
          gm = document.createElement("div");
          gm.id = "no-server-match";
          gm.className = "no-rooms";
          gm.style.cssText = "text-align:center;padding:24px;font-size:14px;";
          document.getElementById("serverList").appendChild(gm);
        }
        gm.textContent = `🔍 没有服务器有游戏「${g}」的房间`;
        gm.style.display = "";
      } else if (gm) gm.style.display = "none";
    }

    // ===== 拖拽排序 =====
    let draggedEl = null;

    // ---- 服务器卡片拖拽：靠近视口上下边缘时自动翻滚页面 ----
    // 说明：HTML5 原生拖拽期间部分 WebView 会暂停 requestAnimationFrame，
    // 因此用 setInterval 驱动。要「快且丝滑」的关键是：
    //   1) interval 保持很小的固定值（16ms），高频率、小步长滚动，而不是大步长跳跃；
    //   2) 用亚像素累积 + 速度平滑，消除起步/停止时的顿挫；
    //   3) 在边缘停留越久越快（dwell 加速），长列表可快速翻到目标位置。
    // 调速只改 CARD_MAX_SPEED（基础速度）与 CARD_ACCEL（停留加速强度）即可。
    let _cardDragLastY = 0;
    let _cardDragAutoScrollTimer = null;
    let _cardDragSpeed = 0; // 当前滚动速度（px/tick，带平滑）
    let _cardDragAccum = 0; // 亚像素累积，保证低速时也能连续滚动
    let _cardDragEdgeSince = 0; // 进入边缘区的时间戳（用于 dwell 加速）
    const CARD_AUTO_SCROLL_INTERVAL = 16; // ms（固定小值，保证丝滑）
    const CARD_EDGE = 160; // 触发区高度（px）
    const CARD_MAX_SPEED = 300; // 每 tick 基础最大滚动像素（越贴近边缘越快）
    const CARD_ACCEL = 0.0016; // dwell 加速：每秒速度按此指数放大
    const CARD_SMOOTH = 0.85; // 速度平滑系数（0~1，越大响应越快）

    function _stopCardDragAutoScroll() {
      if (_cardDragAutoScrollTimer) {
        clearInterval(_cardDragAutoScrollTimer);
        _cardDragAutoScrollTimer = null;
      }
      _cardDragSpeed = 0;
      _cardDragAccum = 0;
      _cardDragEdgeSince = 0;
    }

    function _cardDragScrollStep() {
      if (!draggedEl) {
        _stopCardDragAutoScroll();
        return;
      }
      const vh =
        window.innerHeight || document.documentElement.clientHeight || 0;
      // 目标速度：越贴近边缘越快，方向取决于在上缘还是下缘
      let proximity = 0; // 0~1，越贴近边缘越接近 1
      let dir = 0;
      if (_cardDragLastY < CARD_EDGE) {
        dir = -1;
        proximity = (CARD_EDGE - _cardDragLastY) / CARD_EDGE;
      } else if (_cardDragLastY > vh - CARD_EDGE) {
        dir = 1;
        proximity = (_cardDragLastY - (vh - CARD_EDGE)) / CARD_EDGE;
      }
      let target = 0;
      if (dir !== 0) {
        if (!_cardDragEdgeSince) _cardDragEdgeSince = Date.now();
        const dwell = Date.now() - _cardDragEdgeSince;
        const accel = Math.pow(2, dwell * CARD_ACCEL); // 每约 0.6s 翻倍
        target = dir * proximity * CARD_MAX_SPEED * accel;
      } else {
        _cardDragEdgeSince = 0;
      }
      // 平滑逼近目标速度，避免速度突变造成顿挫
      _cardDragSpeed += (target - _cardDragSpeed) * CARD_SMOOTH;
      // 亚像素累积：小数部分暂存，凑满 1px 再滚动，保证连续顺滑
      _cardDragAccum += _cardDragSpeed;
      const step = Math.trunc(_cardDragAccum);
      _cardDragAccum -= step;
      if (step !== 0) window.scrollBy(0, step);
    }

    document.addEventListener("dragover", function (e) {
      if (!draggedEl) return;
      _cardDragLastY = e.clientY;
      if (!_cardDragAutoScrollTimer) {
        _cardDragAutoScrollTimer = setInterval(
          _cardDragScrollStep,
          CARD_AUTO_SCROLL_INTERVAL,
        );
      }
    });

    function initDragAndDrop(div, s) {
      div.setAttribute("draggable", "true");
      // 记录按下位置，供 dragstart 计算拖影相对卡片的偏移，使拖影与卡片对齐
      div.addEventListener(
        "pointerdown",
        (e) => {
          if (e.button != null && e.button !== 0) return;
          const rect = div.getBoundingClientRect();
          div._dragOffsetX = e.clientX - rect.left;
          div._dragOffsetY = e.clientY - rect.top;
        },
        { passive: true },
      );
      div.addEventListener("dragstart", (e) => {
        // 聊天消息内（尤其是图片）长按不能启动服务器卡片拖拽，否则卡片会停留在 opacity:.4 的灰色状态。
        const target = e.target;
        if (target && target.closest && target.closest(".chat-msg")) {
          e.preventDefault();
          e.stopPropagation();
          div.classList.remove("dragging");
          draggedEl = null;
          return;
        }
        draggedEl = div;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          try {
            const ox = Number.isFinite(div._dragOffsetX)
              ? div._dragOffsetX
              : div.offsetWidth / 2;
            const oy = Number.isFinite(div._dragOffsetY)
              ? div._dragOffsetY
              : 24;
            e.dataTransfer.setDragImage(div, ox, oy);
          } catch (_) {
            /* 旧 WebView 可能不支持 setDragImage */
          }
        }
        requestAnimationFrame(() => {
          if (draggedEl === div) div.classList.add("dragging");
        });
      });
      div.addEventListener("dragend", () => {
        div.classList.remove("dragging");
        draggedEl = null;
        _stopCardDragAutoScroll();
        document
          .querySelectorAll(".server-group")
          .forEach((el) => el.classList.remove("drag-over"));
      });
      div.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (div !== draggedEl) div.classList.add("drag-over");
      });
      div.addEventListener("dragleave", () =>
        div.classList.remove("drag-over"),
      );
      div.addEventListener("drop", (e) => {
        e.preventDefault();
        div.classList.remove("drag-over");
        if (draggedEl && draggedEl !== div) {
          const list = document.getElementById("serverList");
          const all = [...list.querySelectorAll(".server-group")];
          const di = all.indexOf(draggedEl);
          const ti = all.indexOf(div);
          if (di < ti) div.parentNode.insertBefore(draggedEl, div.nextSibling);
          else div.parentNode.insertBefore(draggedEl, div);

          const newServers = [];
          document.querySelectorAll(".server-group").forEach((el) => {
            const id = el.dataset.id;
            const server = state.servers.find((s) => s.id === id);
            if (server) newServers.push(server);
          });
          state.servers = newServers;
          state._defaultOrder = state.servers.map((s) => ({ id: s.id }));
          saveCurrentOrder();
        }
      });
    }

    function saveCurrentOrder() {
      const ids = state.servers.map((s) => s.id);
      try {
        localStorage.setItem("lan_play_server_order", JSON.stringify(ids));
      } catch (e) {}
      fetch("/api/servers/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ids }),
      }).catch(() => {});
    }

    function loadSavedOrder() {
      try {
        const cached = localStorage.getItem("lan_play_server_order");
        if (!cached) return false;
        const arr = JSON.parse(cached);
        if (!Array.isArray(arr) || !arr.length) return false;
        const map = {};
        state.servers.forEach((s) => {
          map[s.id] = s;
        });
        const ordered = arr.map((id) => map[id]).filter(Boolean);
        state.servers.forEach((s) => {
          if (!arr.includes(s.id)) ordered.push(s);
        });
        if (ordered.length) {
          state.servers = ordered;
          state._defaultOrder = state.servers.map((s) => ({ id: s.id }));
          return true;
        }
      } catch (e) {
        /* ignore */
      }
      return false;
    }

    // ===== 编辑模态框（含 ID 修改） =====
    let editModalInstance = null;

    function openEditModal(serverId, serverName, cardEl) {
      if (editModalInstance) {
        editModalInstance.remove();
        editModalInstance = null;
      }

      const server = state.servers.find((s) => s.id === serverId);
      if (!server) {
        showToast("❌ 未找到服务器数据", 1500, false);
        return;
      }

      const modal = document.createElement("div");
      modal.className = "custom-modal open";
      modal.style.display = "flex";
      modal.innerHTML = `
      <div class="custom-modal-box" style="width:min(450px,calc(100% - 32px));">
        <div class="custom-modal-header">
          <span>✏️ 编辑服务器</span>
          <button class="custom-modal-close edit-modal-close">✕</button>
        </div>
        <div class="custom-modal-body">
          <form id="editServerForm" class="form-grid">
            <div class="form-row">
              <input type="text" id="editId" placeholder="服务器ID (可选)" value="${esc(server.id)}" pattern="[A-Za-z0-9_ -]{1,64}" title="仅允许字母、数字、下划线、空格和连字符，长度1-64">
            </div>
            <div class="form-row">
              <input type="text" id="editName" placeholder="服务器名称 (必填)" value="${esc(server.name)}" required>
            </div>
            <div class="form-row">
              <input type="text" id="editHost" placeholder="主机地址" value="${esc(server.host)}" required>
            </div>
            <div class="form-row-group">
              <input type="number" id="editPort" value="${server.port || 11451}" placeholder="端口" required>
              <select id="editType">
                <option value="graphql" ${server.type === "graphql" ? "selected" : ""}>GraphQL</option>
                <option value="rest" ${server.type === "rest" ? "selected" : ""}>REST</option>
              </select>
            </div>
            <div class="form-row">
              <input type="text" id="editRegion" placeholder="地区标签" value="${esc(server.region || "")}">
            </div>
            <button type="submit" class="submit-btn" id="editSubmitBtn">
              <span class="spinner"></span>
              <span class="btn-text">保存修改</span>
            </button>
          </form>
        </div>
      </div>
    `;
      document.body.appendChild(modal);
      editModalInstance = modal;

      const editHost = document.getElementById("editHost");
      const editPort = document.getElementById("editPort");
      setupHostPortAutoFill(editHost, editPort);

      const closeBtn = modal.querySelector(".edit-modal-close");
      closeBtn.addEventListener("click", () => {
        modal.remove();
        editModalInstance = null;
      });
      const form = modal.querySelector("#editServerForm");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById("editSubmitBtn");
        if (submitBtn.classList.contains("loading")) return;

        const newId = document.getElementById("editId").value.trim();
        const name = document.getElementById("editName").value.trim();
        const host = document.getElementById("editHost").value.trim();
        const port =
          parseInt(document.getElementById("editPort").value) || 11451;
        const type = document.getElementById("editType").value;
        const region = document.getElementById("editRegion").value.trim();

        if (newId && !/^[A-Za-z0-9_ -]{1,64}$/.test(newId)) {
          showToast(
            "❌ 新 ID 格式无效，仅允许字母、数字、下划线、空格和连字符，长度1-64",
            2500,
            false,
          );
          document.getElementById("editId").focus();
          return;
        }
        if (!name) {
          showToast("❌ 请输入服务器名称", 2500, false);
          document.getElementById("editName").focus();
          return;
        }
        if (!isValidHost(host)) {
          showToast("❌ 请输入有效的主机地址（域名或IP）", 2500, false);
          document.getElementById("editHost").focus();
          return;
        }

        submitBtn.classList.add("loading");
        submitBtn.disabled = true;
        const btnTextEl = submitBtn.querySelector(".btn-text");
        const originalText = btnTextEl.textContent;
        btnTextEl.textContent = "提交中...";

        try {
          const res = await fetch("/api/servers/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: serverId,
              new_id: newId || serverId,
              name,
              host,
              port,
              type,
              region,
            }),
          });
          const d = await res.json().catch(() => ({}));
          if (!res.ok || !d.ok) throw new Error(d.error || "编辑失败");
          modal.remove();
          editModalInstance = null;
          await load(true);
          showToast("✅ 服务器「" + name + "」已更新", 2000, true);
        } catch (err) {
          showToast("❌ 编辑失败：" + err.message, 2500, false);
        } finally {
          submitBtn.classList.remove("loading");
          submitBtn.disabled = false;
          btnTextEl.textContent = originalText;
        }
      });
    }

    // ============================================================
    // ========== GoEasy 聊天模块 ==========
    // ============================================================
    let goEasy = null;
    const CHAT_PREFIX = "lanplay_chat_";
    const PUBLIC_CHANNEL = "public_chat";
    // 使用公共聊天频道做在线状态，所有已连上聊天的用户都会出现在列表中
    const PRESENCE_CHANNEL = "public_chat";
    let goEasyInitTimer = null;
    let presenceRefreshTimer = null;

    let usernameModalInstance = null;

    function getStoredUsername() {
      return localStorage.getItem(USERNAME_KEY) || "";
    }
    function getStoredAvatar() {
      try {
        return localStorage.getItem(AVATAR_KEY) || "";
      } catch (e) {
        return "";
      }
    }
    function getStoredUserId() {
      let id = localStorage.getItem(USER_ID_KEY);
      if (!id) {
        id = "u_" + generateMsgId();
        localStorage.setItem(USER_ID_KEY, id);
      }
      return id;
    }

    function isValidUserId(id) {
      const s = String(id || "").trim();
      // 字母数字下划线短横，长度 2-64，禁止纯空白
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(s)) return false;
      return true;
    }

    function getKnownUserIds() {
      try {
        const raw = localStorage.getItem(KNOWN_USER_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.map(String) : [];
      } catch (e) {
        return [];
      }
    }

    function rememberKnownUserId(id) {
      const sid = String(id || "").trim();
      if (!sid) return;
      const list = getKnownUserIds();
      if (!list.includes(sid)) {
        list.push(sid);
        // 最多保留 30 个历史 ID
        while (list.length > 30) list.shift();
        try {
          localStorage.setItem(KNOWN_USER_IDS_KEY, JSON.stringify(list));
        } catch (e) {}
      }
    }

    function loadUserProfilesById() {
      try {
        const raw = localStorage.getItem(USER_PROFILES_BY_ID_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === "object" ? obj : {};
      } catch (e) {
        return {};
      }
    }

    function saveUserProfilesById(map) {
      try {
        localStorage.setItem(
          USER_PROFILES_BY_ID_KEY,
          JSON.stringify(map || {}),
        );
      } catch (e) {}
    }

    // 把当前用户名/头像绑定到指定 userId
    function avatarKeyForUserId(userId) {
      return AVATAR_KEY + "__" + String(userId || "").trim();
    }

    function snapshotProfileForUserId(userId) {
      const id = String(userId || "").trim();
      if (!id) return;
      const username = state.username || getStoredUsername() || "";
      const rawAvatar = state.avatar || getStoredAvatar() || "";
      const avatar = /^https?:\/\//i.test(rawAvatar) ? rawAvatar : "";
      const map = loadUserProfilesById();
      map[id] = {
        username: username,
        // 仅保存 R2 公共 URL，不再把 base64 头像写入用户资料。
        avatar: avatar,
        hasAvatar: !!avatar,
        updatedAt: Date.now(),
      };
      saveUserProfilesById(map);
      // 每个 userId 独立存头像，避免换 ID 后丢失
      try {
        if (avatar) localStorage.setItem(avatarKeyForUserId(id), avatar);
        else localStorage.removeItem(avatarKeyForUserId(id));
      } catch (e) {
        console.warn("[头像] 按 ID 写入 localStorage 失败", e);
      }
      try {
        if (avatar) localStorage.setItem(AVATAR_KEY, avatar);
      } catch (e) {
        console.warn("[头像] 写入默认 AVATAR_KEY 失败", e);
      }
    }

    // 切换到某 userId 时恢复该 ID 曾保存的用户名/头像
    function restoreProfileForUserId(userId) {
      const id = String(userId || "").trim();
      if (!id) return { username: "", avatar: "" };
      const map = loadUserProfilesById();
      const prof = map[id] || {};
      let avatar = String(prof.avatar || "");
      // 1) 独立 key
      if (!avatar || avatar.indexOf("data:") !== 0) {
        try {
          const keyed = localStorage.getItem(avatarKeyForUserId(id));
          if (keyed) avatar = keyed;
        } catch (e) {}
      }
      // 2) presence 资料缓存
      if (
        (!avatar || avatar.indexOf("data:") !== 0) &&
        state.memberProfiles &&
        state.memberProfiles[id] &&
        state.memberProfiles[id].avatar
      ) {
        avatar = String(state.memberProfiles[id].avatar || "");
      }
      return {
        username: String(prof.username || ""),
        avatar: avatar || "",
      };
    }

    const _avatarBucketLookupInFlight = new Map();
    const _avatarBucketLookupMissUntil = Object.create(null);
    const _avatarBucketLookupCache = Object.create(null);

    async function lookupAvatarUrlFromStorageBucket(userId) {
      const id = String(userId || "").trim();
      if (!isValidUserId(id)) return "";
      const cached = _avatarBucketLookupCache[id];
      if (cached && Date.now() < cached.expiresAt) return cached.url || "";
      if (
        _avatarBucketLookupMissUntil[id] &&
        Date.now() < _avatarBucketLookupMissUntil[id]
      )
        return "";
      if (_avatarBucketLookupInFlight.has(id))
        return _avatarBucketLookupInFlight.get(id);
      const promise = (async function () {
        try {
          const response = await fetch(
            "/api/avatar?user_id=" +
              encodeURIComponent(id) +
              "&_=" +
              Date.now(),
            {
              method: "GET",
              headers: { Accept: "application/json" },
              cache: "no-store",
            },
          );
          const data = await response.json().catch(() => ({}));
          if (response.ok && data && data.ok && data.exists && data.url) {
            const url = String(data.url);
            _avatarBucketLookupCache[id] = {
              url: url,
              expiresAt: Date.now() + 60 * 1000,
            };
            return url;
          }
        } catch (e) {
          console.warn("[R2头像] 查询失败", e);
        }
        _avatarBucketLookupMissUntil[id] = Date.now() + 5 * 60 * 1000;
        return "";
      })();
      _avatarBucketLookupInFlight.set(id, promise);
      try {
        return await promise;
      } finally {
        _avatarBucketLookupInFlight.delete(id);
      }
    }

    function applySyncedSelfAvatar(userId, avatarUrl) {
      const id = String(userId || "").trim();
      const url = String(avatarUrl || "").trim();
      const currentId = String(state.userId || getStoredUserId() || "");
      if (!id || !url || id !== currentId) return false;
      return saveAvatar(url);
    }

    function syncAvatarFromStorageBucket(userId, onDone) {
      const id = String(userId || "").trim();
      lookupAvatarUrlFromStorageBucket(id)
        .then(function (url) {
          const ok = !!(url && applySyncedSelfAvatar(id, url));
          if (ok) state._pendingAvatarSync = false;
          if (typeof onDone === "function") onDone(ok);
        })
        .catch(function () {
          if (typeof onDone === "function") onDone(false);
        });
    }

    // 兼容旧资料消息：存储桶无头像时再从 GoEasy profile 历史寻找 URL。
    function _syncAvatarFromGoEasyHistoryLegacy(userId, onDone) {
      const id = String(userId || "").trim();
      if (
        !id ||
        !goEasy ||
        !state.goEasyReady ||
        !goEasy.pubsub ||
        typeof goEasy.pubsub.history !== "function"
      ) {
        if (typeof onDone === "function") onDone(false);
        return;
      }
      try {
        goEasy.pubsub.history({
          channel: PUBLIC_CHANNEL,
          limit: Math.max(HISTORY_LIMIT, 50),
          onSuccess: function (response) {
            try {
              const content =
                response && response.content ? response.content : response;
              const list =
                (content && content.messages) ||
                (content && content.messageList) ||
                (Array.isArray(content) ? content : []) ||
                [];
              let found = "";
              // 从新到旧找最新 profile
              for (let i = list.length - 1; i >= 0; i--) {
                const raw = _historyItemContent(list[i]);
                if (!raw) continue;
                let msg = null;
                try {
                  msg = typeof raw === "string" ? JSON.parse(raw) : raw;
                } catch (e) {
                  continue;
                }
                if (!msg) continue;
                if (!(msg.action === "set" || msg.type === "profile")) continue;
                const mid = String(
                  (msg.member && (msg.member.id || msg.member.userId)) || "",
                );
                if (mid !== id) continue;
                const av =
                  (msg.member &&
                    (msg.member.avatar ||
                      (msg.member.data && msg.member.data.avatar))) ||
                  "";
                if (av) {
                  found = String(av);
                  break;
                }
              }
              if (found && /^https?:\/\//i.test(found)) {
                const ok = applySyncedSelfAvatar(id, found);
                if (typeof onDone === "function") onDone(!!ok);
                return;
              }
            } catch (e) {
              console.warn("[头像] 历史同步解析失败", e);
            }
            if (typeof onDone === "function") onDone(false);
          },
          onFailed: function (err) {
            console.warn("[头像] 历史同步失败", err);
            if (typeof onDone === "function") onDone(false);
          },
        });
      } catch (e) {
        if (typeof onDone === "function") onDone(false);
      }
    }

    const _avatarProfileSyncInFlight = new Map();

    function syncAvatarFromGoEasyHistory(userId, onDone) {
      const id = String(userId || "").trim();
      if (!id) {
        if (typeof onDone === "function") onDone(false);
        return;
      }
      let promise = _avatarProfileSyncInFlight.get(id);
      if (!promise) {
        promise = new Promise(function (resolve) {
          syncAvatarFromStorageBucket(id, function (bucketOk) {
            if (bucketOk) {
              resolve(true);
              return;
            }
            _syncAvatarFromGoEasyHistoryLegacy(id, function (legacyOk) {
              resolve(!!legacyOk);
            });
          });
        });
        _avatarProfileSyncInFlight.set(id, promise);
        promise.then(
          function () { _avatarProfileSyncInFlight.delete(id); },
          function () { _avatarProfileSyncInFlight.delete(id); },
        );
      }
      if (typeof onDone === "function") {
        promise.then(
          function (ok) { onDone(!!ok); },
          function () { onDone(false); },
        );
      }
    }

    // 按 userId 定期用 R2 最新对象校准成员头像，修复异地设备持有旧 URL 的情况。
    function syncMissingMemberAvatarsFromBucket() {
      (state.onlineMembers || []).forEach(function (member) {
        const id = String((member && member.id) || "").trim();
        if (!id) return;
        lookupAvatarUrlFromStorageBucket(id)
          .then(function (url) {
            if (!url) return;
            const target = (state.onlineMembers || []).find(function (m) {
              return m && String(m.id) === id;
            });
            if (!target || String(target.avatar || "") === url) return;
            target.avatar = url;
            rememberMemberProfile(id, target.nickname || "", url);
            document
              .querySelectorAll(".chat-messages, #publicChatMessages")
              .forEach(function (el) {
                try {
                  delete el.dataset.sig;
                } catch (e) {}
              });
            updateOnlineMembersUI();
            state.servers.forEach(function (server) {
              renderChatMessages(server.id, false);
            });
            renderPublicChat(false);
          })
          .catch(function () {});
      });
    }

    function applyRestoredProfile(prof) {
      const username =
        prof && prof.username ? String(prof.username).trim() : "";
      const avatar = prof && prof.avatar ? String(prof.avatar).trim() : "";
      if (username) {
        try {
          localStorage.setItem(USERNAME_KEY, username);
        } catch (e) {}
        state.username = username;
      }
      // 头像：有记录就恢复；没有则清空，避免沿用上一个 ID 的头像
      try {
        localStorage.setItem(AVATAR_KEY, avatar || "");
      } catch (e) {}
      state.avatar = avatar || "";
      return { username: state.username, avatar: state.avatar };
    }

    function normalizeUsernameKey(name) {
      return String(name || "")
        .trim()
        .toLowerCase();
    }

    // 检查用户名是否被其他在线用户占用（同一 userId 可换多个用户名；不同 userId 不能同名）
    function isUsernameTakenByOtherOnline(name, exceptUserId) {
      const key = normalizeUsernameKey(name);
      if (!key) return false;
      const myId = String(
        exceptUserId || state.userId || getStoredUserId() || "",
      );
      const list = state.onlineMembers || [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m) continue;
        if (String(m.id) === myId) continue;
        if (normalizeUsernameKey(m.nickname) === key) return true;
      }
      return false;
    }

    function findOnlineUserByUsername(name) {
      const key = normalizeUsernameKey(name);
      if (!key) return null;
      const list = state.onlineMembers || [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m && normalizeUsernameKey(m.nickname) === key) return m;
      }
      return null;
    }

    // 用户名冲突：立即下线，直到改成未被占用的用户名再重连
    function forceOfflineDueToUsernameConflict() {
      state.usernameConflictOffline = true;
      state.usernameConflictOpen = true;
      state.goEasyReady = false;
      state.publicChatReady = false;
      state.presenceReady = false;
      state.chatSubscribed = {};
      // 从本地在线列表移除自己，避免残留
      try {
        const myId = String(state.userId || getStoredUserId() || "");
        state.onlineMembers = (state.onlineMembers || []).filter(function (m) {
          return m && String(m.id) !== myId;
        });
        state.onlineCount = state.onlineMembers.length;
        updateOnlineMembersUI();
      } catch (e) {}
      try {
        if (goEasy && typeof goEasy.disconnect === "function") {
          goEasy.disconnect();
        }
      } catch (e) {}
      showToast("⚠️ 用户名冲突，已下线，请修改用户名", 2800, false);
      showUsernamePrompt(
        function () {
          // 改名成功后的重连在 saveUsername 里处理
        },
        {
          forced: true,
          message: "当前用户名已被在线用户使用，请修改用户名后重新上线",
          title: "用户名冲突",
        },
      );
    }

    // 仅在「自己上线/重连」后调用：若自己的用户名已被其他在线用户占用 → 立即下线并强制改名
    function checkUsernameConflictAgainstOnline() {
      const myId = String(state.userId || getStoredUserId() || "");
      const myName = state.username || getStoredUsername() || "";
      if (!myName || !myId) return false;
      if (!isUsernameTakenByOtherOnline(myName, myId)) return false;
      if (state.usernameConflictOffline || state.usernameConflictOpen) {
        // 已在冲突下线流程中
        if (!state.usernameConflictOpen) {
          forceOfflineDueToUsernameConflict();
        }
        return true;
      }
      forceOfflineDueToUsernameConflict();
      return true;
    }

    function requestSelfUsernameConflictCheck() {
      // 冲突下线中不要再触发连接后的检查循环
      if (state.usernameConflictOffline) return;
      state.pendingSelfConflictCheck = true;
    }

    function runPendingSelfUsernameConflictCheck() {
      if (state.usernameConflictOffline) {
        state.pendingSelfConflictCheck = false;
        return false;
      }
      if (!state.pendingSelfConflictCheck) return false;
      if (
        !Array.isArray(state.onlineMembers) ||
        state.onlineMembers.length === 0
      )
        return false;
      state.pendingSelfConflictCheck = false;
      return checkUsernameConflictAgainstOnline();
    }

    function reconnectAfterUsernameConflictResolved() {
      state.usernameConflictOffline = false;
      state.usernameConflictOpen = false;
      state.pendingSelfConflictCheck = false;
      showToast("✅ 用户名已更新，正在重新上线…", 2000, true);
      setTimeout(function () {
        try {
          if (typeof initGoEasy === "function") initGoEasy(0);
        } catch (e) {}
      }, 400);
    }

    function saveUserId(newId) {
      const trimmed = String(newId || "").trim();
      if (!isValidUserId(trimmed)) {
        showToast("⚠️ ID 仅允许字母数字、下划线、短横，长度 2-64", 2500, false);
        return false;
      }
      const oldId = state.userId || getStoredUserId();
      if (trimmed === oldId) return true;
      // 切换前：把当前用户名/头像存到旧 ID 下
      try {
        snapshotProfileForUserId(oldId);
      } catch (e) {}
      // 记录旧 ID；若换回曾经用过的 ID，则强制拉一次历史
      rememberKnownUserId(oldId);
      const known = getKnownUserIds();
      const switchingBack = known.includes(trimmed);
      if (switchingBack) {
        state.forceHistoryOnce = true;
        state.hasChatHistoryCache = false;
        state.hasPublicHistoryCache = false;
        state.chatSubscribed = {};
        state.publicChatReady = false;
      }
      rememberKnownUserId(trimmed);
      try {
        localStorage.setItem(USER_ID_KEY, trimmed);
      } catch (e) {}
      // 不迁移旧 ID 的 presence 缓存到新 ID；各 ID 独立
      state.userId = trimmed;
      // 换回/换到目标 ID：恢复该 ID 的用户名与头像
      try {
        const restored = restoreProfileForUserId(trimmed);
        applyRestoredProfile(restored);
      } catch (e) {}
      if (!/^https?:\/\//i.test(String(state.avatar || "")))
        state._pendingAvatarSync = true;
      // 无论本地是否有旧 URL，都使用稳定 userId 从 R2 校准到最新头像。
      setTimeout(function () {
        syncAvatarFromStorageBucket(trimmed);
      }, 0);
      // 更新本地成员列表中的自己
      if (Array.isArray(state.onlineMembers)) {
        state.onlineMembers = state.onlineMembers.filter(function (m) {
          return m && String(m.id) !== String(oldId);
        });
        state.onlineMembers.unshift({
          id: trimmed,
          nickname: state.username || "我",
          avatar: state.avatar || "",
        });
        state.onlineMembers = dedupeOnlineMembers(state.onlineMembers);
      }
      rememberMemberProfile(trimmed, state.username, state.avatar);
      // 立即按新 ID 重算左右气泡（自己/对方），并刷新头像显示
      try {
        patchOwnMessagesProfile();
        updateAllMessagesIsMine();
      } catch (e) {}
      updateOnlineMembersUI();
      // 用户 ID 变更需要重连 GoEasy，否则 presence 仍是旧 id
      try {
        if (
          goEasy &&
          state.goEasyReady &&
          typeof goEasy.disconnect === "function"
        ) {
          state.goEasyReady = false;
          state.publicChatReady = false;
          state.presenceReady = false;
          state.chatSubscribed = {};
          try {
            goEasy.disconnect();
          } catch (e) {}
        }
      } catch (e) {}
      setTimeout(function () {
        try {
          if (typeof initGoEasy === "function") initGoEasy(0);
        } catch (e) {}
      }, 400);
      showToast("✅ 用户 ID 已更新，正在重新连接…", 2200, true);
      return true;
    }

    function showUserIdPrompt(callback) {
      const old = document.getElementById("userIdEditModal");
      if (old) old.remove();
      const modal = document.createElement("div");
      modal.id = "userIdEditModal";
      modal.className = "custom-modal open";
      modal.innerHTML =
        '<div class="custom-modal-box" style="width:min(360px,calc(100% - 32px));">' +
        '<div class="custom-modal-header">' +
        "<span>编辑用户 ID</span>" +
        '<button type="button" class="custom-modal-close" id="userIdEditClose">✕</button>' +
        "</div>" +
        '<div class="custom-modal-body">' +
        '<p style="margin:0 0 10px;font-size:12px;color:var(--muted);line-height:1.5;">仅自己可见。修改后将重新连接聊天服务。</p>' +
        '<input type="text" id="userIdInput" maxlength="64" placeholder="输入新的用户 ID" ' +
        'value="' +
        esc(state.userId || getStoredUserId()) +
        '" ' +
        'style="width:100%;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:14px;outline:none;box-sizing:border-box;">' +
        '<button type="button" id="userIdConfirmBtn" class="submit-btn" style="margin-top:12px;">保存</button>' +
        "</div>" +
        "</div>";
      document.body.appendChild(modal);
      const input = modal.querySelector("#userIdInput");
      const close = function () {
        if (modal.parentElement) modal.remove();
      };
      modal.querySelector("#userIdEditClose").addEventListener("click", close);
      modal
        .querySelector("#userIdConfirmBtn")
        .addEventListener("click", function () {
          if (saveUserId(input.value)) {
            close();
            if (typeof callback === "function") callback();
          }
        });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          modal.querySelector("#userIdConfirmBtn").click();
        }
      });
      setTimeout(function () {
        try {
          input.focus();
          input.select();
        } catch (e) {}
      }, 50);
    }

    // ---- 消息持久化 ----
    function loadChatMessages() {
      try {
        const data = localStorage.getItem(CHAT_STORAGE_KEY);
        if (data !== null && data !== undefined) {
          // 只要本地存在历史缓存键（含空对象），就视为已有缓存，不再向远端拉历史
          state.hasChatHistoryCache = true;
          const parsed = JSON.parse(data);
          if (typeof parsed === "object" && parsed !== null) {
            const filtered = {};
            Object.keys(parsed).forEach((k) => {
              const msgs = parsed[k];
              if (Array.isArray(msgs)) {
                filtered[k] = msgs.filter((m) => !_deletedMsgIds.has(m.id));
              } else {
                filtered[k] = msgs;
              }
            });
            state.chatMessages = filtered;
            return;
          }
        }
      } catch (e) {
        /* ignore */
      }
      state.hasChatHistoryCache = false;
      state.chatMessages = {};
    }

    function saveChatMessages() {
      try {
        // 保存前再清理一次已删除消息
        const cleaned = {};
        Object.keys(state.chatMessages).forEach((k) => {
          const msgs = state.chatMessages[k];
          if (Array.isArray(msgs)) {
            cleaned[k] = msgs.filter((m) => !_deletedMsgIds.has(m.id));
          } else {
            cleaned[k] = msgs;
          }
        });
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(cleaned));
      } catch (e) {
        /* ignore */
      }
    }

    function loadPublicMessages() {
      try {
        const data = localStorage.getItem(PUBLIC_STORAGE_KEY);
        if (data !== null && data !== undefined) {
          state.hasPublicHistoryCache = true;
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            state.publicMessages = parsed.filter(
              (m) => !_deletedMsgIds.has(m.id),
            );
            return;
          }
        }
      } catch (e) {
        /* ignore */
      }
      state.hasPublicHistoryCache = false;
      state.publicMessages = [];
    }

    function savePublicMessages() {
      try {
        const cleaned = (state.publicMessages || []).filter(
          (m) => !_deletedMsgIds.has(m.id),
        );
        localStorage.setItem(PUBLIC_STORAGE_KEY, JSON.stringify(cleaned));
      } catch (e) {
        /* ignore */
      }
    }

    function isMessageMine(msg) {
      if (!msg) return false;
      const myId = String(state.userId || getStoredUserId() || "");
      const sid = String(msg.senderId || "");
      // 以 userId 为准：换 ID 后旧 ID 发出的消息应显示为对方
      if (myId && sid && sid === myId) return true;
      // 兼容极老消息无 senderId 的情况
      if (!sid && myId && String(msg.sender || "") === myId) return true;
      return false;
    }

    function updateAllMessagesIsMine() {
      Object.keys(state.chatMessages || {}).forEach(function (serverId) {
        const msgs = state.chatMessages[serverId];
        if (!msgs) return;
        msgs.forEach(function (msg) {
          msg.isMine = isMessageMine(msg);
        });
      });
      if (state.publicMessages) {
        state.publicMessages.forEach(function (msg) {
          msg.isMine = isMessageMine(msg);
        });
      }
      // 强制重绘（签名可能未变）
      try {
        document
          .querySelectorAll(".chat-messages, #publicChatMessages")
          .forEach(function (el) {
            try {
              delete el.dataset.sig;
            } catch (e) {}
          });
      } catch (e) {}
      Object.keys(state.chatMessages || {}).forEach(function (serverId) {
        renderChatMessages(serverId, false);
      });
      renderPublicChat(false);
      saveChatMessages();
      savePublicMessages();
    }

    function _upsertSelfMember(fields) {
      const myId = String(state.userId || getStoredUserId() || "");
      const patch = Object.assign(
        {
          id: myId,
          nickname: state.username || "我",
          avatar: state.avatar || "",
        },
        fields || {},
      );
      if (!Array.isArray(state.onlineMembers)) state.onlineMembers = [];
      // 先去掉所有同 id 的旧项，再插入唯一自己
      state.onlineMembers = state.onlineMembers.filter(function (m) {
        return m && String(m.id) !== myId;
      });
      state.onlineMembers.unshift(Object.assign({ id: myId }, patch));
      state.onlineMembers = dedupeOnlineMembers(state.onlineMembers);
      updateOnlineMembersUI();
    }

    function _broadcastPresenceSelf() {
      const myId = state.userId || getStoredUserId();
      const nick = state.username || "匿名用户";
      const avatar = /^https?:\/\//i.test(String(state.avatar || ""))
        ? String(state.avatar)
        : "";
      // 自己也写入资料缓存
      rememberMemberProfile(myId, nick, avatar);
      if (goEasy && state.goEasyReady) {
        try {
          if (typeof goEasy.pubsub.publish === "function") {
            const payload = JSON.stringify({
              type: "profile",
              action: "set",
              member: {
                id: myId,
                nickname: nick,
                avatar: avatar,
                data: { nickname: nick, avatar: avatar },
              },
              time: Date.now(),
            });
            goEasy.pubsub.publish({
              channel: PRESENCE_CHANNEL,
              message: payload,
              qos: 1,
            });
            // 兼容：部分环境 presence 频道与公共聊天频道相同；再向公共频道发一份
            if (
              typeof PUBLIC_CHANNEL !== "undefined" &&
              PUBLIC_CHANNEL !== PRESENCE_CHANNEL
            ) {
              goEasy.pubsub.publish({
                channel: PUBLIC_CHANNEL,
                message: payload,
                qos: 1,
              });
            }
          }
        } catch (e) {
          console.warn("[GoEasy] 广播资料更新异常", e);
        }
      }
    }

    function saveUsername(name) {
      const trimmed = name.trim();
      if (!trimmed) return false;
      // 不同在线用户 ID 禁止使用相同用户名；同一 ID 可随意更换用户名
      if (
        isUsernameTakenByOtherOnline(trimmed, state.userId || getStoredUserId())
      ) {
        showToast("⚠️ 当前用户名已被在线用户使用", 2500, false);
        return false;
      }
      localStorage.setItem(USERNAME_KEY, trimmed);
      state.username = trimmed;
      state.usernameConflictOpen = false;
      try {
        snapshotProfileForUserId(state.userId || getStoredUserId());
      } catch (e) {}
      const wasConflictOffline = !!state.usernameConflictOffline;
      _upsertSelfMember({ nickname: trimmed });
      if (!wasConflictOffline) {
        _broadcastPresenceSelf();
      }
      updateAllMessagesIsMine();
      patchOwnMessagesProfile();
      document
        .querySelectorAll(".chat-messages, #publicChatMessages")
        .forEach(function (el) {
          try {
            delete el.dataset.sig;
          } catch (e) {}
        });
      refreshAllChatUI();
      if (wasConflictOffline) {
        reconnectAfterUsernameConflictResolved();
      }
      return true;
    }

    function saveAvatar(url) {
      const u = String(url || "").trim();
      // 新同步方式只接受存储桶公共 URL，禁止继续写入 base64。
      if (!/^https?:\/\//i.test(u)) return false;
      try {
        localStorage.setItem(AVATAR_KEY, u);
      } catch (e) {}
      state.avatar = u;
      try {
        snapshotProfileForUserId(state.userId || getStoredUserId());
      } catch (e) {}
      _upsertSelfMember({ avatar: u });
      _broadcastPresenceSelf();
      patchOwnMessagesProfile();
      document
        .querySelectorAll(".chat-messages, #publicChatMessages")
        .forEach(function (el) {
          try {
            delete el.dataset.sig;
          } catch (e) {}
        });
      refreshAllChatUI();
      return true;
    }

    function showUsernamePrompt(callback, options) {
      options = options || {};
      const forced = !!options.forced;
      const firstSetup =
        !!options.firstSetup ||
        (!forced && !state.username && !getStoredUsername());
      const showUserId = firstSetup || !!options.showUserId;
      // 首次按聊天入口触发的资料配置允许取消；用户名冲突等 forced 场景仍必须处理。
      const noClose = forced;
      const message =
        options.message ||
        (firstSetup
          ? "首次使用请设置用户名和用户 ID："
          : "请输入您在聊天中显示的名称：");
      const title =
        options.title || (firstSetup ? "👤 完善资料" : "👤 设置用户名");

      if (usernameModalInstance) {
        usernameModalInstance.remove();
        usernameModalInstance = null;
      }

      const currentId = state.userId || getStoredUserId() || "";
      const modal = document.createElement("div");
      modal.className = "custom-modal open";
      modal.style.display = "flex";
      modal.innerHTML = `
      <div class="custom-modal-box" style="width:min(380px,calc(100% - 32px));">
        <div class="custom-modal-header">
          <span>${esc(title)}</span>
          ${noClose ? "" : '<button type="button" class="custom-modal-close username-modal-close" aria-label="关闭">✕</button>'}
        </div>
        <div class="custom-modal-body">
          <p style="margin:0 0 16px;font-size:14px;color:${forced ? "var(--red)" : "var(--muted)"};line-height:1.55;">${esc(message)}</p>
          <div class="form-row" style="margin-bottom:10px;">
            <input type="text" id="usernameInput" placeholder="输入用户名" value="${esc(forced ? "" : getStoredUsername() || "")}" maxlength="20" autofocus>
          </div>
          ${
            showUserId
              ? `
          <div class="form-row" style="margin-bottom:4px;">
            <input type="text" id="userIdSetupInput" placeholder="输入用户 ID（字母数字下划线短横）" value="${esc(currentId)}" maxlength="64">
          </div>
          <p style="margin:0 0 8px;font-size:11px;color:var(--muted);line-height:1.4;">用户 ID 用于区分账号，可与用户名不同</p>
          `
              : ""
          }
          <button id="usernameConfirmBtn" class="submit-btn" style="margin-top:12px;">
            <span class="spinner"></span>
            <span class="btn-text">确认</span>
          </button>
        </div>
      </div>
    `;
      document.body.appendChild(modal);
      usernameModalInstance = modal;

      const input = modal.querySelector("#usernameInput");
      const idInput = modal.querySelector("#userIdSetupInput");
      const confirmBtn = modal.querySelector("#usernameConfirmBtn");
      const closeBtn = modal.querySelector(".username-modal-close");

      function trySave() {
        const val = (input.value || "").trim();
        if (!val) {
          showToast("⚠️ 请输入用户名", 1500, false);
          return;
        }
        // 首次设置：先处理用户 ID（恢复头像 / 拉历史），再保存用户名
        if (showUserId && idInput) {
          const newId = (idInput.value || "").trim();
          if (!newId) {
            showToast("⚠️ 请输入用户 ID", 1500, false);
            idInput.focus();
            return;
          }
          if (!isValidUserId(newId)) {
            showToast(
              "⚠️ ID 仅允许字母数字、下划线、短横，长度 2-64",
              2500,
              false,
            );
            idInput.focus();
            return;
          }
          const oldId = String(state.userId || getStoredUserId() || "");
          const known = getKnownUserIds();
          const isKnownId = known.includes(newId);
          const idChanged = newId !== oldId;

          // 写入新 ID
          try {
            localStorage.setItem(USER_ID_KEY, newId);
          } catch (e) {}
          state.userId = newId;
          rememberKnownUserId(oldId);
          rememberKnownUserId(newId);

          // 恢复该 ID 曾保存的头像（用户名以本次输入为准）
          try {
            const restored = restoreProfileForUserId(newId);
            if (
              restored &&
              /^https?:\/\//i.test(String(restored.avatar || ""))
            ) {
              try {
                localStorage.setItem(AVATAR_KEY, restored.avatar);
              } catch (e) {}
              try {
                localStorage.setItem(
                  avatarKeyForUserId(newId),
                  restored.avatar,
                );
              } catch (e) {}
              state.avatar = restored.avatar;
              rememberMemberProfile(
                newId,
                val || state.username || "",
                restored.avatar,
              );
            } else {
              // 本地没有：立即按旧 userId 从 R2 查询；连接后再以 GoEasy 历史作兼容兜底。
              state.avatar = "";
              try {
                localStorage.removeItem(AVATAR_KEY);
              } catch (e) {}
              state._pendingAvatarSync = true;
            }
          } catch (e) {
            state._pendingAvatarSync = true;
          }
          // 即使恢复到了本地旧 URL，也向 R2 查询一次以校准最新版本。
          setTimeout(function () {
            syncAvatarFromStorageBucket(newId);
          }, 0);

          // 曾用过的 ID 或切换了 ID：强制拉一次历史
          if (isKnownId || idChanged) {
            state.forceHistoryOnce = true;
            state.hasChatHistoryCache = false;
            state.hasPublicHistoryCache = false;
            state.chatSubscribed = {};
            state.publicChatReady = false;
          }

          // 首次设置阶段尚未连接：不要在这里 disconnect/init，交给外层 callback 一次连接
          // 若已经在线且改了 ID，标记需要用新 ID 重连（由 callback 或后续逻辑处理）
          if (idChanged && goEasy && state.goEasyReady) {
            try {
              state.goEasyReady = false;
              state.presenceReady = false;
              state.publicChatReady = false;
              state.chatSubscribed = {};
              if (typeof goEasy.disconnect === "function") goEasy.disconnect();
            } catch (e) {}
          }
        }

        if (
          isUsernameTakenByOtherOnline(val, state.userId || getStoredUserId())
        ) {
          showToast("⚠️ 当前用户名已被在线用户使用", 2500, false);
          input.focus();
          return;
        }
        if (saveUsername(val)) {
          // 把最终用户名+头像绑定到当前 ID
          try {
            snapshotProfileForUserId(state.userId || getStoredUserId());
          } catch (e) {}
          try {
            patchOwnMessagesProfile();
            updateAllMessagesIsMine();
            updateOnlineMembersUI();
          } catch (e) {}
          modal.remove();
          usernameModalInstance = null;
          state.usernameConflictOpen = false;
          // 只走一次连接：由 ensureUsername 的 callback 继续 initGoEasy.connect
          // 避免重复 initGoEasy 导致 getInstance/connect 冲突 →「初始化失败」
          if (typeof callback === "function") {
            try {
              callback();
            } catch (e) {
              console.error("首次设置后连接回调异常", e);
              setTimeout(function () {
                try {
                  if (typeof initGoEasy === "function") initGoEasy(0);
                } catch (e2) {}
              }, 800);
            }
          }
        }
      }

      if (confirmBtn) confirmBtn.addEventListener("click", trySave);
      if (input) {
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            if (showUserId && idInput) idInput.focus();
            else trySave();
          }
        });
      }
      if (idInput) {
        idInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            trySave();
          }
        });
      }
      if (closeBtn) {
        closeBtn.addEventListener("click", function () {
          if (noClose) return;
          modal.remove();
          usernameModalInstance = null;
        });
      }
      setTimeout(function () {
        try {
          input.focus();
        } catch (e) {}
      }, 100);
    }

    function ensureUsername(callback) {
      if (state.username) {
        if (callback) callback();
        return true;
      }
      const stored = getStoredUsername();
      if (stored) {
        state.username = stored;
        updateAllMessagesIsMine();
        updateChatUI();
        if (callback) callback();
        return true;
      }
      // 仅由聊天相关入口调用：沿用原首次设置窗口（用户名 + 用户 ID、不可关闭）。
      showUsernamePrompt(callback, { firstSetup: true });
      return false;
    }

    // 公共聊天图标、在线成员图标、服务器聊天输入框共用的资料门禁。
    // 配置成功后再启动聊天连接；页面首次进入时不会调用本函数。
    // 进入前必须先配置 GoEasy（appkey + host），否则引导打开环境变量设置。
    let _pendingChatAfterEnv = null;

    function isGoEasyConfigured() {
      try {
        const ak =
          state.goEasyConfig && state.goEasyConfig.appkey
            ? String(state.goEasyConfig.appkey).trim()
            : "";
        const host =
          state.goEasyConfig && state.goEasyConfig.host
            ? String(state.goEasyConfig.host).trim()
            : "";
        return !!(ak && host);
      } catch (e) {
        return false;
      }
    }

    function openEnvSettingsFromChatGate() {
      try {
        const btn = document.getElementById("envSettingsBtn");
        if (btn) {
          btn.click();
          return;
        }
      } catch (e) {}
      // 兜底：直接打开模态框（无安全流程时）
      try {
        const modal = document.getElementById("envSettingsModal");
        if (modal) modal.classList.add("open");
      } catch (e2) {}
    }

    function proceedAfterUsernameForChat(callback) {
      return ensureUsername(function () {
        updateChatUI();
        ensureGoEasySdk(function () {
          if (!state.goEasyReady && !_goEasyInitInFlight) initGoEasy(0);
        });
        if (typeof callback === "function") callback();
      });
    }

    function requireUsernameForChat(callback) {
      function continueChatGate() {
        if (!isGoEasyConfigured()) {
          showToast(
            "⚠️ 请先配置 GoEasy 环境变量（AppKey 和主机）后再设置用户名",
            3500,
            false,
          );
          _pendingChatAfterEnv = function () {
            _pendingChatAfterEnv = null;
            proceedAfterUsernameForChat(callback);
          };
          openEnvSettingsFromChatGate();
          return false;
        }
        _pendingChatAfterEnv = null;
        return proceedAfterUsernameForChat(callback);
      }

      // 若本地尚未拿到 runtime 配置，先补拉一次再判断
      if (!isGoEasyConfigured()) {
        getJSON("/api/env/runtime?_=" + Date.now())
          .then(function (d) {
            try {
              if (
                d &&
                d.ok === true &&
                d.config &&
                typeof d.config === "object"
              ) {
                if (d.config.goeasy && typeof d.config.goeasy === "object") {
                  state.goEasyConfig = d.config.goeasy;
                }
                if (
                  d.config.cloudflare_r2 &&
                  typeof d.config.cloudflare_r2 === "object"
                ) {
                  state.r2Config = d.config.cloudflare_r2;
                }
              }
            } catch (e) {}
            continueChatGate();
          })
          .catch(function () {
            continueChatGate();
          });
        return false;
      }
      return continueChatGate();
    }

    function updateChatUI() {
      const hasUsername = !!state.username;
      const ready = state.goEasyReady && hasUsername;
      document.querySelectorAll(".server-group .chat-input").forEach((inp) => {
        if (!hasUsername) {
          inp.disabled = false;
          inp.readOnly = true;
          inp.dataset.requiresUsername = "true";
          inp.placeholder = "请先设置用户名";
        } else {
          inp.readOnly = false;
          delete inp.dataset.requiresUsername;
          inp.disabled = !state.goEasyReady;
          inp.placeholder = ready ? "输入聊天内容..." : "聊天未连接";
        }
      });
      document
        .querySelectorAll(".server-group .chat-send-btn")
        .forEach((btn) => {
          btn.disabled = !ready;
        });
      document
        .querySelectorAll(".chat-plus-btn, .chat-voice-btn")
        .forEach((btn) => {
          btn.disabled = !ready;
        });
      const pubInput = document.getElementById("publicChatInput");
      const pubSend = document.getElementById("publicChatSendBtn");
      if (pubInput) {
        if (!hasUsername) {
          pubInput.disabled = false;
          pubInput.readOnly = true;
          pubInput.dataset.requiresUsername = "true";
          pubInput.placeholder = "请先设置用户名";
        } else {
          pubInput.readOnly = false;
          delete pubInput.dataset.requiresUsername;
          pubInput.disabled = !state.goEasyReady;
          pubInput.placeholder = ready ? "输入公共消息..." : "聊天未连接";
        }
      }
      if (pubSend) pubSend.disabled = !ready;
    }

    // ===== 文件上传（Cloudflare R2，经后端 /api/upload） =====
    function formatFileSize(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
      return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }

    function detectMediaTypeFromFile(file) {
      const t = ((file && file.type) || "").toLowerCase();
      const name = ((file && file.name) || "").toLowerCase();
      if (
        t.startsWith("image/") ||
        /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(name)
      )
        return "image";
      if (t.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(name))
        return "video";
      if (
        t.startsWith("audio/") ||
        /\.(mp3|wav|ogg|m4a|aac|flac|amr|opus)$/i.test(name)
      )
        return "audio";
      return "file";
    }

    // 上传进度 Toast（0–100%）
    // 0~89%: 上传到服务器；90~99%: 存入云存储；100%: 完成
    var _cosSimTimer = null; // R2 阶段模拟进度定时器
    function showUploadProgress(percent) {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      if (p >= 100) {
        // 上传全部完成（含 R2）
        showToast("✅ 上传成功", 1500, true);
      } else if (p >= 90) {
        showToast("⏳ 存入云存储 " + p + "%", 60000, true);
      } else {
        showToast("⏳ 上传中 " + p + "%", 60000, true);
      }
    }
    // 浏览器上传完成后，模拟 R2 存储进度 90%→99%
    var _cosSimLastP = -1; // 上次显示的整数百分比，避免重复
    function _startCosSimProgress() {
      _stopCosSimProgress();
      var cosP = 90;
      _cosSimLastP = 90;
      showUploadProgress(90);
      _cosSimTimer = setInterval(function () {
        if (cosP >= 99) {
          _stopCosSimProgress();
          return;
        }
        // 越接近 99% 越慢，模拟真实上传感
        var step = cosP < 94 ? 1 : cosP < 97 ? 0.7 : 0.4;
        cosP = Math.min(99, cosP + step);
        var rp = Math.round(cosP);
        if (rp !== _cosSimLastP) {
          _cosSimLastP = rp;
          showUploadProgress(rp);
        }
      }, 600);
    }
    function _stopCosSimProgress() {
      if (_cosSimTimer) {
        clearInterval(_cosSimTimer);
        _cosSimTimer = null;
      }
    }

    // Cloudflare R2 屏蔽下载的文件后缀（R2 检测文件内容，改文件名无效）
    const _cosBlockedExts = [
      "apk",
      "ipa",
      "exe",
      "msi",
      "bat",
      "cmd",
      "ps1",
      "vbs",
      "scr",
      "dll",
      "sys",
    ];
    function _isCosBlockedExt(name) {
      const n = (name || "").toLowerCase();
      return _cosBlockedExts.some((ext) => n.endsWith("." + ext));
    }

    // ===== XOR 加密：绕过 R2 文件内容检测 =====
    // 上传前 XOR 加密 → R2 无法识别文件格式 → 下载时 XOR 解密还原
    const _XOR_KEY = 0x5a;
    // 判断消息是否为 XOR 加密文件：优先用 isXor 标志，兜底检测 URL/.dlp 后缀
    function _isXorMsg(msg) {
      if (msg.isXor) return true;
      const url = msg.url || "";
      if (url.toLowerCase().endsWith(".dlp")) return true;
      return false;
    }
    function _xorBuffer(buf) {
      const arr = new Uint8Array(buf);
      for (let i = 0; i < arr.length; i++) arr[i] ^= _XOR_KEY;
      return arr.buffer;
    }
    async function _xorEncryptFile(file) {
      const buf = await file.arrayBuffer();
      _xorBuffer(buf);
      const safeName = file.name + ".dlp";
      return new File([buf], safeName, { type: "application/octet-stream" });
    }
    // ===== 内置下载器：由 Python 后端直接保存到 Android 公共 Download 目录 =====
    const BUILTIN_DOWNLOAD_DIR = "/storage/emulated/0/Download";
    let _downloadRequestId = 0;

    // 已知文件扩展名白名单（用于无后缀 URL 的扩展名推断）
    // 完整列表太长，这里只放最常见、命中率最高的几个
    const _KNOWN_FILE_EXTS = new Set([
      "zip",
      "rar",
      "7z",
      "tar",
      "gz",
      "bz2",
      "xz",
      "exe",
      "msi",
      "apk",
      "ipa",
      "dmg",
      "pkg",
      "deb",
      "rpm",
      "pdf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "jpg",
      "jpeg",
      "png",
      "gif",
      "bmp",
      "webp",
      "svg",
      "ico",
      "tiff",
      "mp3",
      "wav",
      "flac",
      "aac",
      "ogg",
      "m4a",
      "opus",
      "mp4",
      "mkv",
      "avi",
      "mov",
      "wmv",
      "flv",
      "webm",
      "m4v",
      "ts",
      "iso",
      "img",
      "bin",
      "dat",
      "txt",
      "md",
      "json",
      "xml",
      "csv",
      "log",
      "apk.dlp",
      "dlp",
    ]);

    // 根据 MIME 或 URL 末段推断扩展名
    // 优先用 Content-Type,失败再用 URL 末段,都没有返回 null
    function _inferFileExtension(url, mimeType) {
      // 1. 从 MIME 推断
      if (mimeType) {
        const m = String(mimeType).toLowerCase().split(";")[0].trim();
        const mimeMap = {
          "application/zip": ".zip",
          "application/x-zip-compressed": ".zip",
          "application/x-rar-compressed": ".rar",
          "application/x-7z-compressed": ".7z",
          "application/x-tar": ".tar",
          "application/gzip": ".gz",
          "application/pdf": ".pdf",
          "application/msword": ".doc",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            ".docx",
          "application/vnd.ms-excel": ".xls",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
            ".xlsx",
          "application/vnd.ms-powerpoint": ".ppt",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            ".pptx",
          "application/octet-stream": null, // 不可靠,继续尝试 URL
          "application/x-apk": ".apk",
          "application/vnd.android.package-archive": ".apk",
          "application/x-iso9660-image": ".iso",
          "application/x-msdownload": ".exe",
          "application/x-deb": ".deb",
          "application/x-rpm": ".rpm",
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/gif": ".gif",
          "image/webp": ".webp",
          "image/svg+xml": ".svg",
          "image/x-icon": ".ico",
          "image/bmp": ".bmp",
          "audio/mpeg": ".mp3",
          "audio/mp3": ".mp3",
          "audio/wav": ".wav",
          "audio/x-wav": ".wav",
          "audio/flac": ".flac",
          "audio/aac": ".aac",
          "audio/ogg": ".ogg",
          "audio/x-m4a": ".m4a",
          "audio/mp4": ".m4a",
          "audio/opus": ".opus",
          "video/mp4": ".mp4",
          "video/x-matroska": ".mkv",
          "video/x-msvideo": ".avi",
          "video/quicktime": ".mov",
          "video/webm": ".webm",
          "text/plain": ".txt",
          "text/markdown": ".md",
          "application/json": ".json",
          "application/xml": ".xml",
          "text/xml": ".xml",
          "text/csv": ".csv",
        };
        if (m in mimeMap) return mimeMap[m]; // 可能是 null(继续 URL 推断)
      }
      // 2. 从 URL 末段推断
      try {
        const u = new URL(url, window.location.href);
        const pathname = u.pathname || "";
        const lastSlash = pathname.lastIndexOf("/");
        const lastSeg =
          lastSlash >= 0 ? pathname.substring(lastSlash + 1) : pathname;
        // 去掉查询参数(已由 URL 解析隔离)
        const dotIdx = lastSeg.lastIndexOf(".");
        if (dotIdx > 0 && dotIdx < lastSeg.length - 1) {
          const ext = lastSeg.substring(dotIdx).toLowerCase();
          if (ext.length <= 6 && /^\.[a-z0-9.]+$/.test(ext)) {
            return ext;
          }
        }
        // 2.1 末段是常见下载入口关键字时兜底为 .zip
        // 例如 https://xxx.com/downloads/ldn-mitm/latest 这种 "latest" 端点
        // 多数服务器都会返回 zip 压缩包，这样即使 HEAD 请求被 CORS/中间件拦截
        // 也能保证保存的文件有正确的扩展名
        const lastSegLower = lastSeg.toLowerCase();
        if (
          lastSegLower === "latest" ||
          lastSegLower === "download" ||
          lastSegLower === "dl" ||
          lastSegLower === "setup"
        ) {
          return ".zip";
        }
      } catch (_) {
        /* URL 解析失败 */
      }
      return null;
    }

    // 推断 URL 内容类型(文件 / 网站)
    // 返回 { type: 'file'|'web'|'unknown', ext?: string, mimeHint?: string }
    function _classifyLink(url) {
      if (!url) return { type: "unknown" };
      const cleaned = String(url).trim();
      // 1. 明显的文件扩展名 → 文件
      try {
        const u = new URL(cleaned, window.location.href);
        const pathname = u.pathname || "";
        const lastSlash = pathname.lastIndexOf("/");
        const lastSeg =
          lastSlash >= 0 ? pathname.substring(lastSlash + 1) : pathname;
        const dotIdx = lastSeg.lastIndexOf(".");
        if (dotIdx > 0 && dotIdx < lastSeg.length - 1) {
          const ext = lastSeg.substring(dotIdx + 1).toLowerCase();
          if (
            ext.length <= 6 &&
            /^[a-z0-9]+$/.test(ext) &&
            _KNOWN_FILE_EXTS.has(ext)
          ) {
            return { type: "file", ext: "." + ext };
          }
        }
      } catch (_) {
        /* ignore */
      }
      // 2. 域名/IP/无扩展名路径 → 网站
      return { type: "web" };
    }

    // 显示"在系统 WebView 中查看 / 用外部浏览器打开"选择弹窗
    function _showLinkOpenChooser(url) {
      return new Promise((resolve) => {
        // 移除旧弹窗
        const old = document.getElementById("linkOpenChooser");
        if (old) old.remove();

        const overlay = document.createElement("div");
        overlay.id = "linkOpenChooser";
        overlay.className = "msg-action-menu open";
        // 显示域名
        let displayHost = url;
        try {
          displayHost = new URL(url, window.location.href).host || url;
        } catch (_) {}
        // 截断过长 host
        if (displayHost.length > 40)
          displayHost = displayHost.substring(0, 38) + "…";

        overlay.innerHTML =
          '<div class="msg-action-mask"></div>' +
          '<div class="link-open-sheet" style="position:relative;z-index:1;width:min(320px,calc(100% - 32px));background:var(--white);border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;">' +
          '<div style="padding:18px 18px 8px;text-align:center;">' +
          '<div style="font-size:14px;color:var(--muted);margin-bottom:8px;">🔗 打开链接</div>' +
          '<div style="font-size:13px;font-weight:700;color:var(--ink);word-break:break-all;line-height:1.4;">' +
          esc(displayHost) +
          "</div>" +
          "</div>" +
          '<div style="padding:8px 12px 12px;display:flex;flex-direction:column;gap:8px;">' +
          '<button type="button" data-action="webview" ' +
          'style="width:100%;border:0;border-radius:14px;padding:14px;background:linear-gradient(135deg,var(--cyan),#14a891);color:#fff;font-weight:800;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">' +
          '<span style="font-size:18px;">🌐</span>' +
          "<span>在系统 WebView 中打开</span>" +
          "</button>" +
          '<button type="button" data-action="external" ' +
          'style="width:100%;border:0;border-radius:14px;padding:14px;background:rgba(125,175,210,.15);color:var(--ink);font-weight:800;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">' +
          '<span style="font-size:18px;">🚀</span>' +
          "<span>用外部浏览器打开</span>" +
          "</button>" +
          '<button type="button" data-action="cancel" ' +
          'style="width:100%;border:0;border-radius:14px;padding:10px;background:transparent;color:var(--muted);font-weight:600;font-size:13px;cursor:pointer;margin-top:2px;">' +
          "取消" +
          "</button>" +
          "</div>" +
          "</div>";

        document.body.appendChild(overlay);

        let resolved = false;
        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          document.removeEventListener("keydown", onKey, true);
          if (overlay.parentElement) overlay.remove();
        };
        const onKey = (e) => {
          if (e.key === "Escape") {
            cleanup();
            resolve(null);
          }
        };

        overlay
          .querySelector('[data-action="webview"]')
          .addEventListener("click", () => {
            cleanup();
            resolve("webview");
          });
        overlay
          .querySelector('[data-action="external"]')
          .addEventListener("click", () => {
            cleanup();
            resolve("external");
          });
        overlay
          .querySelector('[data-action="cancel"]')
          .addEventListener("click", () => {
            cleanup();
            resolve(null);
          });
        document.addEventListener("keydown", onKey, true);
      });
    }

    // 调用原生 Intent 打开外部浏览器(绕开 WebView intent:// 包装 bug) - 已修复：检测 Java 返回值
    function _openExternalBrowser(url) {
      try {
        if (
          window.LanPlayNative &&
          typeof window.LanPlayNative.openExternalBrowser === "function"
        ) {
          const ok = window.LanPlayNative.openExternalBrowser(String(url));
          if (ok === false) {
            console.warn("[外部浏览器] Java 端拒绝:", url);
            try {
              window.open(String(url), "_blank", "noopener");
              return true;
            } catch (_) {}
            return false;
          }
          return true;
        }
      } catch (e) {
        console.warn("[外部浏览器] Java 桥接调用失败", e);
      }
      try {
        window.open(String(url), "_blank", "noopener");
        return true;
      } catch (_) {}
      return false;
    }

    // 访问网络检测：后端综合来源 IP、代理转发头和访问 Host 判断公网/局域网。
    // 检测失败时按页面 Host 兜底；无法确认则优先浏览器下载，避免公网用户把文件误存到服务端手机。
    function _fallbackPublicAccessByHost() {
      let host = "";
      try {
        host = String(window.location.hostname || "")
          .trim()
          .toLowerCase();
      } catch (_) {}
      if (
        !host ||
        host === "localhost" ||
        host === "::1" ||
        host.endsWith(".local") ||
        host.endsWith(".lan")
      )
        return false;
      if (
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^169\.254\./.test(host)
      )
        return false;
      const m = host.match(/^172\.(\d{1,3})\./);
      if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
      if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host.replace(/^\[|\]$/g, "")))
        return false;
      // 其它域名或公网 IP 均按公网访问处理。
      return true;
    }

    async function _isPublicDownloadAccess() {
      try {
        const response = await fetch("/api/access-mode?_=" + Date.now(), {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (
          response.ok &&
          data &&
          data.ok === true &&
          typeof data.is_public === "boolean"
        ) {
          return data.is_public;
        }
      } catch (e) {
        console.warn("[下载] 网络类型检测失败，使用 Host 兜底", e);
      }
      return _fallbackPublicAccessByHost();
    }

    // 公网访问使用同源流式下载响应，由浏览器的下载管理器保存；服务端不写 Android Download 目录。
    // XOR 文件也由该响应边转发边还原，避免浏览器一次性把大文件读入内存。
    async function _browserDownload(url, fileName, isXor, mimeType) {
      let absoluteUrl = String(url || "");
      try {
        absoluteUrl = new URL(absoluteUrl, window.location.href).href;
      } catch (_) {}
      if (!/^https?:\/\//i.test(absoluteUrl)) {
        showToast("❌ 浏览器下载仅支持 http/https 地址", 2800, false);
        return false;
      }
      const name = String(fileName || "").trim() || "文件";
      try {
        const params = new URLSearchParams();
        params.set("url", absoluteUrl);
        params.set("filename", name);
        params.set("xor", isXor ? "1" : "0");
        if (mimeType) params.set("mime", String(mimeType));

        const a = document.createElement("a");
        a.href = "/api/browser-download?" + params.toString();
        a.download = name;
        // 标记为最终浏览器下载链接，避免被全局 a[download] 委托再次拦截而递归触发 Toast。
        a.dataset.browserDownloadDirect = "true";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          try {
            a.remove();
          } catch (_) {}
        }, 1500);
        showToast("✅ 已交给浏览器下载 " + name, 2600, true);
        return true;
      } catch (e) {
        showToast(
          "❌ 浏览器下载失败：" + (e && e.message ? e.message : e),
          3500,
          false,
        );
        return false;
      }
    }

    // 统一下载入口：公网调用浏览器下载；局域网仍由 Python 后端保存到 Android 公共 Download 目录。
    // 自动追加后缀:若 fileName 没有扩展名,先用 HEAD 请求拿 Content-Type,再用 URL 末段/Content-Type 推断补上
    async function _builtInDownload(url, fileName, isXor, mimeType) {
      if (!url) return false;
      const requestId = ++_downloadRequestId;
      let displayName = (fileName || "").trim() || "文件";
      let mimeHint = String(mimeType || "");

      // 智能追加扩展名:无后缀时探测
      try {
        const hasExt = /\.[a-z0-9]{1,6}(?:\.[a-z0-9]{1,6})?$/i.test(
          displayName,
        );
        if (!hasExt) {
          // 1. 先 HEAD 拿 Content-Type
          let headMime = "";
          try {
            const headRes = await fetch(String(url), {
              method: "HEAD",
              cache: "no-store",
            });
            headMime = headRes.headers.get("content-type") || "";
            // 一些服务器对 HEAD 返回 octet-stream,这种不可靠,继续走 URL 推断
          } catch (_) {
            /* HEAD 失败,继续 */
          }

          // 2. 推断扩展名
          const ext = _inferFileExtension(String(url), headMime || mimeHint);
          if (ext) {
            displayName = displayName + ext;
            console.log("[下载] 自动追加扩展名:", ext, "→", displayName);
          }
        }
      } catch (e) {
        console.warn("[下载] 扩展名推断失败,继续使用原文件名:", e);
      }

      // 每次下载都检测访问网络：公网不能调用服务端手机的内置下载目录。
      const isPublicAccess = await _isPublicDownloadAccess();
      if (isPublicAccess) {
        return _browserDownload(String(url), displayName, !!isXor, mimeHint);
      }

      // 局域网保持原有内置下载行为；不使用省略号结尾，完整显示文件名。
      showToast("⏳ 正在下载文件 " + displayName, 60000, true);
      try {
        const response = await fetch("/api/download", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            url: String(url),
            filename: String(displayName),
            xor: !!isXor,
          }),
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        // 后端若识别为公网会拒绝写入服务端目录；这里无缝改交浏览器下载。
        if (data && data.use_browser === true) {
          return _browserDownload(String(url), displayName, !!isXor, mimeHint);
        }
        if (!response.ok || !data.ok)
          throw new Error(data.error || "下载失败 (" + response.status + ")");
        const savedPath =
          data.file_path ||
          (data.directory || BUILTIN_DOWNLOAD_DIR) +
            "/" +
            (data.file_name || displayName);
        // 显示完整保存路径，不使用省略号截断
        showToast("✅ 已保存到 " + savedPath, 3600, true);
        return true;
      } catch (e) {
        // 后端不可用时不再打开浏览器下载，避免文件落到未知目录。
        showToast(
          "❌ 下载失败：" + (e && e.message ? e.message : e),
          3500,
          false,
        );
        return false;
      } finally {
        // 保留 requestId，便于后续扩展下载队列/进度显示。
        void requestId;
      }
    }

    // XOR 文件由后端边下载边解密，直接落盘为原始文件名。
    async function _xorDecryptAndDownload(url, originalName, mimeType) {
      return _builtInDownload(
        url,
        originalName,
        true,
        mimeType || "application/octet-stream",
      );
    }

    function isR2UploadConfigured() {
      const mb = Number(state.r2Config && state.r2Config.max_upload_mb);
      return Number.isFinite(mb) && mb > 0;
    }
    function requireR2ForUpload(actionLabel) {
      if (isR2UploadConfigured()) return true;
      const label = actionLabel || "上传";
      showToast(
        "❌ 请先在环境变量中配置存储桶（含 max_upload_mb）后再" + label,
        3200,
        false,
      );
      try {
        const btn = document.getElementById("envSettingsBtn");
        if (btn && typeof btn.click === "function") {
          setTimeout(function () {
            try {
              btn.click();
            } catch (_) {}
          }, 400);
        }
      } catch (_) {}
      return false;
    }

    function uploadFile(file) {
      if (!file) return Promise.resolve(null);
      if (!isR2UploadConfigured()) {
        requireR2ForUpload("上传");
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const formData = new FormData();
        // 如果文件后缀被 R2 屏蔽下载，XOR 加密文件内容让 R2 无法识别格式
        // 例: Arena_1.0.0.apk → XOR 加密 → 上传为 Arena_1.0.0.apk.dlp
        const originalName = file.name || "file";
        const isBlocked = _isCosBlockedExt(originalName);
        // blocked 文件：XOR 加密后上传；普通文件：原样上传
        const encryptPromise = isBlocked
          ? _xorEncryptFile(file)
          : Promise.resolve(file);
        encryptPromise.then((fileToUpload) => {
          formData.append("file", fileToUpload, fileToUpload.name);
          _doUpload(formData, file, originalName, isBlocked, resolve);
        });
        return; // 不走下面的直接 upload
      });
    }
    function _doUpload(formData, file, originalName, isBlocked, resolve) {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.timeout = 600000; // 10 分钟，大文件上传需要更长时间
      // 两阶段进度：浏览器→服务器(0~89%) + 服务器→R2(90~100%)
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && e.total > 0) {
          showUploadProgress((e.loaded / e.total) * 89);
        } else {
          showUploadProgress(
            Math.min(89, (e.loaded / Math.max(file.size, 1)) * 89),
          );
        }
      };
      xhr.upload.onloadstart = function () {
        showUploadProgress(0);
      };
      // 浏览器上传完成，服务器正在存入 R2 → 模拟 90%→99% 进度
      xhr.upload.onload = function () {
        _startCosSimProgress();
      };
      xhr.onerror = function () {
        _stopCosSimProgress();
        showToast("❌ 上传失败：网络错误", 3000, false);
        resolve(null);
      };
      xhr.ontimeout = function () {
        _stopCosSimProgress();
        showToast("❌ 上传超时", 3000, false);
        resolve(null);
      };
      xhr.onload = function () {
        try {
          const data = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 200 && xhr.status < 300 && data.ok && data.url) {
            _stopCosSimProgress();
            showUploadProgress(100);
            const fileType = data.file_type || detectMediaTypeFromFile(file);
            // fileName 始终返回原始文件名，下载时用原始名保存
            // isXor 标记：下载时需 XOR 解密还原
            resolve({
              url: data.url,
              type: fileType,
              fileName: originalName,
              fileSize:
                data.file_size != null ? data.file_size : file.size || 0,
              mimeType: data.mime_type || file.type || "",
              isXor: isBlocked,
            });
            return;
          }
          throw new Error(
            (data && data.error) || "上传失败 (" + xhr.status + ")",
          );
        } catch (e) {
          _stopCosSimProgress();
          showToast("❌ 上传失败：" + e.message, 3000, false);
          console.error("上传错误:", e);
          resolve(null);
        }
      };
      xhr.send(formData);
    }

    function buildMediaText(meta) {
      // 兼容旧客户端：前缀 + URL；额外字段走 mediaType/url/fileName/fileSize
      const type = meta.type || "file";
      const url = meta.url || "";
      if (type === "image") return "[图片]" + url;
      if (type === "video") return "[视频]" + url;
      if (type === "audio") return "[语音]" + url;
      return (
        "[文件]" +
        url +
        "|" +
        (meta.fileName || "file") +
        "|" +
        (meta.fileSize || 0)
      );
    }

    // ---- 待发送附件（支持多文件队列） ----
    function _pendingList(key) {
      if (!Array.isArray(state.pendingAttachments[key]))
        state.pendingAttachments[key] = [];
      return state.pendingAttachments[key];
    }
    function _renderPendingUI(key, input) {
      const area = input && input.closest(".chat-input-area");
      if (!area) return;
      let el = area.querySelector(".chat-pending");
      const list = state.pendingAttachments[key];
      const arr = Array.isArray(list) ? list : list ? [list] : [];
      if (!arr.length) {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.className = "chat-pending";
        area.insertBefore(el, area.firstChild);
      }
      if (arr.length === 1) {
        const m = arr[0];
        el.innerHTML = `<span class="chat-pending-name">📎 ${esc(m.fileName || { image: "图片", video: "视频", audio: "语音" }[m.mediaType] || "文件")}</span><button type="button" aria-label="取消附件">×</button>`;
      } else {
        el.innerHTML = `<span class="chat-pending-name">📎 ${arr.length} 个附件待发送</span><button type="button" aria-label="取消全部附件">×</button>`;
      }
      el.querySelector("button").onclick = () => {
        delete state.pendingAttachments[key];
        el.remove();
      };
    }
    function setPendingAttachment(key, media, input) {
      const list = _pendingList(key);
      list.push(media);
      _renderPendingUI(key, input);
    }
    function clearPendingAttachment(key, input) {
      delete state.pendingAttachments[key];
      const area = input && input.closest(".chat-input-area");
      const el = area && area.querySelector(".chat-pending");
      if (el) el.remove();
    }
    function sendPendingAttachment(key, input, isPublic, serverId) {
      const list = state.pendingAttachments[key];
      const arr = Array.isArray(list) ? list : list ? [list] : [];
      if (!arr.length) return false;
      // 逐条发送
      arr.forEach((media) => {
        if (isPublic) sendPublicMessage(media.text, media);
        else sendChatMessage(serverId, media.text, media);
      });
      clearPendingAttachment(key, input);
      return true;
    }
    function storeRecordedVoice(file, key, isPublic) {
      uploadFile(file).then((result) => {
        if (!result) return;
        result.type = "audio";
        const media = {
          mediaType: "audio",
          url: result.url,
          fileName: result.fileName || "语音消息",
          fileSize: result.fileSize,
          mimeType: result.mimeType,
          text: buildMediaText({
            type: "audio",
            url: result.url,
            fileName: result.fileName,
            fileSize: result.fileSize,
          }),
        };
        const input = isPublic
          ? document.getElementById("publicChatInput")
          : document.querySelector(
              `.server-group[data-id="${key}"] .chat-input`,
            );
        setPendingAttachment(key, media, input);
        showToast("🎙 语音已准备好，请点击“发送”", 1800, true);
      });
    }

    function sendMessageWithMedia(
      serverId,
      inputElement,
      sendFunction,
      isPublic,
      accept,
    ) {
      if (!requireR2ForUpload("上传文件")) return;
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = accept || "image/*,video/*,audio/*,*/*";
      fileInput.multiple = true;
      fileInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        // 上传上限只读取环境配置，不再使用前端内置的 R2 数值。
        const maxUploadMb =
          Number(state.r2Config && state.r2Config.max_upload_mb) || 0;
        if (maxUploadMb <= 0) {
          requireR2ForUpload("上传文件");
          return;
        }
        const maxUploadBytes = maxUploadMb * 1024 * 1024;
        const oversized = files.filter((f) => f.size > maxUploadBytes);
        const valid = files.filter((f) => f.size <= maxUploadBytes);
        if (oversized.length) {
          showToast(
            "❌ " +
              oversized.length +
              " 个文件超过 " +
              maxUploadMb +
              "MB 已跳过",
            2500,
            false,
          );
        }
        if (!valid.length) return;

        // 逐个上传，全部加入待发送队列，点「发送」才发出
        const key = isPublic ? "public" : serverId;
        showToast("⏳ 正在上传 " + valid.length + " 个文件…", 60000, true);
        let successCount = 0;
        let failCount = 0;
        for (let i = 0; i < valid.length; i++) {
          const result = await uploadFile(valid[i]);
          if (!result) {
            failCount++;
            continue;
          }
          const media = {
            mediaType: result.type,
            url: result.url,
            fileName: result.fileName,
            fileSize: result.fileSize,
            mimeType: result.mimeType,
            text: buildMediaText(result),
          };
          setPendingAttachment(key, media, inputElement);
          successCount++;
        }
        if (failCount > 0) {
          showToast(
            "✅ " +
              successCount +
              " 个附件已准备好，❌ " +
              failCount +
              " 个上传失败",
            2500,
            false,
          );
        } else {
          showToast(
            "📎 " + successCount + " 个附件已准备好，请点击“发送”",
            1800,
            true,
          );
        }
        if (inputElement) inputElement.focus();
      };
      fileInput.click();
    }

    // ---------- 「+」附件菜单：图片 / 视频 / 文件 ----------
    function closeAllPlusPanels(except) {
      document.querySelectorAll(".chat-plus-panel.open").forEach(function (el) {
        if (except && el === except) return;
        el.classList.remove("open");
      });
    }

    function bindPlusMenu(plusBtn, panel, handlers) {
      if (!plusBtn || !panel) return;
      plusBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        const willOpen = !panel.classList.contains("open");
        closeAllPlusPanels();
        if (willOpen) panel.classList.add("open");
      });
      panel.querySelectorAll("[data-plus-action]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          panel.classList.remove("open");
          const action = btn.getAttribute("data-plus-action");
          if (action === "image" && handlers.image) handlers.image();
          else if (action === "video" && handlers.video) handlers.video();
          else if (action === "file" && handlers.file) handlers.file();
        });
      });
    }

    if (!window.__chatPlusGlobalBound) {
      window.__chatPlusGlobalBound = true;
      document.addEventListener("click", function () {
        closeAllPlusPanels();
      });
    }

    // ---------- 语音录制（发送按钮左侧） ----------
    const _voiceRecordState = {
      recorder: null,
      stream: null,
      timer: null,
      startedAt: 0,
      activeBtn: null,
      audioContext: null,
      source: null,
      processor: null,
      silentGain: null,
      wavChunks: [],
      wavSampleRate: 44100,
      onBlob: null,
      stopping: false,
      cancelled: false,
    };

    function stopVoiceTracks() {
      if (_voiceRecordState.stream) {
        try {
          _voiceRecordState.stream.getTracks().forEach(function (t) {
            t.stop();
          });
        } catch (e) {
          /* ignore */
        }
        _voiceRecordState.stream = null;
      }
    }

    function resetVoiceBtn(btn) {
      if (!btn) return;
      btn.classList.remove("recording");
      btn.removeAttribute("data-recording-seconds");
      btn.textContent = "🎤";
      btn.title = "按住或点击录制语音";
    }

    function _disconnectVoiceGraph() {
      const state = _voiceRecordState;
      if (state.processor) {
        state.processor.onaudioprocess = null;
        try {
          state.processor.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      if (state.source) {
        try {
          state.source.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      if (state.silentGain) {
        try {
          state.silentGain.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      state.processor = null;
      state.source = null;
      state.silentGain = null;
      if (state.audioContext) {
        try {
          state.audioContext.close();
        } catch (_) {
          /* ignore */
        }
        state.audioContext = null;
      }
    }

    function _writeWavString(view, offset, value) {
      for (let i = 0; i < value.length; i++)
        view.setUint8(offset + i, value.charCodeAt(i));
    }

    function _makeWavBlob(chunks, sampleRate) {
      const totalSamples = chunks.reduce(function (sum, chunk) {
        return sum + chunk.length;
      }, 0);
      const dataSize = totalSamples * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);
      _writeWavString(view, 0, "RIFF");
      view.setUint32(4, 36 + dataSize, true);
      _writeWavString(view, 8, "WAVE");
      _writeWavString(view, 12, "fmt ");
      view.setUint32(16, 16, true); // PCM fmt chunk size
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true); // byte rate
      view.setUint16(32, 2, true); // block align
      view.setUint16(34, 16, true); // bits per sample
      _writeWavString(view, 36, "data");
      view.setUint32(40, dataSize, true);
      let offset = 44;
      chunks.forEach(function (chunk) {
        for (let i = 0; i < chunk.length; i++) {
          view.setInt16(offset, chunk[i], true);
          offset += 2;
        }
      });
      return new Blob([buffer], { type: "audio/wav" });
    }

    async function _stopWavRecording() {
      const state = _voiceRecordState;
      const recorder = state.recorder;
      if (!recorder || state.stopping) return;
      state.stopping = true;
      recorder.state = "stopping";
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }

      const cancelled = state.cancelled;
      if (state.processor) {
        state.processor.onaudioprocess = null;
        try {
          state.processor.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      stopVoiceTracks();
      _disconnectVoiceGraph();

      const chunks = state.wavChunks.slice();
      const sampleRate = state.wavSampleRate || 44100;
      const btn = state.activeBtn;
      const onBlob = state.onBlob;
      state.recorder = null;
      state.wavChunks = [];
      state.wavSampleRate = 44100;
      state.onBlob = null;
      state.stopping = false;
      state.cancelled = false;
      resetVoiceBtn(btn);
      state.activeBtn = null;

      if (cancelled) return;
      if (!chunks.length) {
        showToast("⚠️ 未录到声音", 1800, false);
        return;
      }
      const blob = _makeWavBlob(chunks, sampleRate);
      if (blob.size < 256) {
        showToast("⚠️ 录音太短", 1800, false);
        return;
      }
      const file = new File([blob], "voice_" + Date.now() + ".wav", {
        type: "audio/wav",
      });
      if (typeof onBlob === "function") onBlob(file);
    }

    function cancelVoiceRecording() {
      const state = _voiceRecordState;
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      if (
        state.recorder &&
        state.recorder.state !== "inactive" &&
        !state.stopping
      ) {
        state.cancelled = true;
        try {
          state.recorder.stop();
        } catch (_) {
          _disconnectVoiceGraph();
        }
        return;
      }
      state.recorder = null;
      state.wavChunks = [];
      state.wavSampleRate = 44100;
      state.onBlob = null;
      stopVoiceTracks();
      _disconnectVoiceGraph();
      resetVoiceBtn(state.activeBtn);
      state.activeBtn = null;
    }

    async function startVoiceRecording(btn, onBlob) {
      if (
        _voiceRecordState.recorder &&
        _voiceRecordState.recorder.state === "recording"
      ) {
        finishVoiceRecording(onBlob);
        return;
      }
      if (!requireR2ForUpload("录音")) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast("❌ 当前环境不支持录音", 2500, false);
        return;
      }
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        showToast("❌ 当前环境不支持 WAV 录音", 3000, false);
        return;
      }
      cancelVoiceRecording();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        const audioContext = new AudioContextCtor();
        if (audioContext.resume) await audioContext.resume();
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor
          ? audioContext.createScriptProcessor(4096, 1, 1)
          : audioContext.createJavaScriptNode(4096, 1, 1);
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;

        _voiceRecordState.stream = stream;
        _voiceRecordState.audioContext = audioContext;
        _voiceRecordState.source = source;
        _voiceRecordState.processor = processor;
        _voiceRecordState.silentGain = silentGain;
        _voiceRecordState.wavChunks = [];
        _voiceRecordState.wavSampleRate = Math.round(
          audioContext.sampleRate || 44100,
        );
        _voiceRecordState.onBlob = onBlob;
        _voiceRecordState.cancelled = false;
        _voiceRecordState.stopping = false;
        _voiceRecordState.activeBtn = btn;
        _voiceRecordState.startedAt = Date.now();

        processor.onaudioprocess = function (event) {
          if (_voiceRecordState.cancelled) return;
          const input = event.inputBuffer.getChannelData(0);
          const samples = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const sample = Math.max(-1, Math.min(1, input[i]));
            samples[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          }
          _voiceRecordState.wavChunks.push(samples);
        };
        source.connect(processor);
        // 静音输出保证 ScriptProcessor 在 Android WebView 中持续工作，避免麦克风回放啸叫。
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);

        _voiceRecordState.recorder = {
          state: "recording",
          stop: function () {
            _stopWavRecording();
          },
        };
        btn.classList.add("recording");
        btn.textContent = "⏹";
        btn.dataset.recordingSeconds = "0";
        btn.title = "点击停止并发送 WAV 语音";
        showToast("🎙 正在录制 WAV… 再次点击停止发送", 2000, true);
        _voiceRecordState.timer = setInterval(function () {
          const sec = Math.floor(
            (Date.now() - _voiceRecordState.startedAt) / 1000,
          );
          btn.textContent = "⏹";
          btn.dataset.recordingSeconds = String(sec);
          btn.title = "点击停止并发送 WAV 语音（" + sec + " 秒）";
          if (sec >= 60) finishVoiceRecording(onBlob);
        }, 500);
      } catch (e) {
        console.warn("WAV 录音失败", e);
        cancelVoiceRecording();
        showToast(
          "❌ 无法录制 WAV：" + (e.message || "请检查录音权限"),
          3500,
          false,
        );
      }
    }

    function finishVoiceRecording(onBlob) {
      const recorder = _voiceRecordState.recorder;
      if (
        !recorder ||
        recorder.state === "inactive" ||
        recorder.state === "stopping"
      ) {
        cancelVoiceRecording();
        return;
      }
      _voiceRecordState.onBlob = onBlob || _voiceRecordState.onBlob;
      try {
        recorder.stop();
      } catch (e) {
        cancelVoiceRecording();
      }
    }

    // 语音上传后进入待发送状态，由发送按钮统一发送。

    // ---- 链接识别（URL、域名、IPv4、IPv6）- 不追加协议头 ----
    // 根据 URL 末段扩展名判断是文件还是网站,给 chat-link 加 data-type
    function linkifyText(text) {
      if (!text) return "";
      const urlRegex =
        /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?|\b(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}|(?:[0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}|::[0-9a-fA-F]{1,4}|[0-9a-fA-F]{1,4}::)\b)/g;
      return text.replace(urlRegex, function (match) {
        const cleaned = match.replace(/[.,;:!?]+$/, "");
        const cls = _classifyLink(cleaned);
        return `<span class="chat-link" data-url="${esc(cleaned)}" data-type="${cls.type}">${esc(match)}</span>`;
      });
    }

    // 从旧版文本前缀解析媒体信息
    // 去掉 .dlp 后缀（XOR 加密文件上传时追加的）
    function _restoreBlockedExt(name) {
      if (typeof name !== "string") return name;
      return name.replace(/\.dlp$/i, "");
    }

    function parseMediaFromText(text) {
      if (!text || typeof text !== "string") return null;
      if (text.startsWith("[图片]")) {
        return {
          mediaType: "image",
          url: text.substring(4).trim(),
          fileName: "",
          fileSize: 0,
        };
      }
      if (text.startsWith("[视频]")) {
        return {
          mediaType: "video",
          url: text.substring(4).trim(),
          fileName: "",
          fileSize: 0,
        };
      }
      if (text.startsWith("[语音]")) {
        return {
          mediaType: "audio",
          url: text.substring(4).trim(),
          fileName: "语音",
          fileSize: 0,
        };
      }
      if (text.startsWith("[文件]")) {
        const rest = text.substring(4);
        const parts = rest.split("|");
        const rawName = parts[1] || "文件";
        // .dlp 后缀表示 XOR 加密文件，先判断再去掉后缀。
        const isXor = rawName.toLowerCase().endsWith(".dlp");
        const fname = _restoreBlockedExt(rawName);
        return {
          mediaType: "file",
          url: (parts[0] || "").trim(),
          fileName: fname,
          fileSize: parseInt(parts[2], 10) || 0,
          isXor: isXor,
        };
      }
      return null;
    }

    // ===== 图片预览：鼠标滚轮 / 双击缩放，拖拽平移，移动端双指缩放 =====
    const _imageLightboxState = {
      overlay: null,
      stage: null,
      img: null,
      scale: 1,
      minScale: 1,
      maxScale: 4,
      x: 0,
      y: 0,
      baseWidth: 0,
      baseHeight: 0,
      pointers: new Map(),
      dragPointerId: null,
      dragStartX: 0,
      dragStartY: 0,
      dragOriginX: 0,
      dragOriginY: 0,
      pinching: false,
      pinchStartDistance: 0,
      pinchStartScale: 1,
      pinchAnchorX: 0,
      pinchAnchorY: 0,
      moved: false,
    };

    const _videoLightboxState = {
      overlay: null,
      stage: null,
      video: null,
      pendingStartTime: 0,
    };

    function _clampPreview(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function _getImageStageCenter() {
      const s = _imageLightboxState;
      const rect = s.stage.getBoundingClientRect();
      return {
        rect,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }

    function _updateImageLightboxTransform() {
      const s = _imageLightboxState;
      if (!s.img) return;
      s.img.style.transform = `translate3d(-50%, -50%, 0) translate3d(${s.x}px, ${s.y}px, 0) scale(${s.scale})`;
    }

    function _clampImageLightboxPan() {
      const s = _imageLightboxState;
      if (!s.stage || !s.baseWidth || !s.baseHeight) return;
      const rect = s.stage.getBoundingClientRect();
      // 图片缩小时不允许被拖出视口；放大后允许平移到图片边缘。
      const maxX = Math.max(0, (s.baseWidth * s.scale - rect.width) / 2);
      const maxY = Math.max(0, (s.baseHeight * s.scale - rect.height) / 2);
      s.x = _clampPreview(s.x, -maxX, maxX);
      s.y = _clampPreview(s.y, -maxY, maxY);
    }

    function _imagePointAt(clientX, clientY) {
      const s = _imageLightboxState;
      const center = _getImageStageCenter();
      return {
        x: (clientX - center.x - s.x) / s.scale,
        y: (clientY - center.y - s.y) / s.scale,
      };
    }

    function _fitImageLightbox() {
      const s = _imageLightboxState;
      if (!s.img || !s.stage) return;
      const naturalWidth = s.img.naturalWidth || 0;
      const naturalHeight = s.img.naturalHeight || 0;
      if (!naturalWidth || !naturalHeight) return;

      const rect = s.stage.getBoundingClientRect();
      const availableWidth = Math.max(1, rect.width - 32);
      const availableHeight = Math.max(1, rect.height - 64);
      const fitScale = Math.min(
        1,
        availableWidth / naturalWidth,
        availableHeight / naturalHeight,
      );
      s.baseWidth = Math.max(1, Math.round(naturalWidth * fitScale));
      s.baseHeight = Math.max(1, Math.round(naturalHeight * fitScale));
      s.img.style.width = s.baseWidth + "px";
      s.img.style.height = s.baseHeight + "px";
      s.scale = s.minScale;
      s.x = 0;
      s.y = 0;
      s.moved = false;
      _updateImageLightboxTransform();
    }

    function _setImageLightboxScaleAt(clientX, clientY, nextScale) {
      const s = _imageLightboxState;
      if (!s.stage || !s.baseWidth) return;
      const imagePoint = _imagePointAt(clientX, clientY);
      s.scale = _clampPreview(nextScale, s.minScale, s.maxScale);
      const center = _getImageStageCenter();
      s.x = clientX - center.x - imagePoint.x * s.scale;
      s.y = clientY - center.y - imagePoint.y * s.scale;
      _clampImageLightboxPan();
      _updateImageLightboxTransform();
    }

    function _getPointerPair() {
      const s = _imageLightboxState;
      return Array.from(s.pointers.values()).slice(0, 2);
    }

    function _pointerDistance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function _pointerCenter(a, b) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function _beginImagePinch() {
      const s = _imageLightboxState;
      const pair = _getPointerPair();
      if (pair.length < 2) return;
      const center = _pointerCenter(pair[0], pair[1]);
      s.pinching = true;
      s.dragPointerId = null;
      s.pinchStartDistance = Math.max(1, _pointerDistance(pair[0], pair[1]));
      s.pinchStartScale = s.scale;
      const imagePoint = _imagePointAt(center.x, center.y);
      s.pinchAnchorX = imagePoint.x;
      s.pinchAnchorY = imagePoint.y;
    }

    function _onImagePointerDown(e) {
      const s = _imageLightboxState;
      if (!s.overlay || !s.overlay.classList.contains("open")) return;
      if (
        e.target &&
        e.target.closest &&
        e.target.closest(".chat-lightbox-close")
      )
        return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      s.pointers.set(e.pointerId, {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
      });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }

      if (s.pointers.size >= 2) {
        _beginImagePinch();
      } else {
        s.pinching = false;
        s.dragPointerId = e.pointerId;
        s.dragStartX = e.clientX;
        s.dragStartY = e.clientY;
        s.dragOriginX = s.x;
        s.dragOriginY = s.y;
        s.moved = false;
        if (s.img) s.img.classList.add("is-dragging");
      }
      e.preventDefault();
    }

    function _onImagePointerMove(e) {
      const s = _imageLightboxState;
      if (!s.pointers.has(e.pointerId)) return;
      s.pointers.set(e.pointerId, {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
      });

      if (s.pointers.size >= 2) {
        if (!s.pinching) _beginImagePinch();
        const pair = _getPointerPair();
        const center = _pointerCenter(pair[0], pair[1]);
        const distance = Math.max(1, _pointerDistance(pair[0], pair[1]));
        const nextScale = _clampPreview(
          (s.pinchStartScale * distance) / Math.max(1, s.pinchStartDistance),
          s.minScale,
          s.maxScale,
        );
        const stageCenter = _getImageStageCenter();
        s.scale = nextScale;
        s.x = center.x - stageCenter.x - s.pinchAnchorX * nextScale;
        s.y = center.y - stageCenter.y - s.pinchAnchorY * nextScale;
        s.moved = true;
        _clampImageLightboxPan();
        _updateImageLightboxTransform();
        e.preventDefault();
        return;
      }

      if (!s.pinching && s.dragPointerId === e.pointerId) {
        const dx = e.clientX - s.dragStartX;
        const dy = e.clientY - s.dragStartY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) s.moved = true;
        s.x = s.dragOriginX + dx;
        s.y = s.dragOriginY + dy;
        _clampImageLightboxPan();
        _updateImageLightboxTransform();
        if (s.moved) e.preventDefault();
      }
    }

    function _onImagePointerUp(e) {
      const s = _imageLightboxState;
      s.pointers.delete(e.pointerId);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }

      if (s.pointers.size >= 2) {
        _beginImagePinch();
      } else if (s.pinching) {
        s.pinching = false;
        const remaining = _getPointerPair()[0];
        if (remaining) {
          s.dragPointerId = remaining.id;
          s.dragStartX = remaining.x;
          s.dragStartY = remaining.y;
          s.dragOriginX = s.x;
          s.dragOriginY = s.y;
        } else {
          s.dragPointerId = null;
        }
      } else if (s.dragPointerId === e.pointerId) {
        s.dragPointerId = null;
      }
      if (!s.pointers.size && s.img) s.img.classList.remove("is-dragging");
    }

    function _closeImageLightbox() {
      const s = _imageLightboxState;
      if (!s.overlay) return;
      s.overlay.classList.remove("open");
      s.pointers.clear();
      s.dragPointerId = null;
      s.pinching = false;
      if (s.img) s.img.classList.remove("is-dragging");
    }

    function _ensureImageLightbox() {
      const s = _imageLightboxState;
      if (s.overlay) return s;
      const overlay = document.createElement("div");
      overlay.id = "chatImageLightbox";
      overlay.className = "chat-lightbox";
      overlay.innerHTML =
        '<div class="chat-lightbox-stage"><img class="chat-lightbox-img" alt="预览" draggable="false"></div><button type="button" class="chat-lightbox-close" aria-label="关闭">✕</button>';
      document.body.appendChild(overlay);
      s.overlay = overlay;
      s.stage = overlay.querySelector(".chat-lightbox-stage");
      s.img = overlay.querySelector(".chat-lightbox-img");
      const closeBtn = overlay.querySelector(".chat-lightbox-close");

      s.img.addEventListener("load", function () {
        if (s.overlay.classList.contains("open")) _fitImageLightbox();
      });
      s.stage.addEventListener(
        "wheel",
        function (e) {
          if (!s.overlay.classList.contains("open")) return;
          e.preventDefault();
          const factor = Math.exp(-e.deltaY * 0.0015);
          _setImageLightboxScaleAt(e.clientX, e.clientY, s.scale * factor);
        },
        { passive: false },
      );
      s.stage.addEventListener("pointerdown", _onImagePointerDown, {
        passive: false,
      });
      s.stage.addEventListener("pointermove", _onImagePointerMove, {
        passive: false,
      });
      s.stage.addEventListener("pointerup", _onImagePointerUp, {
        passive: true,
      });
      s.stage.addEventListener("pointercancel", _onImagePointerUp, {
        passive: true,
      });
      s.stage.addEventListener("lostpointercapture", function (e) {
        if (s.pointers.has(e.pointerId)) _onImagePointerUp(e);
      });
      s.stage.addEventListener("dblclick", function (e) {
        if (e.target !== s.img) return;
        e.preventDefault();
        const next = s.scale > s.minScale + 0.05 ? s.minScale : 2;
        _setImageLightboxScaleAt(e.clientX, e.clientY, next);
      });
      s.stage.addEventListener("click", function () {
        // 预览只能通过右上角 ✕ 关闭；点击图片外区域不关闭。
        s.moved = false;
      });
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        _closeImageLightbox();
      });
      return s;
    }

    function openImageLightbox(url) {
      if (!url) return;
      const s = _ensureImageLightbox();
      s.overlay.classList.add("open");
      s.pointers.clear();
      s.dragPointerId = null;
      s.pinching = false;
      s.scale = s.minScale;
      s.x = 0;
      s.y = 0;
      s.moved = false;
      s.img.style.width = "";
      s.img.style.height = "";
      if (s.img.getAttribute("src") !== url) s.img.src = url;
      if (s.img.complete && s.img.naturalWidth) _fitImageLightbox();
    }

    function _videoControlsHTML() {
      return (
        '<button type="button" class="chat-video-control-btn chat-video-play-toggle" aria-label="播放或暂停">▶</button>' +
        '<span class="chat-video-time chat-video-current">0:00</span>' +
        '<input class="chat-video-progress" type="range" min="0" max="100" value="0" step="0.1" aria-label="视频进度">' +
        '<span class="chat-video-time chat-video-duration">0:00</span>' +
        '<button type="button" class="chat-video-control-btn chat-video-mute-toggle" aria-label="静音">🔊</button>' +
        '<button type="button" class="chat-video-control-btn chat-video-fullscreen-toggle" aria-label="全屏播放">⛶</button>'
      );
    }

    function _applyVideoRotation() {
      const s = _videoLightboxState;
      if (!s.video) return;
      const player = s.video.closest(".chat-video-lightbox-player");
      if (!player) return;
      if (s.rotation === 90) {
        player.classList.add("is-rotated");
      } else {
        player.classList.remove("is-rotated");
      }
    }

    function _closeVideoLightbox() {
      const s = _videoLightboxState;
      if (!s.overlay) return;
      s.overlay.classList.remove("open");
      s.rotation = 0;
      const player = s.video
        ? s.video.closest(".chat-video-lightbox-player")
        : null;
      if (player) {
        player.classList.remove("is-rotated");
      }
      if (s.video) {
        s.video.pause();
        s.video.onloadedmetadata = null;
        s.video.removeAttribute("src");
        s.video.load();
      }
    }

    function _ensureVideoLightbox() {
      const s = _videoLightboxState;
      if (s.overlay) return s;
      const overlay = document.createElement("div");
      overlay.id = "chatVideoLightbox";
      overlay.className = "chat-video-lightbox";
      overlay.innerHTML =
        '<div class="chat-video-lightbox-stage">' +
        '<div class="chat-video-player chat-video-lightbox-player">' +
        '<video class="chat-lightbox-video" playsinline="true" webkit-playsinline="true" preload="metadata"></video>' +
        '<button type="button" class="chat-video-center-play" aria-label="播放视频">▶</button>' +
        '<button type="button" class="chat-video-rotate-btn" title="旋转并全屏拉伸">🔄</button>' +
        '<div class="chat-video-controls">' +
        _videoControlsHTML() +
        "</div>" +
        "</div>" +
        "</div>" +
        '<button type="button" class="chat-lightbox-close chat-video-lightbox-close" aria-label="关闭">✕</button>';
      document.body.appendChild(overlay);
      s.overlay = overlay;
      s.stage = overlay.querySelector(".chat-video-lightbox-stage");
      s.video = overlay.querySelector(".chat-lightbox-video");
      const closeBtn = overlay.querySelector(".chat-video-lightbox-close");
      const rotateBtn = overlay.querySelector(".chat-video-rotate-btn");

      s.video.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
      closeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        _closeVideoLightbox();
      });
      if (rotateBtn) {
        rotateBtn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          // 来回切换 0° 与 90°，不进行 360° 繁复循环
          s.rotation = s.rotation === 90 ? 0 : 90;
          _applyVideoRotation();
        });
      }
      return s;
    }

    function openVideoLightbox(url, startTime) {
      if (!url) return;
      const s = _ensureVideoLightbox();
      s.pendingStartTime = Number.isFinite(Number(startTime))
        ? Math.max(0, Number(startTime))
        : 0;
      s.overlay.classList.add("open");
      s.video.onloadedmetadata = function () {
        if (s.pendingStartTime > 0 && isFinite(s.video.duration)) {
          s.video.currentTime = Math.min(
            s.pendingStartTime,
            Math.max(0, s.video.duration - 0.05),
          );
        }
        _syncCustomVideoUI(s.video);
        const playPromise = s.video.play();
        if (playPromise && typeof playPromise.catch === "function")
          playPromise.catch(() => {});
      };
      s.video.src = url;
      s.video.load();
      _syncCustomVideoUI(s.video);
      const immediatePlay = s.video.play();
      if (immediatePlay && typeof immediatePlay.catch === "function")
        immediatePlay.catch(() => {});
    }

    document.addEventListener("keydown", function (e) {
      const imageOpen =
        _imageLightboxState.overlay &&
        _imageLightboxState.overlay.classList.contains("open");
      const videoOpen =
        _videoLightboxState.overlay &&
        _videoLightboxState.overlay.classList.contains("open");
      if (e.key === "Escape") {
        if (imageOpen) _closeImageLightbox();
        if (videoOpen) _closeVideoLightbox();
        return;
      }
      if (
        imageOpen &&
        (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")
      ) {
        e.preventDefault();
        const center = _getImageStageCenter();
        if (e.key === "0") _setImageLightboxScaleAt(center.x, center.y, 1);
        else
          _setImageLightboxScaleAt(
            center.x,
            center.y,
            _imageLightboxState.scale * (e.key === "-" ? 0.8 : 1.25),
          );
      }
    });

    window.addEventListener("resize", function () {
      if (
        _imageLightboxState.overlay &&
        _imageLightboxState.overlay.classList.contains("open")
      ) {
        _fitImageLightbox();
      }
    });

    // ---- 渲染消息内容：图片缩略图 / 视频播放器 / 语音控件 / 文件下载 ----
    function renderMessageContent(msg) {
      const mediaType =
        msg.mediaType ||
        (msg.isImage
          ? String(msg.text || "").startsWith("[视频]")
            ? "video"
            : "image"
          : "");
      let info = null;
      if (mediaType || msg.url) {
        info = {
          mediaType: mediaType || "file",
          url: msg.url || "",
          fileName: msg.fileName || "",
          fileSize: msg.fileSize || 0,
          mimeType: msg.mimeType || "",
          isXor: !!msg.isXor,
        };
      }
      if (!info || !info.url) {
        info = parseMediaFromText(msg.text);
      }
      if (info && info.url) {
        const url = info.url;
        const type = info.mediaType;
        if (type === "image") {
          return `<span class="chat-image-wrap"><img class="chat-media-img" src="${esc(url)}" alt="图片" loading="lazy" draggable="false" data-full="${esc(url)}" title="点击放大"></span>`;
        }
        if (type === "video") {
          return `<div class="chat-video-wrap chat-video-player"><video class="chat-media-video" src="${esc(url)}" playsinline="true" webkit-playsinline="true" x5-playsinline="true" preload="metadata" title="点击播放"></video><button type="button" class="chat-video-center-play" aria-label="播放视频">▶</button><div class="chat-video-controls">${_videoControlsHTML()}</div></div>`;
        }
        if (type === "audio") {
          return `<div class="chat-media-audio">
          <audio class="chat-media-audio-el" src="${esc(url)}" preload="metadata"></audio>
          <div class="audio-player-ui">
            <button class="audio-play-btn" type="button" title="播放">▶</button>
            <div class="audio-progress-bar"><div class="audio-progress-fill"></div></div>
            <span class="audio-time-display">--:--</span>
          </div>
        </div>`;
        }
        // file
        const name = info.fileName || "文件";
        const sizeStr = info.fileSize ? formatFileSize(info.fileSize) : "";
        const isXorFile =
          type === "file" &&
          (info.isXor || (url && url.toLowerCase().endsWith(".dlp")));
        const fileLinkAttrs = isXorFile
          ? `data-xor-url="${esc(url)}" data-xor-name="${esc(name)}" data-xor-mime="${esc(info.mimeType || "")}"`
          : `href="${esc(url)}" target="_blank" rel="noopener noreferrer" download="${esc(name)}"`;
        return `<a class="chat-media-file" ${fileLinkAttrs}>
        <span class="chat-media-file-icon">📎</span>
        <span class="chat-media-file-meta">
          <span class="chat-media-file-name">${esc(name)}</span>
          <span class="chat-media-file-size">${esc(sizeStr || "点击下载")}</span>
        </span>
      </a>`;
      }
      return linkifyText(msg.text);
    }

    // ===== 长按消息：撤回/删除菜单 =====
    // ===== 已撤回/删除的消息 ID 集合（防止历史消息重放后复活） =====
    const _deletedMsgIds = new Set();
    const DELETED_MSG_STORAGE_KEY = "lanplay_deleted_msg_ids";
    function loadDeletedMsgIds() {
      try {
        const raw = localStorage.getItem(DELETED_MSG_STORAGE_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) arr.forEach((id) => _deletedMsgIds.add(id));
        }
      } catch (e) {}
      if (_deletedMsgIds.size > 500) {
        const entries = [..._deletedMsgIds];
        entries
          .slice(0, entries.length - 500)
          .forEach((id) => _deletedMsgIds.delete(id));
      }
    }
    function saveDeletedMsgIds() {
      try {
        localStorage.setItem(
          DELETED_MSG_STORAGE_KEY,
          JSON.stringify([..._deletedMsgIds]),
        );
      } catch (e) {}
    }
    function markMsgDeleted(id) {
      _deletedMsgIds.add(id);
      saveDeletedMsgIds();
    }
    loadDeletedMsgIds();

    // ===== 长按消息：撤回/删除菜单 =====
    // 用 flag 标记正在长按气泡，在 dragstart 里阻止拖动
    let pressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let longPressingMsg = false;
    let _suppressMessageClickUntil = 0;
    let _suppressMessageClickRow = null;
    // 长按气泡时临时移除父卡片 draggable，防止浏览器在 500ms 前抢先启动拖拽幽灵
    let touchedDraggableEl = null;

    function disableCardDragForLongPress(row) {
      const group = row.closest('.server-group[draggable="true"]');
      if (group) {
        touchedDraggableEl = group;
        group.removeAttribute("draggable");
      }
    }
    function restoreCardDrag() {
      if (touchedDraggableEl) {
        if (touchedDraggableEl.parentElement) {
          touchedDraggableEl.setAttribute("draggable", "true");
        }
        touchedDraggableEl = null;
      }
    }

    // 视频消息：整条气泡都可长按呼出撤回/删除（与文字/图片消息一致），
    // 只排除真正需要自身交互的控件：
    //  ① 底部控制条 .chat-video-controls（进度条/播放/静音/全屏按钮）；
    //  ② “下载视频”链接（抬手会触发下载）。
    // 视频画面、中央播放键、发送人名、时间行等区域均允许长按。
    function _interactiveAreaAt(row, el) {
      if (!el || !el.closest) return null;
      const controls = el.closest(".chat-video-controls");
      if (controls) return controls;
      if (
        row.querySelector(".chat-media-video") &&
        el.closest(".chat-media-download")
      )
        return el.closest(".chat-media-download");
      return null;
    }
    function _allowMsgLongPressAt(row, x, y, target) {
      if (!row) return false;
      // 同时用 elementFromPoint 的实际命中元素和事件原始 target 判断，
      // 避免 WebView 在视频表面命中异常时误放行/误拦截。
      const pointEl = document.elementFromPoint(x, y);
      if (_interactiveAreaAt(row, pointEl) || _interactiveAreaAt(row, target))
        return false;
      return true;
    }

    function _markMessageClickSuppressed(row) {
      _suppressMessageClickRow = row;
      _suppressMessageClickUntil = Date.now() + 900;
    }
    function _consumeSuppressedMessageClick(target) {
      if (
        !_suppressMessageClickRow ||
        Date.now() > _suppressMessageClickUntil
      ) {
        _suppressMessageClickRow = null;
        _suppressMessageClickUntil = 0;
        return false;
      }
      const row = target && target.closest ? target.closest(".chat-msg") : null;
      if (row !== _suppressMessageClickRow) return false;
      _suppressMessageClickRow = null;
      _suppressMessageClickUntil = 0;
      return true;
    }

    function startMsgLongPress(row, x, y) {
      cancelMsgLongPress();
      longPressingMsg = true;
      pressStartX = x;
      pressStartY = y;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        const id = row.dataset.msgId;
        if (!id) return;
        _markMessageClickSuppressed(row);
        const isMine = row.classList.contains("chat-msg-mine");
        showMsgActionMenu(id, isMine, row);
      }, 500);
    }
    function cancelMsgLongPress() {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      longPressingMsg = false;
    }

    // pointer 事件（桌面）
    document.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(".chat-msg");
      if (!row) return;
      if (!_allowMsgLongPressAt(row, e.clientX, e.clientY, e.target)) return;
      disableCardDragForLongPress(row);
      startMsgLongPress(row, e.clientX, e.clientY);
    });
    document.addEventListener(
      "pointermove",
      (e) => {
        if (!pressTimer) return;
        const dx = e.clientX - pressStartX;
        const dy = e.clientY - pressStartY;
        if (dx * dx + dy * dy > 100) {
          cancelMsgLongPress();
          restoreCardDrag();
        }
      },
      { passive: true },
    );
    ["pointerup", "pointercancel"].forEach((ev) =>
      document.addEventListener(
        ev,
        () => {
          cancelMsgLongPress();
          if (!document.getElementById("msgActionMenu")) restoreCardDrag();
        },
        { passive: true },
      ),
    );

    // touch 事件（移动端更可靠，穿透 video/audio 控件）
    let touchPressRow = null;
    document.addEventListener(
      "touchstart",
      (e) => {
        const touch = e.touches[0];
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        const row = el && el.closest(".chat-msg");
        if (
          !row ||
          !_allowMsgLongPressAt(row, touch.clientX, touch.clientY, el)
        )
          return;
        touchPressRow = row;
        // 临时移除父卡片 draggable，阻止浏览器启动拖拽幽灵
        disableCardDragForLongPress(row);
        startMsgLongPress(row, touch.clientX, touch.clientY);
      },
      { passive: true },
    );
    document.addEventListener(
      "touchmove",
      (e) => {
        if (!pressTimer) return;
        const touch = e.touches[0];
        const dx = touch.clientX - pressStartX;
        const dy = touch.clientY - pressStartY;
        if (dx * dx + dy * dy > 100) {
          cancelMsgLongPress();
          restoreCardDrag();
        }
      },
      { passive: true },
    );
    document.addEventListener(
      "touchend",
      () => {
        cancelMsgLongPress();
        touchPressRow = null;
        // 菜单打开时不恢复 draggable，等菜单关闭时再恢复
        if (!document.getElementById("msgActionMenu")) restoreCardDrag();
      },
      { passive: true },
    );
    document.addEventListener(
      "touchcancel",
      () => {
        cancelMsgLongPress();
        touchPressRow = null;
        restoreCardDrag();
      },
      { passive: true },
    );

    // 仅在长按气泡或菜单打开时阻止卡片拖动（不再阻止聊天区域的正常拖动）
    document.addEventListener("dragstart", function (e) {
      const menuOpen = document.getElementById("msgActionMenu");
      if (longPressingMsg || menuOpen) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // 消息操作菜单（撤回 / 删除）
    function showMsgActionMenu(msgId, isMine, rowEl) {
      // 移除旧菜单
      const old = document.getElementById("msgActionMenu");
      if (old) {
        if (typeof old._close === "function") old._close();
        else old.remove();
      }

      const menu = document.createElement("div");
      menu.id = "msgActionMenu";
      menu.className = "msg-action-menu";
      menu.innerHTML = `
      <div class="msg-action-mask"></div>
      <div class="msg-action-sheet">
        ${isMine ? '<button class="msg-action-btn recall" type="button">撤回消息</button>' : ""}
        <button class="msg-action-btn delete" type="button">删除消息</button>
        <button class="msg-action-btn cancel" type="button">取消</button>
      </div>
    `;
      document.body.appendChild(menu);
      requestAnimationFrame(() => menu.classList.add("open"));

      let menuClosed = false;
      function close() {
        if (menuClosed) return;
        menuClosed = true;
        // 立即重置长按状态，恢复卡片可拖动并彻底移除遮罩。
        longPressingMsg = false;
        restoreCardDrag();
        if (menu.parentElement) menu.remove();
      }
      menu._close = close;

      menu.querySelector(".cancel").addEventListener("click", close);

      menu.querySelector(".delete").addEventListener("click", () => {
        close();
        adjustUnreadForRemovedMessage(msgId);
        markMsgDeleted(msgId);
        Object.keys(state.chatMessages).forEach((k) => {
          state.chatMessages[k] = (state.chatMessages[k] || []).filter(
            (m) => m.id !== msgId,
          );
        });
        state.publicMessages = (state.publicMessages || []).filter(
          (m) => m.id !== msgId,
        );
        saveChatMessages();
        savePublicMessages();
        // Telegram 行结构：删整行（含头像），避免头像残留
        const delWrap =
          (rowEl && (rowEl.closest(".chat-msg-row") || rowEl)) || null;
        if (delWrap && delWrap.parentElement) delWrap.remove();
        else {
          state.servers.forEach((s) => renderChatMessages(s.id, false));
          renderPublicChat(false);
        }
      });

      if (isMine) {
        menu.querySelector(".recall").addEventListener("click", () => {
          close();
          markMsgDeleted(msgId);
          Object.keys(state.chatMessages).forEach((k) => {
            state.chatMessages[k] = (state.chatMessages[k] || []).filter(
              (m) => m.id !== msgId,
            );
          });
          state.publicMessages = (state.publicMessages || []).filter(
            (m) => m.id !== msgId,
          );
          const group = rowEl && rowEl.closest(".server-group");
          const channel = group
            ? CHAT_PREFIX + group.dataset.id
            : PUBLIC_CHANNEL;
          if (goEasy && state.goEasyReady)
            goEasy.pubsub.publish({
              channel,
              message: JSON.stringify({
                type: "delete",
                id: msgId,
                senderId: state.userId,
              }),
              qos: 1,
            });
          saveChatMessages();
          savePublicMessages();
          const recallWrap =
            (rowEl && (rowEl.closest(".chat-msg-row") || rowEl)) || null;
          if (recallWrap && recallWrap.parentElement) recallWrap.remove();
          else {
            state.servers.forEach((s) => renderChatMessages(s.id, false));
            renderPublicChat(false);
          }
        });
      }
    }

    // 委托：XOR 加密文件点击 → 解密下载
    document.addEventListener("click", function (e) {
      const xorEl = e.target.closest("[data-xor-url]");
      if (xorEl) {
        e.preventDefault();
        e.stopPropagation();
        _xorDecryptAndDownload(
          xorEl.dataset.xorUrl,
          xorEl.dataset.xorName,
          xorEl.dataset.xorMime,
        );
      }
    });

    // 所有带 download 属性的聊天附件都走统一入口：公网用浏览器下载，局域网用内置下载器。
    // 注意：必须先 e.preventDefault() 再做 URL 校验，
    // 否则 WebView 看到非 https:// 的链接(比如只有域名的 "your-cdn.example.com")
    // 会自动用 Intent.parseUri 包装成 intent://your-cdn.example.com#Intent;scheme=https;... 的形式
    // 然后在系统层弹"无法打开 ERR_UNKNOWN_URL_SCHEDULE"错误。
    document.addEventListener("click", function (e) {
      const link = e.target.closest("a[download]");
      if (!link) return;
      // _browserDownload 创建的最终同源链接必须交给浏览器本身，不能再次进入统一下载入口。
      if (link.dataset.browserDownloadDirect === "true") return;
      // ① 先无条件拦截默认行为，杜绝 WebView 自己用 intent:// 跳系统浏览器
      e.preventDefault();
      e.stopPropagation();
      const rawUrl = link.getAttribute("href") || "";
      if (!rawUrl || rawUrl.startsWith("blob:") || rawUrl.startsWith("data:"))
        return;
      // ② 协议白名单：只允许 http/https，其他全部拒绝
      if (!/^https?:\/\//i.test(rawUrl)) {
        try {
          const u = new URL(rawUrl, window.location.href);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            console.warn("[下载] 非 http(s) 协议，拒绝:", rawUrl);
            if (typeof showToast === "function") {
              showToast(
                "❌ 不支持下载该链接(" + u.protocol.replace(":", "") + ")",
                2500,
                false,
              );
            }
            return;
          }
        } catch (e2) {
          console.warn("[下载] URL 解析失败:", rawUrl, e2);
          return;
        }
      }
      let downloadUrl = rawUrl;
      try {
        downloadUrl = new URL(rawUrl, window.location.href).href;
      } catch (_) {
        /* 使用原始地址 */
      }
      const mediaName = link.querySelector(".chat-media-file-name");
      const fileName =
        link.getAttribute("download") ||
        (mediaName && mediaName.textContent.trim()) ||
        "";
      _builtInDownload(downloadUrl, fileName, false);
    });

    // 委托：聊天图片/头像点击放大（支持拖动、滚轮/双指缩放）
    document.addEventListener("click", function (e) {
      const avatarImg = e.target.closest(".chat-msg-avatar");
      if (avatarImg && avatarImg.dataset.full) {
        e.preventDefault();
        e.stopPropagation();
        openImageLightbox(avatarImg.dataset.full);
        return;
      }
      const img = e.target.closest(".chat-media-img");
      if (img && img.dataset.full) {
        e.preventDefault();
        if (_consumeSuppressedMessageClick(img)) {
          e.stopImmediatePropagation();
          return;
        }
        e.stopPropagation();
        openImageLightbox(img.dataset.full);
      }
    });

    function _videoPlayerFor(video) {
      return video && video.closest
        ? video.closest(".chat-video-player")
        : null;
    }

    function _formatVideoTime(seconds) {
      if (!isFinite(seconds) || seconds < 0) return "0:00";
      const total = Math.floor(seconds);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      if (hours > 0)
        return (
          hours +
          ":" +
          String(minutes).padStart(2, "0") +
          ":" +
          String(secs).padStart(2, "0")
        );
      return minutes + ":" + String(secs).padStart(2, "0");
    }

    function _syncCustomVideoUI(video) {
      const player = _videoPlayerFor(video);
      if (!player || !video) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        player.classList.toggle(
          "is-portrait",
          video.videoHeight > video.videoWidth,
        );
      }
      const duration = Number(video.duration);
      const current = Number(video.currentTime) || 0;
      const progress = player.querySelector(".chat-video-progress");
      const currentEl = player.querySelector(".chat-video-current");
      const durationEl = player.querySelector(".chat-video-duration");
      const playBtn = player.querySelector(".chat-video-play-toggle");
      const centerBtn = player.querySelector(".chat-video-center-play");
      const muteBtn = player.querySelector(".chat-video-mute-toggle");

      if (currentEl) currentEl.textContent = _formatVideoTime(current);
      if (durationEl) durationEl.textContent = _formatVideoTime(duration);
      if (progress) {
        const max = isFinite(duration) && duration > 0 ? duration : 100;
        const value =
          isFinite(duration) && duration > 0 ? Math.min(current, duration) : 0;
        const percent = max > 0 ? (value / max) * 100 : 0;
        progress.max = String(max);
        progress.value = String(value);
        progress.style.setProperty("--video-progress", percent + "%");
      }
      if (playBtn) {
        playBtn.textContent = video.paused || video.ended ? "▶" : "❚❚";
        playBtn.title = video.paused || video.ended ? "播放" : "暂停";
      }
      if (centerBtn) {
        centerBtn.classList.toggle("is-hidden", !video.paused && !video.ended);
      }
      if (muteBtn) {
        muteBtn.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
        muteBtn.title = video.muted || video.volume === 0 ? "取消静音" : "静音";
      }
    }

    function _playCustomVideo(video) {
      if (!video) return;
      const promise = video.play();
      if (promise && typeof promise.catch === "function")
        promise.catch(() => {});
    }

    // 自定义播放器按钮：播放/暂停、静音、进度和页面内全屏。
    document.addEventListener("click", function (e) {
      const control =
        e.target && e.target.closest
          ? e.target.closest(
              ".chat-video-play-toggle, .chat-video-center-play, .chat-video-mute-toggle, .chat-video-fullscreen-toggle",
            )
          : null;
      if (control) {
        const player = control.closest(".chat-video-player");
        const video = player && player.querySelector("video");
        if (!video) return;
        e.preventDefault();
        e.stopPropagation();
        // 长按呼出菜单后的抬手点击不再触发播放/暂停/全屏等动作
        if (_consumeSuppressedMessageClick(control)) {
          e.stopImmediatePropagation();
          return;
        }
        if (control.classList.contains("chat-video-fullscreen-toggle")) {
          // 只打开网页内播放器，不调用 Android 原生全屏接口。
          if (!player.closest("#chatVideoLightbox")) {
            openVideoLightbox(
              video.currentSrc || video.src,
              video.currentTime || 0,
            );
          }
          return;
        }
        if (control.classList.contains("chat-video-mute-toggle")) {
          video.muted = !video.muted;
          _syncCustomVideoUI(video);
          return;
        }
        if (video.paused || video.ended) _playCustomVideo(video);
        else video.pause();
        return;
      }

      const video =
        e.target && e.target.closest
          ? e.target.closest(".chat-media-video, .chat-lightbox-video")
          : null;
      if (video && _videoPlayerFor(video)) {
        e.preventDefault();
        if (_consumeSuppressedMessageClick(video)) {
          e.stopImmediatePropagation();
          return;
        }
        if (Date.now() < _suppressCustomVideoClickUntil) {
          e.stopPropagation();
          return;
        }
        if (video.paused || video.ended) _playCustomVideo(video);
        else video.pause();
      }
    });

    // 全屏播放器内左右滑动视频画面调节进度，控制栏/按钮区域不参与滑动。
    let _videoSeekGesture = null;
    let _suppressCustomVideoClickUntil = 0;
    function _startVideoSeekGesture(e) {
      const player =
        e.target && e.target.closest
          ? e.target.closest("#chatVideoLightbox .chat-video-player")
          : null;
      if (
        !player ||
        e.target.closest(".chat-video-controls") ||
        e.target.closest("button, input")
      )
        return;
      const video = player.querySelector("video");
      if (!video) return;
      _videoSeekGesture = {
        pointerId: e.pointerId,
        player,
        video,
        startX: e.clientX,
        startY: e.clientY,
        startTime: Number(video.currentTime) || 0,
        moved: false,
      };
    }
    function _moveVideoSeekGesture(e) {
      const g = _videoSeekGesture;
      if (!g || g.pointerId !== e.pointerId) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      const duration = Number(g.video.duration);
      if (!isFinite(duration) || duration <= 0) return;
      g.moved = true;
      const width = Math.max(1, g.player.clientWidth);
      const nextTime = Math.max(
        0,
        Math.min(duration, g.startTime + (dx / width) * duration),
      );
      g.video.currentTime = nextTime;
      _syncCustomVideoUI(g.video);
      _suppressCustomVideoClickUntil = Date.now() + 350;
      e.preventDefault();
    }
    function _endVideoSeekGesture(e) {
      if (!_videoSeekGesture || _videoSeekGesture.pointerId !== e.pointerId)
        return;
      if (_videoSeekGesture.moved)
        _suppressCustomVideoClickUntil = Date.now() + 350;
      _videoSeekGesture = null;
    }
    document.addEventListener("pointerdown", _startVideoSeekGesture, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointermove", _moveVideoSeekGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", _endVideoSeekGesture, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointercancel", _endVideoSeekGesture, {
      capture: true,
      passive: true,
    });
    // 兼容不支持 PointerEvent 的旧 Android WebView。
    if (!window.PointerEvent) {
      document.addEventListener(
        "touchstart",
        function (e) {
          if (!e.touches || e.touches.length !== 1) return;
          const t = e.touches[0];
          _startVideoSeekGesture({
            target: e.target,
            pointerId: "touch",
            clientX: t.clientX,
            clientY: t.clientY,
          });
        },
        { capture: true, passive: true },
      );
      document.addEventListener(
        "touchmove",
        function (e) {
          if (!e.touches || e.touches.length !== 1) return;
          const t = e.touches[0];
          _moveVideoSeekGesture({
            target: e.target,
            pointerId: "touch",
            clientX: t.clientX,
            clientY: t.clientY,
            preventDefault: () => e.preventDefault(),
          });
        },
        { capture: true, passive: false },
      );
      document.addEventListener(
        "touchend",
        function () {
          _endVideoSeekGesture({ pointerId: "touch" });
        },
        { capture: true, passive: true },
      );
      document.addEventListener(
        "touchcancel",
        function () {
          _endVideoSeekGesture({ pointerId: "touch" });
        },
        { capture: true, passive: true },
      );
    }

    document.addEventListener("input", function (e) {
      const progress =
        e.target && e.target.closest
          ? e.target.closest(".chat-video-progress")
          : null;
      if (!progress) return;
      const player = progress.closest(".chat-video-player");
      const video = player && player.querySelector("video");
      if (!video || !isFinite(Number(progress.value))) return;
      video.currentTime = Number(progress.value);
      _syncCustomVideoUI(video);
    });

    [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "progress",
      "volumechange",
      "play",
      "pause",
      "ended",
    ].forEach(function (eventName) {
      document.addEventListener(
        eventName,
        function (e) {
          if (e.target && e.target.tagName === "VIDEO")
            _syncCustomVideoUI(e.target);
        },
        true,
      );
    });

    // 播放当前视频时，自动暂停页面中其它正在播放的视频。
    document.addEventListener(
      "play",
      function (e) {
        const currentVideo = e.target;
        if (!currentVideo || currentVideo.tagName !== "VIDEO") return;
        document.querySelectorAll("video").forEach(function (video) {
          if (video !== currentVideo && !video.paused) {
            try {
              video.pause();
            } catch (_) {
              /* ignore */
            }
          }
        });
        _syncCustomVideoUI(currentVideo);
      },
      true,
    );

    function formatAudioDuration(seconds) {
      if (!isFinite(seconds) || seconds < 0) return "--:--";
      const total = Math.round(seconds);
      const min = Math.floor(total / 60);
      const sec = total % 60;
      return String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    }
    // ===== 自定义音频播放器：事件委托 =====
    // 未播放时显示总时长，播放时从 0 开始计时
    // 用 requestAnimationFrame 保证进度条与时间完全同步流畅
    function _audioWrap(e) {
      const audio = e.target;
      if (
        !audio ||
        !audio.classList ||
        !audio.classList.contains("chat-media-audio-el")
      )
        return null;
      return audio.closest(".chat-media-audio");
    }
    function _audioSyncUI(audio, w) {
      const td = w.querySelector(".audio-time-display");
      const pf = w.querySelector(".audio-progress-fill");
      if (td) td.textContent = formatAudioDuration(audio.currentTime);
      if (pf && audio.duration && isFinite(audio.duration)) {
        pf.style.width = (audio.currentTime / audio.duration) * 100 + "%";
      }
    }
    // rAF 循环：播放期间每帧同步刷新进度条 + 时间
    const _audioRaf = new WeakMap();
    function _startAudioRaf(audio, w) {
      if (_audioRaf.has(audio)) return;
      function tick() {
        _audioSyncUI(audio, w);
        _audioRaf.set(audio, requestAnimationFrame(tick));
      }
      _audioRaf.set(audio, requestAnimationFrame(tick));
    }
    function _stopAudioRaf(audio, w) {
      const id = _audioRaf.get(audio);
      if (id) {
        cancelAnimationFrame(id);
        _audioRaf.delete(audio);
      }
      // 停止后立刻刷一次，确保停在准确位置
      _audioSyncUI(audio, w);
    }

    document.addEventListener(
      "loadedmetadata",
      function (e) {
        const w = _audioWrap(e);
        if (!w) return;
        const audio = e.target;
        const td = w.querySelector(".audio-time-display");
        if (td && audio.duration && isFinite(audio.duration))
          td.textContent = formatAudioDuration(audio.duration);
      },
      true,
    );
    document.addEventListener(
      "canplay",
      function (e) {
        const w = _audioWrap(e);
        if (!w) return;
        const audio = e.target;
        const td = w.querySelector(".audio-time-display");
        if (
          td &&
          audio.duration &&
          isFinite(audio.duration) &&
          audio.paused &&
          audio.currentTime === 0
        ) {
          td.textContent = formatAudioDuration(audio.duration);
        }
      },
      true,
    );
    document.addEventListener(
      "durationchange",
      function (e) {
        const w = _audioWrap(e);
        if (!w) return;
        const audio = e.target;
        const td = w.querySelector(".audio-time-display");
        if (
          td &&
          audio.duration &&
          isFinite(audio.duration) &&
          audio.paused &&
          audio.currentTime === 0
        ) {
          td.textContent = formatAudioDuration(audio.duration);
        }
      },
      true,
    );
    document.addEventListener(
      "play",
      function (e) {
        const w = _audioWrap(e);
        if (!w) return;
        const audio = e.target;
        const btn = w.querySelector(".audio-play-btn");
        if (btn) {
          btn.textContent = "⏸";
          btn.title = "暂停";
        }
        _startAudioRaf(audio, w);
      },
      true,
    );
    document.addEventListener(
      "pause",
      function (e) {
        const w = _audioWrap(e);
        if (!w) return;
        const audio = e.target;
        const btn = w.querySelector(".audio-play-btn");
        if (btn) {
          btn.textContent = "▶";
          btn.title = "播放";
        }
        _stopAudioRaf(audio, w);
      },
      true,
    );
    document.addEventListener(
      "ended",
      function (e) {
        const w = _audioWrap(e);
        if (!w) return;
        const audio = e.target;
        const btn = w.querySelector(".audio-play-btn");
        const td = w.querySelector(".audio-time-display");
        const pf = w.querySelector(".audio-progress-fill");
        if (btn) {
          btn.textContent = "▶";
          btn.title = "播放";
        }
        _stopAudioRaf(audio, w);
        try {
          audio.currentTime = 0;
        } catch (_) {}
        if (td && audio.duration && isFinite(audio.duration))
          td.textContent = formatAudioDuration(audio.duration);
        if (pf) pf.style.width = "0%";
      },
      true,
    );
    // 播放/暂停按钮 + 进度条点击跳转
    document.addEventListener("click", function (e) {
      const playBtn = e.target.closest(".audio-play-btn");
      if (playBtn) {
        e.stopPropagation();
        const w = playBtn.closest(".chat-media-audio");
        const audio = w && w.querySelector(".chat-media-audio-el");
        if (!audio) return;
        if (audio.paused) {
          audio.play().catch(() => {});
        } else {
          audio.pause();
        }
        return;
      }
      const bar = e.target.closest(".audio-progress-bar");
      if (bar) {
        e.stopPropagation();
        const w = bar.closest(".chat-media-audio");
        const audio = w && w.querySelector(".chat-media-audio-el");
        if (!audio || !audio.duration || !isFinite(audio.duration)) return;
        const rect = bar.getBoundingClientRect();
        const pct = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width),
        );
        audio.currentTime = pct * audio.duration;
        // 跳转后立刻同步 UI（暂停时 rAF 不跑，需要手动刷一次）
        _audioSyncUI(audio, w);
      }
    });

    // ---- 初始化 GoEasy ----
    let _goEasyInitInFlight = false;
    let _goEasyMissingConfigToastShown = false;

    function getGoEasyAppkey() {
      return state.goEasyConfig && state.goEasyConfig.appkey
        ? String(state.goEasyConfig.appkey).trim()
        : "";
    }
    function getGoEasyHost() {
      return state.goEasyConfig && state.goEasyConfig.host
        ? String(state.goEasyConfig.host).trim()
        : "";
    }

    function initGoEasy(retryCount) {
      if (retryCount === undefined) retryCount = 0;
      // 未配置资料时保持游客浏览状态：初始化/重连不得主动弹出首次设置窗口。
      // 首次设置只允许由公共聊天、在线成员或服务器聊天输入框触发。
      if (!state.username && !getStoredUsername()) {
        _goEasyInitInFlight = false;
        updateChatUI();
        return;
      }
      // 防止首次设置回调与定时器重复初始化互相踩踏
      if (_goEasyInitInFlight && retryCount === 0) return;
      if (typeof GoEasy === "undefined") {
        if (retryCount < 3) {
          console.warn(`GoEasy SDK 未加载，${retryCount + 1}秒后重试...`);
          setTimeout(() => initGoEasy(retryCount + 1), 2000);
        } else {
          console.error("GoEasy SDK 加载失败，聊天功能不可用");
          state.goEasyReady = false;
          document
            .querySelectorAll(".server-group .chat-wrapper .chat-messages")
            .forEach((el) => {
              el.innerHTML =
                '<div style="color:var(--red);text-align:center;padding:8px;">⚠️ 聊天服务未连接</div>';
            });
          document
            .querySelectorAll(".server-group .chat-input")
            .forEach((inp) => {
              inp.disabled = true;
              inp.placeholder = "聊天未连接";
            });
          document
            .querySelectorAll(".server-group .chat-send-btn")
            .forEach((btn) => (btn.disabled = true));
          const pubContainer = document.getElementById("publicChatMessages");
          if (pubContainer)
            pubContainer.innerHTML =
              '<div style="color:var(--red);text-align:center;padding:20px;">⚠️ 聊天服务未连接</div>';
        }
        return;
      }

      ensureUsername(() => {
        try {
          if (state.goEasyReady && goEasy) {
            // 已连接则无需重复初始化
            subscribePublicChannel();
            subscribeAllChannels();
            return;
          }
          _goEasyInitInFlight = true;
          const _appkey = getGoEasyAppkey();
          const _host = getGoEasyHost();
          if (!_appkey || !_host) {
            _goEasyInitInFlight = false;
            state.goEasyReady = false;
            state.publicChatReady = false;
            state.presenceReady = false;
            updateChatUI();
            if (!_goEasyMissingConfigToastShown) {
              _goEasyMissingConfigToastShown = true;
              showToast(
                "⚠️ GoEasy 未配置，请先在环境变量配置中填写 AppKey 和主机",
                3200,
                false,
              );
            }
            return;
          }
          _goEasyMissingConfigToastShown = false;
          const _forceTLS =
            state.goEasyConfig &&
            typeof state.goEasyConfig.force_tls === "boolean"
              ? state.goEasyConfig.force_tls
              : true;
          // getInstance 多次调用时复用已有实例
          try {
            goEasy = GoEasy.getInstance({
              host: _host,
              appkey: _appkey,
              modules: ["pubsub"],
              forceTLS: _forceTLS,
            });
          } catch (instErr) {
            console.warn("GoEasy.getInstance 异常，尝试继续", instErr);
            if (!goEasy && typeof GoEasy.getInstance === "function") {
              goEasy = GoEasy.getInstance({
                host: _host,
                appkey: _appkey,
                modules: ["pubsub"],
                forceTLS: _forceTLS,
              });
            }
          }
          const userId = String(state.userId || getStoredUserId() || "").trim();
          const nick = state.username || "匿名用户";
          if (!userId) {
            _goEasyInitInFlight = false;
            showToast("❌ 用户 ID 无效", 2500, false);
            return;
          }
          const presenceAvatar = /^https?:\/\//i.test(
            String(state.avatar || ""),
          )
            ? String(state.avatar)
            : "";
          goEasy.connect({
            id: userId,
            data: { nickname: nick, avatar: presenceAvatar },
            onSuccess: function () {
              console.log("GoEasy 连接成功，用户ID:", goEasy.id);
              _goEasyInitInFlight = false;
              state.goEasyReady = true;
              // 新连接代次清掉旧的“订阅中”标记，避免断线时未回调造成永久阻塞。
              state.publicChatSubscribing = false;
              state.chatSubscribing = {};
              // 自己刚连上：等 hereNow 拉完在线列表后再检查用户名冲突
              requestSelfUsernameConflictCheck();
              // 换回旧 ID 且本地无头像时，优先从 R2 稳定对象恢复，GoEasy 历史仅作兼容兜底
              try {
                if (
                  state._pendingAvatarSync ||
                  !/^https?:\/\//i.test(
                    String(state.avatar || getStoredAvatar() || ""),
                  )
                ) {
                  state._pendingAvatarSync = false;
                  setTimeout(function () {
                    syncAvatarFromGoEasyHistory(
                      state.userId || getStoredUserId(),
                    );
                  }, 700);
                }
              } catch (e) {}
              // 广播最新昵称/头像，让其他人及时更新（冲突改名重连场景）
              try {
                setTimeout(function () {
                  _broadcastPresenceSelf();
                }, 600);
              } catch (e) {}
              // 二次冲突检查：防止首次 hereNow 列表不完整
              try {
                setTimeout(function () {
                  if (!state.usernameConflictOffline)
                    checkUsernameConflictAgainstOnline();
                }, 1500);
              } catch (e) {}
              showToast("✅ 聊天服务已连接", 1500, true);
              // 必须先 subscribe(presence:enable) 成功，再挂 Presence 监听
              subscribePublicChannel();
              forceSubscribeAll();
              state.servers.forEach((s) => renderChatMessages(s.id, false));
              renderPublicChat(false);
              updateChatUI();
              restorePublicUnread();
            },
            onFailed: function (error) {
              console.error("GoEasy 连接失败", error);
              _goEasyInitInFlight = false;
              state.goEasyReady = false;
              state.presenceReady = false;
              if (retryCount < 3) {
                console.warn(`GoEasy 连接失败，${retryCount + 1}秒后重试...`);
                setTimeout(() => {
                  if (goEasy) {
                    try {
                      goEasy.disconnect();
                    } catch (e) {}
                    goEasy = null;
                  }
                  initGoEasy(retryCount + 1);
                }, 2000);
              } else {
                showToast(
                  "❌ 聊天服务连接失败，请检查网络或 appkey",
                  3000,
                  false,
                );
                document
                  .querySelectorAll(".server-group .chat-input")
                  .forEach((inp) => {
                    inp.disabled = true;
                    inp.placeholder = "聊天不可用";
                  });
                document
                  .querySelectorAll(".server-group .chat-send-btn")
                  .forEach((btn) => (btn.disabled = true));
                const pubContainer =
                  document.getElementById("publicChatMessages");
                if (pubContainer)
                  pubContainer.innerHTML =
                    '<div style="color:var(--red);text-align:center;padding:20px;">⚠️ 聊天服务未连接</div>';
                updateOnlineMembersUI();
              }
            },
          });
        } catch (e) {
          console.error("GoEasy 初始化异常", e);
          _goEasyInitInFlight = false;
          state.goEasyReady = false;
          if (retryCount < 3) {
            setTimeout(() => initGoEasy(retryCount + 1), 2000);
          } else {
            showToast("❌ 聊天服务初始化失败", 3000, false);
          }
        }
      });
    }

    // ---- 公共未读状态管理 ----
    function getPublicUnreadCount() {
      const raw = localStorage.getItem(PUBLIC_UNREAD_KEY);
      // 兼容旧布尔值存储
      if (raw === "true") return 1;
      if (raw === "false" || raw == null || raw === "") return 0;
      const n = parseInt(raw, 10);
      return isNaN(n) || n < 0 ? 0 : n;
    }

    function updatePublicUnreadBadge() {
      const badge = document.getElementById("publicUnreadBadge");
      if (!badge) return;
      const count = getPublicUnreadCount();
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.toggle("zero", count === 0);
    }

    function setPublicUnread(value) {
      // value: true 表示 +1；false 表示清零；number 表示直接设置
      if (value === false || value === 0) {
        localStorage.setItem(PUBLIC_UNREAD_KEY, "0");
      } else if (value === true) {
        const next = getPublicUnreadCount() + 1;
        localStorage.setItem(PUBLIC_UNREAD_KEY, String(next));
      } else if (typeof value === "number") {
        localStorage.setItem(PUBLIC_UNREAD_KEY, String(Math.max(0, value | 0)));
      }
      updatePublicUnreadBadge();
    }

    // 撤回/删除时扣减公共未读（不低于 0）
    function decPublicUnread() {
      const c = getPublicUnreadCount();
      if (c > 0) setPublicUnread(c - 1);
    }

    function decServerUnread(serverId) {
      if (!serverId) return;
      const c = getUnreadCount(serverId);
      if (c <= 0) return;
      const next = c - 1;
      if (next <= 0) delete state.unreadStatus[serverId];
      else state.unreadStatus[serverId] = next;
      saveUnreadStatus();
      updateUnreadIndicators();
    }

    function findMessageById(msgId) {
      for (const k of Object.keys(state.chatMessages || {})) {
        const m = (state.chatMessages[k] || []).find(
          (x) => x && x.id === msgId,
        );
        if (m) return { scope: "server", serverId: k, msg: m };
      }
      const pm = (state.publicMessages || []).find((x) => x && x.id === msgId);
      if (pm) return { scope: "public", msg: pm };
      return null;
    }

    function adjustUnreadForRemovedMessage(msgId) {
      const found = findMessageById(msgId);
      if (!found || !found.msg) return;
      if (found.msg.isMine) return;
      if (found.scope === "public" && !state.publicModalOpen) decPublicUnread();
      if (
        found.scope === "server" &&
        found.serverId &&
        !state.expanded.has(found.serverId)
      ) {
        decServerUnread(found.serverId);
      }
    }

    function restorePublicUnread() {
      updatePublicUnreadBadge();
    }

    // ---- 订阅服务器频道 ----
    function _historyItemContent(item) {
      if (item == null) return null;
      if (typeof item === "string") return item;
      // GoEasy 不同版本字段：content / message / msg
      if (item.content != null)
        return typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content);
      if (item.message != null)
        return typeof item.message === "string"
          ? item.message
          : JSON.stringify(item.message);
      if (item.msg != null)
        return typeof item.msg === "string"
          ? item.msg
          : JSON.stringify(item.msg);
      return null;
    }

    function loadChannelHistory(channel, onMessage, onDone) {
      if (!goEasy || !state.goEasyReady || !goEasy.pubsub) {
        if (typeof onDone === "function") onDone(false);
        return;
      }
      if (typeof goEasy.pubsub.history !== "function") {
        console.warn("[历史消息] 当前 SDK 不支持 history API", channel);
        if (typeof onDone === "function") onDone(false);
        return;
      }
      try {
        goEasy.pubsub.history({
          channel: channel,
          limit: HISTORY_LIMIT,
          onSuccess: function (response) {
            try {
              const content =
                response && response.content ? response.content : response;
              const list =
                (content && content.messages) ||
                (content && content.messageList) ||
                (Array.isArray(content) ? content : []) ||
                [];
              console.log("[历史消息] 拉取成功", channel, "条数=", list.length);
              // 两遍扫描：先收集撤回/删除 id，再投递未撤回的消息
              const historyDeleted = new Set();
              const contents = [];
              list.forEach(function (item) {
                const raw = _historyItemContent(item);
                if (raw == null) return;
                contents.push(raw);
                try {
                  const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
                  if (msg && msg.type === "delete" && msg.id) {
                    historyDeleted.add(String(msg.id));
                    markMsgDeleted(msg.id);
                  }
                } catch (e) {
                  /* ignore */
                }
              });
              contents.forEach(function (raw) {
                try {
                  const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
                  if (!msg) return;
                  // 不投递撤回信令本身
                  if (msg.type === "delete") return;
                  // 不投递已被撤回的消息
                  if (
                    msg.id &&
                    (historyDeleted.has(String(msg.id)) ||
                      _deletedMsgIds.has(msg.id))
                  )
                    return;
                  // 资料同步消息仍交给 onMessage（公共频道需要）
                  if (typeof onMessage === "function")
                    onMessage({
                      content:
                        typeof raw === "string" ? raw : JSON.stringify(raw),
                    });
                } catch (e) {
                  // 非 JSON 内容原样忽略
                }
              });
              if (typeof onDone === "function") onDone(true);
            } catch (e) {
              console.warn("[历史消息] 解析失败", channel, e);
              if (typeof onDone === "function") onDone(false);
            }
          },
          onFailed: function (error) {
            console.warn("[历史消息] 获取失败", channel, error);
            if (typeof onDone === "function") onDone(false);
          },
        });
      } catch (e) {
        console.warn("[历史消息] 调用异常", channel, e);
        if (typeof onDone === "function") onDone(false);
      }
    }

    function markChatHistoryCached() {
      state.hasChatHistoryCache = true;
      try {
        saveChatMessages();
        if (localStorage.getItem(CHAT_STORAGE_KEY) === null) {
          localStorage.setItem(
            CHAT_STORAGE_KEY,
            JSON.stringify(state.chatMessages || {}),
          );
        }
      } catch (e) {}
    }

    function markPublicHistoryCached() {
      state.hasPublicHistoryCache = true;
      try {
        savePublicMessages();
        if (localStorage.getItem(PUBLIC_STORAGE_KEY) === null) {
          localStorage.setItem(
            PUBLIC_STORAGE_KEY,
            JSON.stringify(state.publicMessages || []),
          );
        }
      } catch (e) {}
    }

    function subscribeChannel(serverId) {
      if (
        !goEasy ||
        !state.goEasyReady ||
        state.chatSubscribed[serverId] ||
        state.chatSubscribing[serverId]
      ) return;
      const channel = CHAT_PREFIX + serverId;
      // 历史只走一个入口：优先显式 history API；旧 SDK 才回退 subscribe.history。
      const needHistory = !state.hasChatHistoryCache || state.forceHistoryOnce;
      const canUseHistoryApi =
        !!goEasy.pubsub && typeof goEasy.pubsub.history === "function";
      const historyCount = needHistory && !canUseHistoryApi ? HISTORY_LIMIT : 0;
      state.chatSubscribing[serverId] = true;
      try {
        goEasy.pubsub.subscribe({
        channel: channel,
        history: historyCount,
        onMessage: function (message) {
          handleChatMessage(serverId, message.content);
        },
        onSuccess: function () {
          delete state.chatSubscribing[serverId];
          state.chatSubscribed[serverId] = true;
          console.log(`订阅频道 ${channel} 成功 needHistory=${needHistory}`);
          if (needHistory && canUseHistoryApi) {
            loadChannelHistory(
              channel,
              function (message) {
                handleChatMessage(serverId, message.content);
              },
              function () {
                try {
                  if (Array.isArray(state.chatMessages[serverId])) {
                    state.chatMessages[serverId] = state.chatMessages[
                      serverId
                    ].filter(function (m) {
                      return m && m.id && !_deletedMsgIds.has(m.id);
                    });
                    state.chatMessages[serverId].sort(function (a, b) {
                      return (a.time || 0) - (b.time || 0);
                    });
                  }
                } catch (e) {}
                markChatHistoryCached();
                // 所有强制历史拉取完成后清标志（公共频道也会清一次）
                state.forceHistoryOnce = false;
                renderChatMessages(serverId, true);
              },
            );
          } else if (needHistory) {
            // 旧 SDK 的 subscribe.history 会把历史投递到 onMessage。
            markChatHistoryCached();
            state.forceHistoryOnce = false;
            renderChatMessages(serverId, true);
          }
        },
        onFailed: function (error) {
          delete state.chatSubscribing[serverId];
          console.error(`订阅频道 ${channel} 失败`, error);
          setTimeout(() => {
            if (state.goEasyReady && !state.chatSubscribed[serverId]) {
              subscribeChannel(serverId);
            }
          }, 5000);
        },
        });
      } catch (error) {
        delete state.chatSubscribing[serverId];
        console.error(`订阅频道 ${channel} 调用异常`, error);
        setTimeout(() => {
          if (state.goEasyReady && !state.chatSubscribed[serverId]) {
            subscribeChannel(serverId);
          }
        }, 5000);
      }
    }

    function subscribeAllChannels() {
      if (!goEasy || !state.goEasyReady) return;
      state.servers.forEach((s) => {
        subscribeChannel(s.id);
      });
    }

    function forceSubscribeAll() {
      if (!state.goEasyReady) return;
      state.chatSubscribed = {};
      state.chatSubscribing = {};
      subscribeAllChannels();
      console.log("[聊天] 强制重新订阅服务器频道");
    }

    // ---- 服务器聊天接收 ----
    function handleChatMessage(serverId, content) {
      try {
        const msg = JSON.parse(content);
        if (msg.type === "delete" && msg.id) {
          markMsgDeleted(msg.id);
          const before = (state.chatMessages[serverId] || []).find(
            (m) => m.id === msg.id,
          );
          state.chatMessages[serverId] = (
            state.chatMessages[serverId] || []
          ).filter((m) => m.id !== msg.id);
          // 已计入未读的消息被撤回 → 角标 -1
          if (before && !before.isMine && !state.expanded.has(serverId)) {
            decServerUnread(serverId);
          }
          saveChatMessages();
          renderChatMessages(serverId, false);
          return;
        }
        if (_deletedMsgIds.has(msg.id)) return;
        if (!state.chatMessages[serverId]) state.chatMessages[serverId] = [];

        const exists = state.chatMessages[serverId].some(
          (m) => m.id === msg.id,
        );
        if (exists) return;
        // 已撤回的消息不进入列表、不增加未读
        if (msg.type === "delete") return;

        const isMine = isMessageMine(msg);
        state.chatMessages[serverId].push({
          id: msg.id,
          text: msg.text,
          sender: msg.sender,
          senderName: msg.senderName || msg.nickname || msg.sender,
          senderId: msg.senderId || "",
          isMine: isMine,
          time: msg.time || Date.now(),
          isImage: !!msg.isImage,
          mediaType: msg.mediaType || "",
          url: msg.url || "",
          fileName: _restoreBlockedExt(msg.fileName || ""),
          fileSize: msg.fileSize || 0,
          mimeType: msg.mimeType || "",
          isXor: !!msg.isXor || (msg.url || "").toLowerCase().endsWith(".dlp"),
        });
        saveChatMessages();
        renderChatMessages(serverId, true);

        if (!isMine && !state.expanded.has(serverId)) {
          state.unreadStatus[serverId] = getUnreadCount(serverId) + 1;
          saveUnreadStatus();
          updateUnreadIndicators();
        }
      } catch (e) {
        console.warn("解析聊天消息失败", e);
      }
    }

    // ---- 服务器聊天发送 ----
    // mediaOrFlag: 兼容旧布尔 isVideo，或媒体元数据对象
    function sendChatMessage(serverId, text, mediaOrFlag) {
      if (!text || !String(text).trim()) return;
      if (!state.username) {
        showToast("⚠️ 请先点击聊天输入框设置用户名", 1800, false);
        return;
      }
      if (!goEasy || !state.goEasyReady) {
        showToast("⚠️ 聊天服务未连接，请稍后重试", 2000, false);
        return;
      }
      const media =
        mediaOrFlag && typeof mediaOrFlag === "object" ? mediaOrFlag : null;
      const isVideoFlag = mediaOrFlag === true;
      const channel = CHAT_PREFIX + serverId;
      const msgId = generateMsgId();
      const mediaType = media
        ? media.mediaType || ""
        : isVideoFlag
          ? "video"
          : "";
      const msgObj = {
        id: msgId,
        text: String(text).trim(),
        sender: state.userId,
        senderName: state.username,
        senderId: state.userId,
        senderAvatar:
          state.avatar && String(state.avatar).indexOf("data:") === 0
            ? undefined
            : state.avatar || undefined,
        time: Date.now(),
        isImage: mediaType === "image" || mediaType === "video",
        mediaType: mediaType || undefined,
        url: media && media.url ? media.url : undefined,
        fileName: media && media.fileName ? media.fileName : undefined,
        fileSize: media && media.fileSize != null ? media.fileSize : undefined,
        mimeType: media && media.mimeType ? media.mimeType : undefined,
        isXor: media && media.isXor ? true : undefined,
      };
      const payload = JSON.stringify(msgObj);
      goEasy.pubsub.publish({
        channel: channel,
        message: payload,
        qos: 1,
        onSuccess: function () {
          if (!state.chatMessages[serverId]) state.chatMessages[serverId] = [];
          const exists = state.chatMessages[serverId].some(
            (m) => m.id === msgId,
          );
          if (!exists) {
            state.chatMessages[serverId].push(
              Object.assign({ isMine: true }, msgObj, {
                isXor: !!msgObj.isXor,
              }),
            );
            saveChatMessages();
          }
          renderChatMessages(serverId, true);
          const card = document.querySelector(
            `.server-group[data-id="${serverId}"]`,
          );
          if (card) {
            const input = card.querySelector(".chat-input");
            if (input) {
              input.value = "";
              input.style.height = "auto";
            }
          }
        },
        onFailed: function (error) {
          console.error("消息发送失败", error);
          showToast(
            "❌ 消息发送失败：" +
              (error && error.content ? error.content : error),
            2500,
            false,
          );
        },
      });
    }

    // ---- 渲染消息列表（支持滚动位置恢复） ----
    function getChatMessagesSignature(messages) {
      if (!messages || !messages.length) return "empty";
      // 用条数 + 首尾 id/time 做轻量签名，避免无变化时重绘
      const first = messages[0];
      const last = messages[messages.length - 1];
      return (
        messages.length +
        "|" +
        (first && first.id) +
        "|" +
        (last && last.id) +
        "|" +
        (last && last.time)
      );
    }

    function renderChatMessages(serverId, forceScroll = false) {
      const card = document.querySelector(
        `.server-group[data-id="${serverId}"]`,
      );
      if (!card) return;
      const container = card.querySelector(".chat-messages");
      if (!container) return;

      // 输入框正在输入时，除非强制滚到底（新消息），否则不要动 DOM，避免收起键盘
      const inputEl = card.querySelector(".chat-input");
      const inputFocused = inputEl && document.activeElement === inputEl;

      if (!state.goEasyReady) {
        if (container.dataset.sig !== "disconnected") {
          container.innerHTML =
            '<div style="color:var(--red);text-align:center;padding:8px;">⚠️ 聊天服务未连接</div>';
          container.dataset.sig = "disconnected";
        }
        return;
      }

      const messages = state.chatMessages[serverId] || [];
      const sig = getChatMessagesSignature(messages);

      // 消息未变化且非强制滚动：保持现状，避免跳到第一条 / 丢焦点
      if (container.dataset.sig === sig && !forceScroll) {
        return;
      }

      // 重绘前记住当前位置
      const prevScroll = container.scrollTop;
      const prevHeight = container.scrollHeight;
      const wasNearBottom =
        prevScroll + container.clientHeight >= prevHeight - 40;

      if (messages.length === 0) {
        container.innerHTML =
          '<div style="color:var(--muted);text-align:center;padding:8px;font-size:12px;">暂无消息</div>';
      } else {
        container.innerHTML = buildChatMessagesHtml(messages);
      }
      container.dataset.sig = sig;

      // 滚动：新消息强制到底；否则尽量保持原位置 / 贴底
      const savedPosition = getChatScroll(serverId);
      if (
        (forceScroll && (savedPosition === null || wasNearBottom)) ||
        (!forceScroll && wasNearBottom && savedPosition === null)
      ) {
        container.scrollTop = container.scrollHeight;
        saveChatScroll(serverId, container.scrollTop);
      } else {
        const saved = savedPosition;
        if (saved !== null) {
          const maxScroll = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          container.scrollTop = Math.min(saved, maxScroll);
        } else {
          container.scrollTop = container.scrollHeight;
          saveChatScroll(serverId, container.scrollTop);
        }
      }

      // 若因重绘导致失焦，尝试恢复（仅在本次确实有输入焦点时）
      if (inputFocused && inputEl && document.activeElement !== inputEl) {
        try {
          inputEl.focus({ preventScroll: true });
        } catch (e) {
          try {
            inputEl.focus();
          } catch (_) {}
        }
      }
    }

    // ===== 初始化聊天卡片 =====
    function initChatForCard(serverId, cardElement) {
      let wrapper = cardElement.querySelector(".chat-wrapper");
      const bodyInner = cardElement.querySelector(".server-body > .body-inner");
      if (!bodyInner) return;

      const isNew = !wrapper;

      if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.className = "chat-wrapper";
        const hasUsername = !!state.username;
        const ready = state.goEasyReady && hasUsername;
        wrapper.innerHTML = `
        <div class="chat-messages"></div>
        <div class="chat-plus-panel">
          <button type="button" data-plus-action="image">🖼️ 图片</button>
          <button type="button" data-plus-action="video">🎬 视频</button>
          <button type="button" data-plus-action="file">📎 文件</button>
        </div>
        <div class="chat-input-area">
          <button type="button" class="chat-plus-btn" title="添加附件" ${ready ? "" : "disabled"}>＋</button>
          <textarea rows="1" class="chat-input" placeholder="${!hasUsername ? "请先设置用户名" : ready ? "输入聊天内容..." : "聊天未连接"}" ${!hasUsername ? 'readonly data-requires-username="true"' : ready ? "" : "disabled"}></textarea>
          <button type="button" class="chat-voice-btn" title="录制语音" ${ready ? "" : "disabled"}>🎤</button>
          <button class="chat-send-btn" ${ready ? "" : "disabled"}>发送</button>
        </div>
      `;
        const roomList = bodyInner.querySelector(".room-list");
        if (roomList) {
          bodyInner.insertBefore(wrapper, roomList);
        } else {
          bodyInner.prepend(wrapper);
        }

        // 绑定滚动事件以保存位置
        const container = wrapper.querySelector(".chat-messages");
        if (container && !container.dataset.scrollBound) {
          container.addEventListener("scroll", function () {
            saveChatScroll(serverId, this.scrollTop);
          });
          container.dataset.scrollBound = "true";
        }

        const input = wrapper.querySelector(".chat-input");
        const sendBtn = wrapper.querySelector(".chat-send-btn");
        const plusBtn = wrapper.querySelector(".chat-plus-btn");
        const plusPanel = wrapper.querySelector(".chat-plus-panel");
        const voiceBtn = wrapper.querySelector(".chat-voice-btn");
        input.addEventListener("click", function (e) {
          if (state.username || getStoredUsername()) return;
          e.preventDefault();
          e.stopPropagation();
          requireUsernameForChat(function () {
            // 连接成功后 updateChatUI 会自动解除 disabled；避免在连接中抢焦点。
            setTimeout(function () {
              if (!input.disabled) {
                try {
                  input.focus({ preventScroll: true });
                } catch (_) {
                  try {
                    input.focus();
                  } catch (__) {}
                }
              }
            }, 120);
          });
        });
        const sendHandler = function () {
          if (sendPendingAttachment(serverId, input, false, serverId)) return;
          const text = input.value.trim();
          if (text) sendChatMessage(serverId, text, false);
        };
        sendBtn.addEventListener("click", sendHandler);
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            sendHandler();
          }
        });
        bindPlusMenu(plusBtn, plusPanel, {
          image: function () {
            sendMessageWithMedia(
              serverId,
              input,
              sendChatMessage,
              false,
              "image/*",
            );
          },
          video: function () {
            sendMessageWithMedia(
              serverId,
              input,
              sendChatMessage,
              false,
              "video/*",
            );
          },
          file: function () {
            sendMessageWithMedia(
              serverId,
              input,
              sendChatMessage,
              false,
              "*/*",
            );
          },
        });
        if (voiceBtn) {
          voiceBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            startVoiceRecording(voiceBtn, function (file) {
              storeRecordedVoice(file, serverId, false);
            });
          });
        }
        wrapper.dataset.bound = "true";
      }

      // 仅在新创建或消息可能变化时渲染；输入中由 renderChatMessages 内部保护
      if (isNew) {
        renderChatMessages(serverId, false); // 首次打开恢复上次位置
      } else {
        renderChatMessages(serverId, false);
      }

      if (state.goEasyReady && !state.chatSubscribed[serverId]) {
        subscribeChannel(serverId);
      }
    }

    // ---- 公共频道 ----
    function subscribePublicChannel() {
      if (
        !goEasy ||
        !state.goEasyReady ||
        state.publicChatReady ||
        state.publicChatSubscribing
      ) return;
      const needPublicHistory =
        !state.hasPublicHistoryCache || state.forceHistoryOnce;
      const canUseHistoryApi =
        !!goEasy.pubsub && typeof goEasy.pubsub.history === "function";
      state.publicChatSubscribing = true;
      try {
        goEasy.pubsub.subscribe({
        channel: PUBLIC_CHANNEL,
        history: needPublicHistory && !canUseHistoryApi ? HISTORY_LIMIT : 0,
        // 官方要求：订阅时开启 presence，该订阅才会被计入在线成员
        presence: { enable: true },
        onMessage: function (message) {
          try {
            const msg = JSON.parse(message.content);
            // 资料同步（昵称/头像）消息：更新成员列表，不进入聊天记录
            if (
              msg &&
              (msg.action === "set" || msg.type === "profile") &&
              msg.member
            ) {
              const mid = String(msg.member.id || msg.member.userId || "");
              if (mid) {
                // 先写入资料缓存，再 normalize（normalize 会读缓存）
                const rawNick =
                  msg.member.nickname ||
                  (msg.member.data && msg.member.data.nickname) ||
                  "";
                const rawAv =
                  msg.member.avatar ||
                  (msg.member.data && msg.member.data.avatar) ||
                  "";
                rememberMemberProfile(mid, rawNick, rawAv);
                const norm = normalizeMember(msg.member, { preferLive: true });
                const idx = state.onlineMembers.findIndex(
                  (m) => String(m.id) === mid,
                );
                if (idx >= 0)
                  state.onlineMembers[idx] = Object.assign(
                    {},
                    state.onlineMembers[idx],
                    norm,
                  );
                else state.onlineMembers.unshift(norm);
                // 对方改名/换头像：成员列表 + 聊天区立即刷新
                document
                  .querySelectorAll(".chat-messages, #publicChatMessages")
                  .forEach(function (el) {
                    try {
                      delete el.dataset.sig;
                    } catch (e) {}
                  });
                updateOnlineMembersUI();
                state.servers.forEach(function (s) {
                  renderChatMessages(s.id, false);
                });
                renderPublicChat(false);
              }
              return;
            }
            if (msg.type === "delete" && msg.id) {
              markMsgDeleted(msg.id);
              const before = (state.publicMessages || []).find(
                (m) => m.id === msg.id,
              );
              state.publicMessages = (state.publicMessages || []).filter(
                (m) => m.id !== msg.id,
              );
              // 未读角标排除已撤回的消息
              if (before && !before.isMine && !state.publicModalOpen) {
                decPublicUnread();
              }
              savePublicMessages();
              renderPublicChat(false);
              return;
            }
            if (_deletedMsgIds.has(msg.id)) return;
            if (!state.publicMessages) state.publicMessages = [];

            const exists = state.publicMessages.some((m) => m.id === msg.id);
            if (exists) return;

            const isMine = isMessageMine(msg);
            state.publicMessages.push({
              id: msg.id,
              text: msg.text,
              sender: msg.sender || "匿名",
              senderName:
                msg.senderName || msg.nickname || msg.sender || "匿名",
              senderId: msg.senderId || "",
              isMine: isMine,
              time: msg.time || Date.now(),
              isImage: !!msg.isImage,
              mediaType: msg.mediaType || "",
              url: msg.url || "",
              fileName: _restoreBlockedExt(msg.fileName || ""),
              fileSize: msg.fileSize || 0,
              mimeType: msg.mimeType || "",
              isXor:
                !!msg.isXor || (msg.url || "").toLowerCase().endsWith(".dlp"),
            });
            savePublicMessages();
            renderPublicChat(true);

            if (!isMine && !state.publicModalOpen) {
              setPublicUnread(true);
            }
          } catch (e) {
            console.warn("公共消息解析失败", e);
          }
        },
        onSuccess: function () {
          console.log("公共频道订阅成功");
          state.publicChatSubscribing = false;
          state.publicChatReady = true;
          // 当前 ID 若本地无头像，优先从 R2 恢复，GoEasy 历史仅作兼容兜底
          try {
            const av = state.avatar || getStoredAvatar() || "";
            if (!/^https?:\/\//i.test(String(av))) {
              syncAvatarFromGoEasyHistory(state.userId || getStoredUserId());
            }
          } catch (e) {}
          if (needPublicHistory && canUseHistoryApi) {
            loadChannelHistory(
              PUBLIC_CHANNEL,
              function (message) {
                // 复用 onMessage 逻辑：直接走同一套解析
                try {
                  const msg = JSON.parse(message.content);
                  if (msg && (msg.action === "set" || msg.type === "profile"))
                    return;
                  if (msg && msg.type === "delete" && msg.id) {
                    markMsgDeleted(msg.id);
                    return;
                  }
                  if (!msg || !msg.id || _deletedMsgIds.has(msg.id)) return;
                  if (!state.publicMessages) state.publicMessages = [];
                  if (state.publicMessages.some((m) => m.id === msg.id)) return;
                  const isMine = isMessageMine(msg);
                  state.publicMessages.push(
                    Object.assign({}, msg, { isMine: !!isMine }),
                  );
                } catch (e) {
                  /* ignore non-chat */
                }
              },
              function () {
                // 排除已撤回消息并按时间排序
                try {
                  state.publicMessages = (state.publicMessages || []).filter(
                    function (m) {
                      return m && m.id && !_deletedMsgIds.has(m.id);
                    },
                  );
                  state.publicMessages.sort(function (a, b) {
                    return (a.time || 0) - (b.time || 0);
                  });
                } catch (e) {}
                markPublicHistoryCached();
                state.forceHistoryOnce = false;
                renderPublicChat(false);
              },
            );
          } else {
            if (needPublicHistory) {
              // 旧 SDK 的 subscribe.history 已通过 onMessage 投递历史。
              markPublicHistoryCached();
              state.forceHistoryOnce = false;
            } else {
              savePublicMessages();
            }
            renderPublicChat(false);
          }
          restorePublicUnread();
          // 公共频道订阅成功后再拉在线列表（自己已在该 channel 上）
          if (!state.presenceReady) {
            initPresence();
          } else {
            queryHereNow();
          }
        },
        onFailed: function (error) {
          state.publicChatSubscribing = false;
          console.error("公共频道订阅失败", error);
          setTimeout(() => {
            if (state.goEasyReady && !state.publicChatReady) {
              subscribePublicChannel();
            }
          }, 5000);
        },
        });
      } catch (error) {
        state.publicChatSubscribing = false;
        console.error("公共频道订阅调用异常", error);
        setTimeout(() => {
          if (state.goEasyReady && !state.publicChatReady) {
            subscribePublicChannel();
          }
        }, 5000);
      }
    }

    // ---- 在线成员 Presence ----
    function initPresence() {
      if (!goEasy || !state.goEasyReady) return;
      // subscribePresence 成功/失败回调负责首次 hereNow，避免初始化时并发查询两次。
      subscribePresence();
      startPresencePolling();
    }

    function startPresencePolling() {
      if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
      // 依赖 subscribePresence 监听实时上下线推送，定时器放宽至 60 秒作为保底校准
      presenceRefreshTimer = setInterval(() => {
        if (!state.goEasyReady || document.hidden) return;
        queryHereNow();
      }, 60000);
    }

    const MEMBER_PROFILES_KEY = "lanplay_member_profiles";

    function loadMemberProfiles() {
      try {
        const raw = localStorage.getItem(MEMBER_PROFILES_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object")
            state.memberProfiles = parsed;
        }
      } catch (e) {
        state.memberProfiles = {};
      }
    }

    function saveMemberProfiles() {
      try {
        localStorage.setItem(
          MEMBER_PROFILES_KEY,
          JSON.stringify(state.memberProfiles || {}),
        );
      } catch (e) {}
    }

    // 记住用户最新昵称/头像，避免 hereNow 用 GoEasy 连接时的旧 data 覆盖
    function rememberMemberProfile(id, nickname, avatar) {
      const key = String(id || "");
      if (!key || key === "unknown") return;
      if (!state.memberProfiles) state.memberProfiles = {};
      const prev = state.memberProfiles[key] || {};
      const nextNick =
        nickname != null && String(nickname).trim()
          ? String(nickname).trim()
          : prev.nickname || "";
      const nextAv =
        avatar != null && String(avatar).trim()
          ? String(avatar).trim()
          : prev.avatar || "";
      state.memberProfiles[key] = {
        nickname: nextNick,
        avatar: nextAv,
        updatedAt: Date.now(),
      };
      saveMemberProfiles();
    }

    function normalizeMember(m, opts) {
      opts = opts || {};
      const preferLive = !!opts.preferLive; // join/profile 广播时信任现场资料并写缓存
      if (!m) return { id: "unknown", nickname: "未知用户", avatar: "" };
      let id = m.id || m.userId || "unknown";
      let nickname = "";
      let avatar = "";
      const rawData = m.data !== undefined ? m.data : m.userData;
      if (rawData && typeof rawData === "object") {
        nickname = rawData.nickname || rawData.name || "";
        avatar = rawData.avatar || "";
      } else if (typeof rawData === "string" && rawData) {
        try {
          const parsed = JSON.parse(rawData);
          nickname = parsed.nickname || parsed.name || "";
          avatar = parsed.avatar || "";
        } catch (_) {
          nickname = rawData;
        }
      }
      // 兼容我们广播的顶层字段
      if (m.nickname) nickname = m.nickname;
      if (m.name && !nickname) nickname = m.name;
      if (m.avatar) avatar = m.avatar;

      const myId = String(state.userId || getStoredUserId() || "");
      id = String(id);
      if (id === myId) {
        if (state.username) nickname = state.username;
        if (state.avatar) avatar = state.avatar;
      } else {
        const hasLiveNick = !!(nickname && String(nickname).trim());
        const hasLiveAv = !!(avatar && String(avatar).trim());
        const cached = state.memberProfiles && state.memberProfiles[id];

        if (preferLive && (hasLiveNick || hasLiveAv)) {
          // 对方刚上线 / 主动广播资料：现场资料写缓存
          rememberMemberProfile(
            id,
            hasLiveNick ? nickname : null,
            hasLiveAv ? avatar : null,
          );
        } else if (cached && (cached.nickname || cached.avatar)) {
          // hereNow 等全量快照：优先用资料缓存，避免 GoEasy 连接时的旧 data 盖住已广播的新昵称
          if (cached.nickname) nickname = cached.nickname;
          if (cached.avatar) avatar = cached.avatar;
        } else if (hasLiveNick || hasLiveAv) {
          // 无缓存时用现场资料并写入
          rememberMemberProfile(
            id,
            hasLiveNick ? nickname : null,
            hasLiveAv ? avatar : null,
          );
        }
      }
      if (!nickname) nickname = id || "未知用户";
      return {
        id: id,
        nickname: String(nickname),
        avatar: String(avatar || ""),
      };
    }

    // 上线 toast 去重 + 首次全量列表不提示
    const _onlineToastAt = Object.create(null);
    let _presenceSnapshotReady = false;

    // 延迟上线 toast：对方因用户名冲突瞬间上线又下线时不提示
    const _pendingOnlineToasts = Object.create(null);
    const ONLINE_TOAST_DELAY_MS = 1800;

    function cancelPendingOnlineToast(userId) {
      const id = String(userId || "");
      if (!id || !_pendingOnlineToasts[id]) return;
      try {
        clearTimeout(_pendingOnlineToasts[id].timer);
      } catch (e) {}
      delete _pendingOnlineToasts[id];
    }

    function notifyMemberOnline(member) {
      if (!member) return;
      const norm = normalizeMember(member);
      const id = String(norm.id || "");
      const name = norm.nickname || id || "未知成员";
      const myId = String(state.userId || getStoredUserId() || "");
      if (id && myId && id === myId) return;
      if (!id) return;
      const now = Date.now();
      if (_onlineToastAt[id] && now - _onlineToastAt[id] < 8000) return;
      // 已有未触发的延迟 toast：更新名字即可
      if (_pendingOnlineToasts[id]) {
        _pendingOnlineToasts[id].name = name;
        return;
      }
      _pendingOnlineToasts[id] = {
        name: name,
        timer: setTimeout(function () {
          const pending = _pendingOnlineToasts[id];
          delete _pendingOnlineToasts[id];
          if (!pending) return;
          // 延迟结束时若已不在线，说明是冲突闪上闪下，不 toast
          const stillOnline = (state.onlineMembers || []).some(function (m) {
            return m && String(m.id) === id;
          });
          if (!stillOnline) return;
          _onlineToastAt[id] = Date.now();
          showToast("🟢 " + (pending.name || name) + " 上线了", 2200, true);
        }, ONLINE_TOAST_DELAY_MS),
      };
    }

    function notifyMemberOffline(memberOrId) {
      const id =
        typeof memberOrId === "object" && memberOrId
          ? String(memberOrId.id || memberOrId.userId || "")
          : String(memberOrId || "");
      if (!id) return;
      cancelPendingOnlineToast(id);
    }

    function notifyNewOnlineMembers(prevList, nextList) {
      if (!_presenceSnapshotReady) return;
      const prevIds = new Set(
        (prevList || []).map((m) => String((m && m.id) || "")),
      );
      const nextIds = new Set(
        (nextList || []).map((m) => String((m && m.id) || "")),
      );
      (nextList || []).forEach(function (m) {
        if (!m || !m.id) return;
        if (!prevIds.has(String(m.id))) notifyMemberOnline(m);
      });
      // 从列表消失：取消延迟上线 toast（冲突闪断场景）
      prevIds.forEach(function (id) {
        if (id && !nextIds.has(id)) notifyMemberOffline(id);
      });
    }

    function applyPresencePayload(payload, opts) {
      if (!payload) return false;
      opts = opts || {};
      let listUpdated = false;

      // 新版: { action, member, amount, members }
      // 文档拼写 memebers 也兼容
      // 旧版: { events:[], clientAmount, ... } 或 hereNow content
      if (typeof payload.amount === "number") {
        state.onlineCount = payload.amount;
      } else if (typeof payload.clientAmount === "number") {
        state.onlineCount = payload.clientAmount;
      } else if (typeof payload.userAmount === "number") {
        state.onlineCount = payload.userAmount;
      }

      const listSource = Array.isArray(payload.members)
        ? payload.members
        : Array.isArray(payload.memebers)
          ? payload.memebers
          : Array.isArray(payload.users)
            ? payload.users
            : null;

      if (listSource) {
        // 全量成员列表（hereNow / presence 事件自带 members）——始终覆盖并同步人数
        const prevMembers = state.onlineMembers || [];
        const nextMembers = listSource.map(normalizeMember);
        // 首次全量快照之后，若有新增成员则 toast 上线
        notifyNewOnlineMembers(prevMembers, nextMembers);
        state.onlineMembers = nextMembers;
        if (typeof payload.amount === "number") {
          state.onlineCount = payload.amount;
        } else if (typeof payload.clientAmount === "number") {
          state.onlineCount = payload.clientAmount;
        } else {
          state.onlineCount = state.onlineMembers.length;
        }
        listUpdated = true;
        if (opts.fromHereNow) _presenceSnapshotReady = true;
      } else if (Array.isArray(payload.events)) {
        payload.events.forEach(function (ev) {
          const action = ev.action;
          const member = {
            id: ev.userId || (ev.member && ev.member.id),
            data: ev.userData || (ev.member && ev.member.data),
          };
          const mid = member.id;
          if (!mid) return;
          if (action === "join" || action === "online" || action === "back") {
            const norm = normalizeMember(member, { preferLive: true });
            const idx = state.onlineMembers.findIndex(
              (m) => String(m.id) === String(mid),
            );
            const isNew = idx < 0;
            if (idx >= 0) state.onlineMembers[idx] = norm;
            else state.onlineMembers.unshift(norm);
            if (isNew) notifyMemberOnline(norm);
            listUpdated = true;
          } else if (
            action === "leave" ||
            action === "offline" ||
            action === "timeout" ||
            action === "logout"
          ) {
            const before = state.onlineMembers.length;
            state.onlineMembers = state.onlineMembers.filter(
              (m) => String(m.id) !== String(mid),
            );
            if (state.onlineMembers.length !== before) {
              listUpdated = true;
              notifyMemberOffline(mid);
            }
          }
        });
        if (typeof payload.clientAmount === "number") {
          state.onlineCount = payload.clientAmount;
        } else if (listUpdated) {
          state.onlineCount = state.onlineMembers.length;
        }
      } else if (payload.member && payload.action) {
        const mid = payload.member.id;
        const action = payload.action;
        if (
          action === "join" ||
          action === "set" ||
          action === "online" ||
          action === "back"
        ) {
          // join/set 信任现场资料；避免 hereNow 旧 data 盖住
          const norm = normalizeMember(payload.member, { preferLive: true });
          const idx = state.onlineMembers.findIndex(
            (m) => String(m.id) === String(mid),
          );
          const isNew = idx < 0;
          if (action === "set") {
            rememberMemberProfile(norm.id, norm.nickname, norm.avatar);
          }
          if (idx >= 0) {
            state.onlineMembers[idx] = Object.assign(
              {},
              state.onlineMembers[idx],
              norm,
            );
          } else {
            state.onlineMembers.unshift(norm);
          }
          if (isNew && action !== "set") notifyMemberOnline(norm);
          listUpdated = true;
        } else if (
          action === "leave" ||
          action === "offline" ||
          action === "timeout" ||
          action === "logout"
        ) {
          const before = state.onlineMembers.length;
          state.onlineMembers = state.onlineMembers.filter(
            (m) => String(m.id) !== String(mid),
          );
          if (state.onlineMembers.length !== before) {
            listUpdated = true;
            notifyMemberOffline(mid);
          }
        }
        if (typeof payload.amount === "number")
          state.onlineCount = payload.amount;
        else if (listUpdated) state.onlineCount = state.onlineMembers.length;
      }

      // 按 userId 强制去重（统一字符串，避免重复「我」）
      state.onlineMembers = dedupeOnlineMembers(state.onlineMembers);
      state.onlineCount = state.onlineMembers.length;

      // 人数与列表不一致时，标记需要全量刷新
      const needFullRefresh =
        !opts.fromHereNow &&
        (!listUpdated ||
          (typeof state.onlineCount === "number" &&
            state.onlineCount !== state.onlineMembers.length));

      updateOnlineMembersUI();
      // 在线成员昵称/头像可能已变：刷新聊天区显示
      if (listUpdated) {
        try {
          document
            .querySelectorAll(".chat-messages, #publicChatMessages")
            .forEach(function (el) {
              try {
                delete el.dataset.sig;
              } catch (e) {}
            });
          if (Array.isArray(state.servers)) {
            state.servers.forEach(function (s) {
              renderChatMessages(s.id, false);
            });
          }
          renderPublicChat(false);
        } catch (e) {}
      }
      // hereNow 全量列表就绪后检查自己是否与其他在线用户重名
      // （每次全量刷新都检查，避免首次列表不完整时漏检；对方上线走的是非 fromHereNow，不会误伤）
      if (opts.fromHereNow) {
        try {
          state.pendingSelfConflictCheck = false;
          checkUsernameConflictAgainstOnline();
        } catch (e) {}
      }
      return needFullRefresh;
    }

    function dedupeOnlineMembers(list) {
      const src = Array.isArray(list) ? list : [];
      const map = new Map();
      const myId = String(state.userId || getStoredUserId() || "");
      src.forEach(function (m) {
        if (!m) return;
        const id = String(m.id || m.userId || "").trim();
        if (!id || id === "unknown") return;
        const norm = normalizeMember(m);
        norm.id = id;
        // 自己始终用本地最新昵称/头像
        if (id === myId) {
          if (state.username) norm.nickname = state.username;
          if (state.avatar) norm.avatar = state.avatar;
        }
        const prev = map.get(id);
        if (!prev) {
          map.set(id, norm);
        } else {
          // 合并：优先非空昵称/头像
          map.set(id, {
            id: id,
            nickname: norm.nickname || prev.nickname,
            avatar: norm.avatar || prev.avatar,
          });
        }
      });
      // 自己若不在列表中则补上（仅 presence 就绪后）
      if (myId && state.presenceReady && !map.has(myId) && state.username) {
        map.set(myId, {
          id: myId,
          nickname: state.username || "我",
          avatar: state.avatar || "",
        });
      }
      return Array.from(map.values());
    }

    let _hereNowRefreshTimer = null;
    let _hereNowInFlight = false;

    function scheduleHereNowRefresh(delay) {
      if (_hereNowRefreshTimer) clearTimeout(_hereNowRefreshTimer);
      _hereNowRefreshTimer = setTimeout(function () {
        _hereNowRefreshTimer = null;
        queryHereNow();
      }, Math.max(0, Number(delay) || 0));
    }

    function subscribePresence() {
      if (!goEasy || !state.goEasyReady) return;
      try {
        goEasy.pubsub.subscribePresence({
          channel: PRESENCE_CHANNEL,
          membersLimit: 100,
          onPresence: function (presenceEvent) {
            try {
              console.log("[Presence] 事件:", presenceEvent);
              const needRefresh = applyPresencePayload(presenceEvent, {
                fromHereNow: false,
              });
              const act = presenceEvent && presenceEvent.action;
              // 上下线立刻拉全量，确保列表及时同步
              if (needRefresh || act) {
                const delay =
                  act === "leave" ||
                  act === "offline" ||
                  act === "timeout" ||
                  act === "logout"
                    ? 80
                    : 250;
                scheduleHereNowRefresh(delay);
              }
            } catch (e) {
              console.warn("Presence 事件处理异常", e);
              scheduleHereNowRefresh(300);
            }
          },
          onSuccess: function () {
            console.log("[Presence] 订阅成功 channel=", PRESENCE_CHANNEL);
            state.presenceReady = true;
            queryHereNow();
          },
          onFailed: function (error) {
            console.error("[Presence] 订阅失败", error);
            state.presenceReady = false;
            queryHereNow();
            setTimeout(() => {
              if (state.goEasyReady) subscribePresence();
            }, 8000);
          },
        });
      } catch (e) {
        console.error("[Presence] subscribePresence 异常", e);
        queryHereNow();
      }
    }

    function queryHereNow() {
      if (!goEasy || !state.goEasyReady) return;
      if (_hereNowInFlight) {
        scheduleHereNowRefresh(300);
        return;
      }
      _hereNowInFlight = true;
      try {
        goEasy.pubsub.hereNow({
          channel: PRESENCE_CHANNEL,
          limit: 100,
          onSuccess: function (response) {
            _hereNowInFlight = false;
            try {
              console.log("[Presence] hereNow 响应:", response);
              const content =
                response && response.content ? response.content : response;
              if (
                content &&
                content.channels &&
                content.channels[PRESENCE_CHANNEL]
              ) {
                applyPresencePayload(content.channels[PRESENCE_CHANNEL], {
                  fromHereNow: true,
                });
              } else {
                applyPresencePayload(content, { fromHereNow: true });
              }
            } catch (e) {
              console.warn("[Presence] hereNow 解析失败", e, response);
            }
          },
          onFailed: function (error) {
            _hereNowInFlight = false;
            console.warn("[Presence] hereNow 失败", error);
            tryLegacyHereNow();
          },
        });
      } catch (e) {
        _hereNowInFlight = false;
        console.warn("[Presence] hereNow 调用异常", e);
        tryLegacyHereNow();
      }
    }

    function tryLegacyHereNow() {
      if (!goEasy) return;
      try {
        // 兼容极旧 SDK：goEasy.hereNow(opts, callback)
        if (typeof goEasy.hereNow === "function") {
          goEasy.hereNow(
            {
              channels: [PRESENCE_CHANNEL],
              includeUsers: true,
              distinct: true,
            },
            function (response) {
              console.log("[Presence] legacy hereNow:", response);
              try {
                const content =
                  response && response.content ? response.content : response;
                if (
                  content &&
                  content.channels &&
                  content.channels[PRESENCE_CHANNEL]
                ) {
                  applyPresencePayload(content.channels[PRESENCE_CHANNEL]);
                } else if (content && content.channels) {
                  const first = Object.values(content.channels)[0];
                  if (first) applyPresencePayload(first);
                } else {
                  applyPresencePayload(content);
                }
              } catch (err) {
                console.warn("[Presence] legacy 解析失败", err);
              }
            },
          );
        }
      } catch (e) {
        console.warn("[Presence] legacy hereNow 不可用", e);
      }
    }

    function updateOnlineMembersUI() {
      const badge = document.getElementById("onlineCountBadge");
      const titleCount = document.getElementById("onlineMembersTitleCount");
      const list = document.getElementById("onlineMembersList");

      // 渲染前再去重一次，防止异常路径写入重复项
      state.onlineMembers = dedupeOnlineMembers(state.onlineMembers || []);
      const listLen = state.onlineMembers.length;
      const count = listLen;
      state.onlineCount = count;

      const label = count > 99 ? "99+" : String(count);
      if (badge) {
        if (badge.textContent !== label) {
          badge.textContent = label;
        }
        badge.classList.toggle("zero", count === 0);
      }
      if (titleCount) {
        const t = "(" + count + ")";
        if (titleCount.textContent !== t) {
          titleCount.textContent = t;
        }
      }
      if (!list) return;

      if (!listLen) {
        list.innerHTML = '<div class="online-members-empty">暂无在线成员</div>';
        return;
      }

      const myId = String(state.userId || getStoredUserId() || "");
      const html = state.onlineMembers
        .map((m) => {
          // 仅按 userId 判断「我」，避免同名被标成两个「我」
          const isMe = String(m.id) === myId;
          const rawName = isMe
            ? state.username || m.nickname || "我"
            : m.nickname || m.id || "匿名";
          const rawId = isMe
            ? state.userId || getStoredUserId() || m.id || ""
            : "";
          const name = esc(rawName);
          const idStr = esc(rawId);
          const initial = String(rawName || "?")
            .charAt(0)
            .toUpperCase();
          const avatarUrl = isMe
            ? state.avatar || m.avatar || ""
            : m.avatar || "";
          const avatarInner = avatarUrl
            ? `<img src="${esc(avatarUrl)}" alt="" data-full="${esc(avatarUrl)}" draggable="false">`
            : esc(initial);
          const nameClass = isMe
            ? "online-member-name is-me-name"
            : "online-member-name";
          const avClass = isMe
            ? "online-member-avatar is-me"
            : "online-member-avatar";
          // 仅自己显示用户 ID，并可点击编辑
          const idHtml = isMe
            ? `<div class="online-member-id is-me-id" data-action="edit-id" title="点击编辑用户 ID">${idStr}</div>`
            : "";
          return `<div class="online-member-item" data-member-id="${esc(String(m.id || ""))}" data-is-me="${isMe ? "1" : "0"}" title="${isMe ? idStr : esc(String(m.nickname || ""))}">
        <div class="${avClass}" data-action="${isMe ? "edit-avatar" : "view-avatar"}" data-avatar="${esc(avatarUrl)}">${avatarInner}</div>
        <div class="online-member-info">
          <div class="${nameClass}" data-action="${isMe ? "edit-name" : ""}">${name}${isMe ? ' <span style="font-size:10px;background:var(--cyan);color:#062a2b;padding:1px 6px;border-radius:6px;font-weight:700;">我</span>' : ""}</div>
          ${idHtml}
        </div>
        <div class="online-member-dot"></div>
      </div>`;
        })
        .join("");
      list.innerHTML = html;
      syncMissingMemberAvatarsFromBucket();
    }

    // ===== 头像选择与裁剪（头像上传 R2，缩放/平移时图片不可离开裁剪圆外） =====
    const AVATAR_CROP_SIZE = 220;
    const AVATAR_EXPORT_SIZE = 256;

    function pickAndCropAvatar() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", function () {
        const file = input.files && input.files[0];
        try {
          input.remove();
        } catch (e) {}
        if (!file) return;
        if (!String(file.type || "").startsWith("image/")) {
          showToast("⚠️ 请选择图片文件", 1800, false);
          return;
        }
        const reader = new FileReader();
        reader.onload = function () {
          openAvatarCropModal(
            String(reader.result || ""),
            file.name || "avatar.jpg",
          );
        };
        reader.onerror = function () {
          showToast("❌ 读取图片失败", 2000, false);
        };
        reader.readAsDataURL(file);
      });
      input.click();
    }

    function canvasToAvatarBlob(sourceCanvas) {
      return new Promise(function (resolve, reject) {
        try {
          sourceCanvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error("生成头像文件失败"));
          }, "image/png");
        } catch (e) {
          reject(e);
        }
      });
    }

    async function uploadAvatarToStorageBucket(blob, userId) {
      const id = String(userId || "").trim();
      if (!isValidUserId(id)) throw new Error("用户 ID 无效");
      if (!blob) throw new Error("头像文件为空");
      const form = new FormData();
      form.append("user_id", id);
      form.append("avatar", blob, "avatar.png");
      const response = await fetch("/api/avatar/upload", {
        method: "POST",
        body: form,
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.url) {
        throw new Error((data && data.error) || "头像上传存储桶失败");
      }
      delete _avatarBucketLookupMissUntil[id];
      _avatarBucketLookupCache[id] = {
        url: String(data.url),
        expiresAt: Date.now() + 60 * 1000,
      };
      return String(data.url);
    }

    function legacyAvatarDataUrlToBlob(dataUrl) {
      const raw = String(dataUrl || "");
      const match = raw.match(
        /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i,
      );
      if (!match) return null;
      try {
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const mime =
          match[1].toLowerCase() === "image/jpg"
            ? "image/jpeg"
            : match[1].toLowerCase();
        return new Blob([bytes], { type: mime });
      } catch (e) {
        return null;
      }
    }

    async function migrateLegacyAvatarToStorageBucket() {
      const legacy = String(state.avatar || getStoredAvatar() || "");
      if (!legacy.startsWith("data:image")) return false;
      const blob = legacyAvatarDataUrlToBlob(legacy);
      const userId = String(state.userId || getStoredUserId() || "").trim();
      if (!blob || !isValidUserId(userId)) return false;
      try {
        const url = await uploadAvatarToStorageBucket(blob, userId);
        if (!saveAvatar(url)) return false;
        showToast("✅ 旧头像已迁移到存储桶", 2200, true);
        return true;
      } catch (e) {
        console.warn("[R2头像] 旧 base64 头像迁移失败", e);
        return false;
      }
    }

    function openAvatarCropModal(dataUrl, fileName) {
      let modal = document.getElementById("avatarCropModal");
      if (modal) modal.remove();
      modal = document.createElement("div");
      modal.id = "avatarCropModal";
      modal.className = "avatar-crop-modal open";
      modal.innerHTML =
        '<div class="avatar-crop-box">' +
        '<div class="avatar-crop-header"><span>裁剪头像</span><button type="button" class="custom-modal-close" id="avatarCropCloseBtn">✕</button></div>' +
        '<div class="avatar-crop-hint">双指缩放 · 拖动调整 · 图片不可移出裁剪框</div>' +
        '<div class="avatar-crop-stage" id="avatarCropStage">' +
        '<img class="avatar-crop-img" id="avatarCropImg" alt="avatar" draggable="false">' +
        '<div class="avatar-crop-mask"></div>' +
        '<div class="avatar-crop-ring"></div>' +
        "</div>" +
        '<div class="avatar-crop-actions">' +
        '<button type="button" class="avatar-crop-cancel" id="avatarCropCancelBtn">取消</button>' +
        '<button type="button" class="avatar-crop-ok" id="avatarCropOkBtn">完成</button>' +
        "</div>" +
        "</div>";
      document.body.appendChild(modal);

      const stage = modal.querySelector("#avatarCropStage");
      const img = modal.querySelector("#avatarCropImg");
      const st = {
        scale: 1,
        minScale: 1,
        x: 0,
        y: 0,
        pointers: new Map(),
        dragId: null,
        dragStartX: 0,
        dragStartY: 0,
        originX: 0,
        originY: 0,
        pinching: false,
        pinchDist: 0,
        pinchScale: 1,
        naturalW: 0,
        naturalH: 0,
      };

      function cropRadius() {
        const side = Math.min(stage.clientWidth, stage.clientHeight);
        return Math.min(AVATAR_CROP_SIZE, side - 24) / 2;
      }

      function applyTransform() {
        img.style.transform =
          "translate(-50%, -50%) translate(" +
          st.x +
          "px," +
          st.y +
          "px) scale(" +
          st.scale +
          ")";
      }

      function clampToCrop() {
        const r = cropRadius();
        const need = Math.max((2 * r) / st.naturalW, (2 * r) / st.naturalH);
        if (st.scale < need) {
          st.scale = need;
          st.minScale = need;
        }
        const dispW = st.naturalW * st.scale;
        const dispH = st.naturalH * st.scale;
        const maxX = Math.max(0, dispW / 2 - r);
        const maxY = Math.max(0, dispH / 2 - r);
        st.x = Math.min(maxX, Math.max(-maxX, st.x));
        st.y = Math.min(maxY, Math.max(-maxY, st.y));
      }

      function fitImage() {
        const r = cropRadius();
        st.minScale = Math.max((2 * r) / st.naturalW, (2 * r) / st.naturalH);
        st.scale = st.minScale;
        st.x = 0;
        st.y = 0;
        img.style.width = st.naturalW + "px";
        img.style.height = st.naturalH + "px";
        applyTransform();
      }

      img.onload = function () {
        st.naturalW = img.naturalWidth || 1;
        st.naturalH = img.naturalHeight || 1;
        fitImage();
      };
      img.src = dataUrl;

      function pair() {
        const arr = [...st.pointers.values()];
        return [arr[0], arr[1]];
      }

      stage.addEventListener("pointerdown", function (e) {
        stage.setPointerCapture(e.pointerId);
        st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (st.pointers.size === 1) {
          st.dragId = e.pointerId;
          st.dragStartX = e.clientX;
          st.dragStartY = e.clientY;
          st.originX = st.x;
          st.originY = st.y;
        } else if (st.pointers.size >= 2) {
          st.pinching = true;
          const p = pair();
          const dx = p[0].x - p[1].x,
            dy = p[0].y - p[1].y;
          st.pinchDist = Math.max(1, Math.hypot(dx, dy));
          st.pinchScale = st.scale;
        }
        e.preventDefault();
      });
      stage.addEventListener("pointermove", function (e) {
        if (!st.pointers.has(e.pointerId)) return;
        st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (st.pinching && st.pointers.size >= 2) {
          const p = pair();
          const dx = p[0].x - p[1].x,
            dy = p[0].y - p[1].y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          st.scale = Math.max(
            st.minScale,
            Math.min(8, (st.pinchScale * dist) / st.pinchDist),
          );
          clampToCrop();
          applyTransform();
          e.preventDefault();
          return;
        }
        if (st.dragId === e.pointerId && !st.pinching) {
          st.x = st.originX + (e.clientX - st.dragStartX);
          st.y = st.originY + (e.clientY - st.dragStartY);
          clampToCrop();
          applyTransform();
          e.preventDefault();
        }
      });
      function endPointer(e) {
        st.pointers.delete(e.pointerId);
        if (st.pointers.size < 2) st.pinching = false;
        if (st.dragId === e.pointerId) st.dragId = null;
        if (st.pointers.size === 1) {
          const only = [...st.pointers.entries()][0];
          st.dragId = only[0];
          st.dragStartX = only[1].x;
          st.dragStartY = only[1].y;
          st.originX = st.x;
          st.originY = st.y;
        }
      }
      stage.addEventListener("pointerup", endPointer);
      stage.addEventListener("pointercancel", endPointer);
      stage.addEventListener(
        "wheel",
        function (e) {
          e.preventDefault();
          const factor = e.deltaY > 0 ? 0.92 : 1.08;
          st.scale = Math.max(st.minScale, Math.min(8, st.scale * factor));
          clampToCrop();
          applyTransform();
        },
        { passive: false },
      );

      function close() {
        if (modal && modal.parentElement)
          modal.parentElement.removeChild(modal);
      }
      modal
        .querySelector("#avatarCropCloseBtn")
        .addEventListener("click", close);
      modal
        .querySelector("#avatarCropCancelBtn")
        .addEventListener("click", close);

      modal
        .querySelector("#avatarCropOkBtn")
        .addEventListener("click", async function () {
          try {
            clampToCrop();
            const r = cropRadius();
            const canvas = document.createElement("canvas");
            canvas.width = AVATAR_EXPORT_SIZE;
            canvas.height = AVATAR_EXPORT_SIZE;
            const ctx = canvas.getContext("2d");
            const srcSize = (2 * r) / st.scale;
            const srcCx = st.naturalW / 2 - st.x / st.scale;
            const srcCy = st.naturalH / 2 - st.y / st.scale;
            const sx = srcCx - srcSize / 2;
            const sy = srcCy - srcSize / 2;
            ctx.beginPath();
            ctx.arc(
              AVATAR_EXPORT_SIZE / 2,
              AVATAR_EXPORT_SIZE / 2,
              AVATAR_EXPORT_SIZE / 2,
              0,
              Math.PI * 2,
            );
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(
              img,
              sx,
              sy,
              srcSize,
              srcSize,
              0,
              0,
              AVATAR_EXPORT_SIZE,
              AVATAR_EXPORT_SIZE,
            );

            // 转为 PNG 上传到 R2 的稳定 userId 对象键；本地与 GoEasy 仅同步公共 URL。
            showToast("⏳ 正在上传头像到存储桶…", 60000, true);
            const avatarBlob = await canvasToAvatarBlob(canvas);
            const userId = String(
              state.userId || getStoredUserId() || "",
            ).trim();
            const avatarUrl = await uploadAvatarToStorageBucket(
              avatarBlob,
              userId,
            );
            if (!saveAvatar(avatarUrl)) throw new Error("保存头像地址失败");
            showToast("✅ 头像已上传并同步", 2000, true);
            close();
          } catch (err) {
            showToast(
              "❌ 头像更新失败：" + (err && err.message ? err.message : err),
              2800,
              false,
            );
          }
        });
    }

    function bindOnlineMembersEvents() {
      const btn = document.getElementById("onlineMembersBtn");
      const modal = document.getElementById("onlineMembersModal");
      const closeBtn = document.getElementById("closeOnlineMembersBtn");
      if (!btn || !modal) return;

      let modalPollTimer = null;
      function startModalPoll() {
        if (modalPollTimer) clearInterval(modalPollTimer);
        // 打开弹窗时仅主动拉取一次，无需 2 秒高频轮询
        modalPollTimer = null;
      }
      function stopModalPoll() {
        if (modalPollTimer) {
          clearInterval(modalPollTimer);
          modalPollTimer = null;
        }
      }

      // 点击自己的名字改用户名；点击头像上传/查看
      const membersList = document.getElementById("onlineMembersList");
      if (membersList && !membersList.dataset.avatarBound) {
        membersList.dataset.avatarBound = "true";
        membersList.addEventListener("click", function (e) {
          const nameEl = e.target.closest('[data-action="edit-name"]');
          if (nameEl) {
            e.preventDefault();
            e.stopPropagation();
            showUsernamePrompt(() => {
              updateOnlineMembersUI();
              updateChatUI();
            });
            return;
          }
          const idEl = e.target.closest('[data-action="edit-id"]');
          if (idEl) {
            e.preventDefault();
            e.stopPropagation();
            showUserIdPrompt(() => {
              updateOnlineMembersUI();
            });
            return;
          }
          const avEl = e.target.closest('[data-action="edit-avatar"]');
          if (avEl) {
            e.preventDefault();
            e.stopPropagation();
            pickAndCropAvatar();
            return;
          }
          const viewEl = e.target.closest('[data-action="view-avatar"]');
          if (viewEl) {
            const url =
              viewEl.dataset.avatar ||
              (viewEl.querySelector("img") && viewEl.querySelector("img").src);
            if (url) openImageLightbox(url);
          }
        });
      }

      function openOnlineMembersModal() {
        modal.classList.add("open");
        if (state.goEasyReady) queryHereNow();
        updateOnlineMembersUI();
        startModalPoll();
      }

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        // 与公共聊天一致：首次无资料时先完成原首次设置窗口，再显示在线成员。
        requireUsernameForChat(openOnlineMembersModal);
      });
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          modal.classList.remove("open");
          stopModalPoll();
        });
      }

      // 页面重新可见时立即刷新在线状态
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && state.goEasyReady) {
          queryHereNow();
        }
      });
    }

    function sendPublicMessage(text, mediaOrFlag) {
      if (!text || !String(text).trim()) return;
      if (!state.username) {
        showToast("⚠️ 请先点击聊天输入框设置用户名", 1800, false);
        return;
      }
      if (!goEasy || !state.goEasyReady) {
        showToast("⚠️ 聊天服务未连接", 2000, false);
        return;
      }
      const media =
        mediaOrFlag && typeof mediaOrFlag === "object" ? mediaOrFlag : null;
      const isVideoFlag = mediaOrFlag === true;
      const mediaType = media
        ? media.mediaType || ""
        : isVideoFlag
          ? "video"
          : "";
      const msgId = generateMsgId();
      const msgObj = {
        id: msgId,
        text: String(text).trim(),
        sender: state.userId,
        senderName: state.username,
        senderId: state.userId,
        senderAvatar:
          state.avatar && String(state.avatar).indexOf("data:") === 0
            ? undefined
            : state.avatar || undefined,
        time: Date.now(),
        isImage: mediaType === "image" || mediaType === "video",
        mediaType: mediaType || undefined,
        url: media && media.url ? media.url : undefined,
        fileName: media && media.fileName ? media.fileName : undefined,
        fileSize: media && media.fileSize != null ? media.fileSize : undefined,
        mimeType: media && media.mimeType ? media.mimeType : undefined,
        isXor: media && media.isXor ? true : undefined,
      };
      const payload = JSON.stringify(msgObj);
      goEasy.pubsub.publish({
        channel: PUBLIC_CHANNEL,
        message: payload,
        qos: 1,
        onSuccess: function () {
          if (!state.publicMessages) state.publicMessages = [];
          const exists = state.publicMessages.some((m) => m.id === msgId);
          if (!exists) {
            state.publicMessages.push(
              Object.assign({ isMine: true }, msgObj, {
                isXor: !!msgObj.isXor,
              }),
            );
            savePublicMessages();
          }
          renderPublicChat(true);
          const pubInput = document.getElementById("publicChatInput");
          if (pubInput) {
            pubInput.value = "";
            pubInput.style.height = "auto";
          }
          setPublicUnread(false);
        },
        onFailed: function (error) {
          showToast("❌ 公共消息发送失败", 2000, false);
          console.error(error);
        },
      });
    }

    // ---- 渲染公共聊天（支持滚动位置恢复） ----
    function renderPublicChat(forceScroll = false) {
      const container = document.getElementById("publicChatMessages");
      if (!container) return;
      const msgs = state.publicMessages || [];

      if (!state.goEasyReady) {
        container.innerHTML =
          '<div style="color:var(--red);text-align:center;padding:20px;">⚠️ 聊天服务未连接</div>';
        return;
      }

      if (msgs.length === 0) {
        container.innerHTML =
          '<div style="color:var(--muted);text-align:center;padding:20px;font-size:14px;">暂无消息</div>';
      } else {
        container.innerHTML = buildChatMessagesHtml(msgs);
      }

      if (forceScroll) {
        container.scrollTop = container.scrollHeight;
        savePublicScroll(container.scrollTop);
      } else {
        const saved = getPublicScroll();
        if (saved !== null) {
          const maxScroll = container.scrollHeight - container.clientHeight;
          container.scrollTop = Math.min(saved, maxScroll);
        } else {
          container.scrollTop = 0;
        }
      }
    }

    function bindPublicChatEvents() {
      const openBtn = document.getElementById("openPublicChatBtn");
      const modal = document.getElementById("publicChatModal");
      const closeBtn = document.getElementById("closePublicChatBtn");
      const sendBtn = document.getElementById("publicChatSendBtn");
      const input = document.getElementById("publicChatInput");
      const plusBtn = document.getElementById("publicChatPlusBtn");
      const plusPanel = document.getElementById("publicChatPlusPanel");
      const voiceBtn = document.getElementById("publicChatVoiceBtn");
      // 输入框自动增高由文件末尾的全局委托单例统一处理，避免每个输入框重复绑定。

      // 绑定滚动事件保存位置
      const pubContainer = document.getElementById("publicChatMessages");
      if (pubContainer && !pubContainer.dataset.scrollBound) {
        pubContainer.addEventListener("scroll", function () {
          savePublicScroll(this.scrollTop);
        });
        pubContainer.dataset.scrollBound = "true";
      }

      if (!openBtn || !modal || !closeBtn || !sendBtn || !input) {
        console.warn("公共聊天 DOM 元素未找到，请检查 index.html");
        return;
      }

      function openPublicChatModal() {
        state.publicModalOpen = true;
        modal.classList.add("open");
        setPublicUnread(false);
        renderPublicChat(false);
        // 用户名编辑已移至「在线成员」列表点击自己的名字
      }

      openBtn.addEventListener("click", function (e) {
        e.preventDefault();
        // 首次无资料时先强制完成与原首次进入完全相同的设置窗口，成功后才打开公共聊天。
        requireUsernameForChat(openPublicChatModal);
      });

      closeBtn.addEventListener("click", function () {
        state.publicModalOpen = false;
        modal.classList.remove("open");
      });

      sendBtn.addEventListener("click", function () {
        if (sendPendingAttachment("public", input, true, null)) return;
        const text = input.value.trim();
        if (text) sendPublicMessage(text, false);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          sendBtn.click();
        }
      });
      bindPlusMenu(plusBtn, plusPanel, {
        image: function () {
          sendMessageWithMedia(null, input, null, true, "image/*");
        },
        video: function () {
          sendMessageWithMedia(null, input, null, true, "video/*");
        },
        file: function () {
          sendMessageWithMedia(null, input, null, true, "*/*");
        },
      });
      if (voiceBtn) {
        voiceBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          startVoiceRecording(voiceBtn, function (file) {
            storeRecordedVoice(file, "public", true);
          });
        });
      }
    }

    function reconnectChat() {
      if (state.goEasyReady) {
        if (Array.isArray(state.servers)) {
          state.servers.forEach((s) => {
            if (s && s.id && !state.chatSubscribed[s.id]) {
              subscribeChannel(s.id);
            }
          });
        }
        if (!state.publicChatReady) {
          subscribePublicChannel();
        }
      } else {
        initGoEasy(0);
      }
    }

    /**
     * 渲染所有服务器卡片及其房间列表
     * 每次调用都会根据当前 state.servers 和 state.rooms 重建 DOM
     * 通过为每个房间设置初始 display 属性，避免闪现，同时保证自动展开后立即显示当前游戏房间
     */
    function renderServers() {
      const list = document.getElementById("serverList");

      // 按 server_id 分组房间
      const roomsByServer = {};
      state.rooms.forEach((r) => {
        (roomsByServer[r.server_id] = roomsByServer[r.server_id] || []).push(r);
      });

      // 更新统计概览
      const onlineCount = state.servers.filter(
        (s) => s.status === "online",
      ).length;
      document.getElementById("ovServers").textContent =
        `${onlineCount}/${state.servers.length}`;
      document.getElementById("ovOnline").textContent = state.servers
        .filter((s) => s.status === "online")
        .reduce((a, s) => a + (s.online || 0), 0);
      document.getElementById("ovIdle").textContent = state.servers
        .filter((s) => s.status === "online")
        .reduce((a, s) => a + (s.idle || 0), 0);
      document.getElementById("ovRooms").textContent = state.rooms.length;

      // 首次加载显示骨架屏
      if (!state.servers.length) {
        if (state.firstLoad) {
          list.innerHTML =
            '<div class="skeleton"></div><div class="skeleton"></div>';
        }
        return;
      }

      // DOM 缓存管理：复用已存在的卡片，避免完全重绘
      const existing = state._domCache;
      if (existing.size === 0)
        list
          .querySelectorAll(".server-group")
          .forEach((el) => existing.set(el.dataset.id, el));
      const currentIds = new Set(state.servers.map((s) => s.id));
      for (const [id, el] of existing)
        if (!currentIds.has(id)) {
          el.remove();
          existing.delete(id);
        }

      const order = [];
      state.servers.forEach((s) => {
        const dot = statusDot(s.status);
        const rooms = roomsByServer[s.id] || [];

        // ★★★ 修复：生成所有房间，但根据当前游戏设置初始显示状态，避免闪现 ★★★
        const isAllOrAllServers =
          state.game === "all" || state.game === "all_servers";
        const newRoomsHtml = rooms.length
          ? `<div class="room-list">${rooms
              .map((r) => {
                // 计算是否应该显示：若当前游戏为 all 或 all_servers，则全部显示；否则只显示匹配的游戏
                const shouldShow =
                  isAllOrAllServers || roomMatchesFilterGame(r, state.game);
                return roomCard(r, shouldShow ? "" : "none");
              })
              .join("")}</div>`
          : "";

        const regionHtml = s.region
          ? `<span class="card-region" title="${esc(s.region)}">${esc(s.region)}</span>`
          : "";
        const typeBadgeHtml = getTypeBadge(s);
        const errText = s.error ? String(s.error) : "";
        let group = existing.get(s.id);
        const address = s.address || `${s.host}:${s.port}`;

        if (group) {
          // ----- 更新已存在的卡片（只更新变化部分） -----
          const dotEl = group.querySelector(".server-status-dot");
          if (dotEl && dotEl.className !== "server-status-dot " + dot)
            dotEl.className = "server-status-dot " + dot;

          let nameEl = group.querySelector(".server-name");
          if (nameEl) {
            nameEl.textContent = s.name;
            nameEl.dataset.copytext = s.name;
            nameEl.classList.remove("short-text");
          } else {
            const info = group.querySelector(".server-info");
            if (info) {
              const newHtml = makeServerNameHtml(s.name, s.name);
              info.insertAdjacentHTML("afterbegin", newHtml);
            }
          }

          let addrEl = group.querySelector(".server-address");
          if (addrEl) {
            addrEl.textContent = address;
            addrEl.dataset.copytext = address;
            addrEl.classList.remove("short-text");
          } else {
            const info = group.querySelector(".server-info");
            if (info) {
              const newHtml = makeServerAddressHtml(address, address);
              info.appendChild(createElementFromHTML(newHtml));
            }
          }

          // 更新地区标签和类型标签
          const infoEl = group.querySelector(".server-info");
          if (infoEl) {
            let tagsEl = infoEl.querySelector(".server-tags");
            const needTags = !!(regionHtml || typeBadgeHtml);
            if (!needTags) {
              if (tagsEl) tagsEl.remove();
              infoEl
                .querySelectorAll(
                  ":scope > .card-region, :scope > .server-type-badge",
                )
                .forEach((el) => el.remove());
            } else {
              if (!tagsEl) {
                tagsEl = document.createElement("div");
                tagsEl.className = "server-tags";
                const addr = infoEl.querySelector(".server-address");
                if (addr && addr.nextSibling)
                  infoEl.insertBefore(tagsEl, addr.nextSibling);
                else if (addr) infoEl.appendChild(tagsEl);
                else infoEl.appendChild(tagsEl);
              }
              infoEl
                .querySelectorAll(
                  ":scope > .card-region, :scope > .server-type-badge",
                )
                .forEach((el) => {
                  tagsEl.appendChild(el);
                });
              let regionEl = tagsEl.querySelector(".card-region");
              if (s.region) {
                if (!regionEl) {
                  regionEl = document.createElement("span");
                  regionEl.className = "card-region";
                  tagsEl.insertBefore(regionEl, tagsEl.firstChild);
                }
                if (regionEl.textContent !== s.region) {
                  regionEl.textContent = s.region;
                  regionEl.title = s.region;
                }
              } else if (regionEl) {
                regionEl.remove();
              }
              let typeEl = tagsEl.querySelector(".server-type-badge");
              const newType = s.is_builtin
                ? "内置"
                : s.is_remote
                  ? "远程"
                  : s.is_manual
                    ? "自定义"
                    : "";
              const newCls = s.is_builtin
                ? "builtin"
                : s.is_remote
                  ? "remote"
                  : s.is_manual
                    ? "manual"
                    : "";
              if (newType) {
                if (!typeEl) {
                  typeEl = document.createElement("span");
                  tagsEl.appendChild(typeEl);
                }
                typeEl.textContent = newType;
                typeEl.className = "server-type-badge " + newCls;
              } else if (typeEl) {
                typeEl.remove();
              }
              if (!tagsEl.childElementCount) tagsEl.remove();
            }
          }

          // 更新统计数字
          const statBs = group.querySelectorAll(".stat-item b");
          if (statBs.length >= 3) {
            statBs[0].textContent = String(s.online || 0);
            statBs[1].textContent = String(s.idle || 0);
            statBs[2].textContent = String(s.room_count || 0);
          }
          const latEl = group.querySelector(".stat-item.latency");
          if (latEl) {
            const nb = latEl.querySelector(".latency-badge");
            const nl = latencyHTML(s);
            if (!nb || nb.outerHTML !== nl)
              latEl.innerHTML = `<span>延迟</span>${nl}`;
          }

          // 展开/收起状态
          const shouldOpen = state.expanded.has(s.id);
          const isOpen = group.classList.contains("open");
          if (shouldOpen !== isOpen) group.classList.toggle("open", shouldOpen);

          // 错误角标
          ensureErrorBadge(group, errText);

          // 更新房间列表（保持聊天区不被移除）
          const body = group.querySelector(".server-body");
          if (body) {
            const bodyInner = body.querySelector(".body-inner");
            if (bodyInner) {
              const chatWrapper = bodyInner.querySelector(".chat-wrapper");
              // 移除旧房间列表，保留聊天区
              bodyInner
                .querySelectorAll(
                  ".server-error, .room-list, .no-rooms-empty, .no-rooms-match, .no-rooms",
                )
                .forEach((el) => {
                  if (!chatWrapper || !chatWrapper.contains(el)) el.remove();
                });

              if (newRoomsHtml) {
                const temp = document.createElement("div");
                temp.innerHTML = newRoomsHtml;
                const roomList = temp.firstElementChild;
                if (chatWrapper) {
                  if (chatWrapper.nextSibling)
                    bodyInner.insertBefore(roomList, chatWrapper.nextSibling);
                  else bodyInner.appendChild(roomList);
                } else {
                  bodyInner.appendChild(roomList);
                }
              }
            }
          }
          // 确保聊天区存在
          if (!group.querySelector(".chat-wrapper")) {
            initChatForCard(s.id, group);
          } else {
            renderChatMessages(s.id, false);
          }

          // 更新未读角标
          ensureUnreadIndicator(group, s.id);
        } else {
          // ----- 创建新卡片 -----
          const isOpen = state.expanded.has(s.id) ? "open" : "";
          const nameHtml = makeServerNameHtml(s.name, s.name);
          const addrHtml = makeServerAddressHtml(address, address);
          const unreadCount = getUnreadCount(s.id);
          const indicatorStyle = unreadCount > 0 ? "inline-block" : "none";
          const indicatorText =
            unreadCount > 99
              ? "99+"
              : unreadCount > 0
                ? String(unreadCount)
                : "";

          const actionsHtml = s.is_manual
            ? `
        <div class="server-actions">
          <button class="action-btn action-edit">编辑</button>
          <button class="action-btn action-delete">删除</button>
        </div>`
            : "";

          const div = document.createElement("div");
          div.className = `server-group ${isOpen}`;
          div.dataset.id = s.id;
          div.innerHTML = `
        ${actionsHtml}
        <div class="server-card-inner">
          <div class="server-head">
            <div class="server-status-dot ${dot}"></div>
            <div class="server-info">
              ${nameHtml}
              ${addrHtml}
              ${buildServerTagsHtml(regionHtml, typeBadgeHtml)}
              <div class="server-detail"></div>
            </div>
            <span class="unread-indicator" data-server-id="${s.id}" style="display: ${indicatorStyle};">${indicatorText}</span>
            <div class="server-stats">
              <div class="stat-item online"><span>在线</span><b>${s.online || 0}</b></div>
              <div class="stat-item idle"><span>空闲</span><b>${s.idle || 0}</b></div>
              <div class="stat-item rooms"><span>房间</span><b>${s.room_count || 0}</b></div>
              <div class="stat-item latency"><span>延迟</span>${latencyHTML(s)}</div>
            </div>
          </div>
          <div class="server-body">
            <div class="body-inner">
              ${newRoomsHtml}
            </div>
          </div>
        </div>
      `;
          ensureErrorBadge(div, errText);

          // 绑定事件：复制服务器名/地址
          const nameEl = div.querySelector(".server-name");
          if (nameEl) {
            nameEl.addEventListener("click", function (e) {
              e.stopPropagation();
              copyServerName(this.dataset.copytext, this);
            });
          }
          const addrEl = div.querySelector(".server-address");
          if (addrEl) {
            addrEl.addEventListener("click", function (e) {
              e.stopPropagation();
              copyServerAddress(this.dataset.copytext, this);
            });
          }

          // 拖拽排序
          initDragAndDrop(div, s);

          // 滑动操作（仅自定义服务器）
          if (s.is_manual) {
            initSwipe(div);
          } else {
            const actions = div.querySelector(".server-actions");
            if (actions) actions.style.display = "none";
          }

          // 初始化聊天
          initChatForCard(s.id, div);
          ensureUnreadIndicator(div, s.id);

          existing.set(s.id, div);
        }
        order.push(existing.get(s.id));
      });

      // 更新 DOM 顺序
      if (state.firstLoad || list.children.length === 0) {
        list.innerHTML = "";
        const frag = document.createDocumentFragment();
        order.forEach((el) => frag.appendChild(el));
        list.appendChild(frag);
        state.firstLoad = false;
        saveCurrentOrder();
      } else {
        const cur = [...list.children];
        let changed = cur.length !== order.length;
        if (!changed)
          for (let i = 0; i < cur.length; i++)
            if (cur[i] !== order[i]) {
              changed = true;
              break;
            }
        if (changed) {
          const frag = document.createDocumentFragment();
          order.forEach((el) => frag.appendChild(el));
          list.appendChild(frag);
        }
      }
    }

    // ===== 全局事件：复制游戏 ID =====
    document.addEventListener("click", function (e) {
      const target = e.target.closest(".game-name.copy-game-id");
      if (target && target.dataset.isunknown === "true") {
        e.stopPropagation();
        const contentId = target.dataset.contentid;
        if (contentId && contentId !== UNKNOWN_ID) {
          copyWithMessage(contentId, "✅ 已复制游戏 ID: " + contentId);
        }
      }
    });

    // ===== 点击游戏图标放大查看（复用聊天图片预览） =====
    document.addEventListener("click", function (e) {
      const icon = e.target.closest(".room-icon");
      if (!icon) return;
      if (icon.tagName.toLowerCase() !== "img") return;
      const rawSrc =
        icon.dataset.full || icon.getAttribute("src") || icon.src || "";
      if (
        !rawSrc ||
        rawSrc === QUESTION_ICON_DATA ||
        rawSrc.indexOf("data:image") === 0
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      let hiRes = rawSrc;
      try {
        if (hiRes.indexOf("/icon/128/128") !== -1)
          hiRes = hiRes.replace("/icon/128/128", "/icon/256/256");
        else if (hiRes.indexOf("/icon/128") !== -1)
          hiRes = hiRes.replace("/icon/128", "/icon/256");
      } catch (_) {}
      if (typeof openImageLightbox === "function") {
        openImageLightbox(hiRes);
        // 若高分辨率图不存在，回退到原图
        setTimeout(function () {
          try {
            const s = document.querySelector(
              "#chatImageLightbox .chat-lightbox-img",
            );
            if (s && s.getAttribute("src") === hiRes) {
              s.onerror = function () {
                this.onerror = null;
                this.src = rawSrc;
              };
              // 触发一次错误检测：用 Image 预检
              const probar = new Image();
              probar.onerror = function () {
                try {
                  s.src = rawSrc;
                } catch (e) {}
              };
              probar.src = hiRes;
            }
          } catch (e2) {}
        }, 180);
      }
    });

    // ---- 聊天链接点击：智能识别文件/网站 ----
    // - 文件(含 chat-media-download):统一检测公网/局域网后选择浏览器或内置下载器
    // - 网站:弹窗让用户选「系统 WebView」或「外部浏览器」
    // - 外部浏览器走 Java 原生 Intent(绕开 WebView intent:// 包装 bug,避免 ERR_UNKNOWN_URL_SCHEME)
    document.addEventListener("click", async function (e) {
      const link = e.target.closest(".chat-link");
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const url = link.dataset.url;
      if (!url) return;
      // 优先以 data-type 为准,缺失时即时判定
      const declared = link.dataset.type;
      const cls = declared ? { type: declared } : _classifyLink(url);
      if (cls.type === "file") {
        // 抓文件名:有聊天文件卡片则用卡片名,否则用 URL 末段
        const fromCard = link.closest(".chat-media-file");
        const fileName =
          (fromCard &&
            (
              fromCard.dataset.fileName ||
              (fromCard.querySelector(".chat-media-file-name") || {})
                .textContent ||
              ""
            ).trim()) ||
          (() => {
            try {
              const u = new URL(url, window.location.href);
              const last = (u.pathname || "").split("/").pop() || "";
              return last || "文件";
            } catch (_) {
              return "文件";
            }
          })();
        await _builtInDownload(url, fileName, false);
        return;
      }
      // 网站域名:弹选择弹窗
      const choice = await _showLinkOpenChooser(url);
      if (choice === "webview") {
        // 在当前 WebView 中打开(直接跳转)
        try {
          window.location.href = String(url);
        } catch (_) {
          showToast("❌ 打开失败", 2000, false);
        }
      } else if (choice === "external") {
        // 走 Java 原生 Intent 启动外部浏览器
        const ok = _openExternalBrowser(url);
        if (!ok) showToast("❌ 无法启动外部浏览器", 2500, false);
      }
    });

    // ===== 筛选器渲染 =====
    // 房间保活只由后端统一执行 5 次；前端直接使用后端快照，避免重复保活导致
    // 房间实际需要约 9～10 次未命中后才消失。
    // 游戏标题栏跟随后端保活后的房间；房间归零后标签立即消失并回退到「总房间」。

    function normalizeFilterGame(game, room) {
      // 传 room 时走完整解析；只传字符串时做兼容处理
      if (room !== undefined) return resolveRoomGameLabel(room);
      const g = (game == null ? "" : String(game)).trim();
      if (!g) return "未知游戏";
      // 兼容旧数据里的 "未知游戏 (TITLEID)" → 取出 ID
      const m = g.match(/^未知游戏\s*\(([0-9A-Fa-f]{16})\)$/);
      if (m) return m[1].toUpperCase();
      if (/^未知/.test(g)) return "未知游戏";
      return g;
    }

    // 「未映射」= 标签本身就是一个纯标题 ID
    function isUnmappedFilterGame(gameKey) {
      return TITLE_ID_RE.test(String(gameKey || "").toUpperCase());
    }

    function isUnknownFilterGame(game) {
      return normalizeFilterGame(game) === "未知游戏";
    }

    // 从保活后的房间列表提取游戏标签
    // 有映射 → 游戏名；无映射 → 各自的标题 ID（每个 ID 一个独立标签）
    function getActiveFilterGames() {
      const set = new Set();
      (state.rooms || []).forEach((r) => {
        set.add(resolveRoomGameLabel(r));
      });
      const list = [...set];
      // 排序：未知游戏最前 → 已映射游戏名（拼音序）→ 纯标题 ID 垫底
      list.sort((a, b) => {
        if (a === "未知游戏") return -1;
        if (b === "未知游戏") return 1;
        const ai = isUnmappedFilterGame(a) ? 1 : 0;
        const bi = isUnmappedFilterGame(b) ? 1 : 0;
        if (ai !== bi) return ai - bi;
        return String(a).localeCompare(String(b), "zh");
      });
      return list;
    }

    function roomMatchesFilterGame(room, gameKey) {
      if (gameKey === "all" || gameKey === "all_servers") return true;
      return resolveRoomGameLabel(room) === gameKey;
    }

    /**
     * 渲染筛选标签
     * 每个标签显示对应的房间数：全部(服务器数) / 总房间(房间数) / 游戏名(房间数)
     */
    function renderFilters() {
      const games = getActiveFilterGames().slice(0, 10);
      // 固定：全部 / 总房间；游戏标签随保活房间存在而显示
      const tabs = ["all_servers", "all", ...games];
      const container = document.getElementById("filters");
      if (!container) return;
      const existing = container.children;

      while (existing.length < tabs.length) {
        const btn = document.createElement("button");
        btn.className = "filter-tab";
        btn.addEventListener("click", () => {
          container
            .querySelectorAll(".filter-tab")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          state.game = btn.dataset.game;

          let autoExpand = true;
          if (btn.dataset.game === "all") {
            autoExpand = false;
          } else if (btn.dataset.game === "all_servers") {
            autoExpand = true;
          } else {
            autoExpand = true;
          }
          applyFilter(autoExpand);
        });
        container.appendChild(btn);
      }

      while (existing.length > tabs.length) {
        existing[existing.length - 1].remove();
      }

      // 当前选中的游戏已无保活房间 → 回退到「总房间」
      const activeGames = new Set(games);
      if (
        state.game !== "all" &&
        state.game !== "all_servers" &&
        !activeGames.has(state.game)
      ) {
        state.game = "all";
      }

      tabs.forEach((g, i) => {
        const btn = existing[i];
        let label;
        let count = 0;
        if (g === "all") {
          // 总房间：显示保活房间总数
          count = state.rooms.length;
          label = `总房间 (${count})`;
        } else if (g === "all_servers") {
          // 全部：显示服务器总数
          count = state.servers.length;
          label = `全部 (${count})`;
        } else {
          // 游戏标签：显示该游戏的保活房间数
          // 未映射的标题直接以标题 ID 作为标签，每个 ID 一个独立标签
          count = state.rooms.filter(
            (r) => resolveRoomGameLabel(r) === g,
          ).length;
          label = `${g} (${count})`;
        }
        btn.dataset.game = g;
        // textContent 自带转义，无需 esc()
        btn.textContent = label;
        btn.title = isUnmappedFilterGame(g) ? `未收录标题 ID: ${g}` : label;

        const active =
          (g === "all" && state.game === "all") ||
          (g === "all_servers" && state.game === "all_servers") ||
          (g !== "all" && g !== "all_servers" && state.game === g);
        btn.classList.toggle("active", active);
      });
    }

    // 正在该服务器卡片内聊天（输入框聚焦）时，自动展开逻辑不得收起该卡片
    function isServerChatActive(serverId) {
      const group = document.querySelector(
        `.server-group[data-id="${serverId}"]`,
      );
      if (!group) return false;
      const active = document.activeElement;
      if (!active || !group.contains(active)) return false;
      // 输入框、发送按钮、图片按钮等聊天区内的交互都算“正在聊天”
      return !!(
        active.classList.contains("chat-input") ||
        active.classList.contains("chat-send-btn") ||
        active.classList.contains("chat-image-btn") ||
        active.classList.contains("image-upload-btn") ||
        active.closest(".chat-wrapper")
      );
    }

    // ===== 核心渲染 =====
    function render() {
      if (state.autoExpand) {
        // 若正在某个卡片内聊天：只保留该卡片展开，禁止其它卡片被自动展开
        let chattingId = null;
        for (let i = 0; i < state.servers.length; i++) {
          if (isServerChatActive(state.servers[i].id)) {
            chattingId = state.servers[i].id;
            break;
          }
        }

        if (chattingId) {
          state.servers.forEach((s) => {
            if (s.id === chattingId) state.expanded.add(s.id);
            else state.expanded.delete(s.id);
          });
        } else {
          state.servers.forEach((s) => {
            const hasRooms = state.rooms.some((r) => r.server_id === s.id);
            if (hasRooms) state.expanded.add(s.id);
            else state.expanded.delete(s.id);
          });
        }
      }

      if (state.firstExpand) {
        state.game = "all_servers";
        state.firstExpand = false;
      }
      renderFilters();
      renderServers();
      applyFilter(false);
      syncUnreadWithExpanded();
    }

    // ===== 加载数据 =====
    let refreshTimer = null;

    async function load(force, ignoreSaved = false) {
      if (document.hidden && !force) return;
      if (state.loading && !force) return;

      if (!navigator.onLine) {
        state.servers.forEach((s) => {
          s.status = "offline";
          s.latency_ms = null;
          s.error = "网络已断开";
        });
        render();
        if (netDot) {
          netDot.classList.remove("online", "offline");
          netDot.classList.add("offline");
          netDot.title = "网络已断开";
        }
        state.loading = false;
        return;
      }

      state.loading = true;
      const isFirstLoad = state.firstLoad;
      if (isFirstLoad && !ignoreSaved) {
        try {
          const cs = localStorage.getItem("lan_play_cache_servers");
          const cr = localStorage.getItem("lan_play_cache_rooms");
          if (cs && cr) {
            state.servers = JSON.parse(cs);
            state.rooms = JSON.parse(cr);
            loadSavedOrder();
            render();
          }
        } catch (e) {
          /* ignore */
        }
      }

      try {
        const url =
          "/api/snapshot?refresh=" + (force ? "1" : "0") + "&_=" + Date.now();
        const data = await getJSON(url);

        state.servers = Array.isArray(data.servers) ? data.servers : [];
        // 后端已经完成连续 5 次未命中的房间保活；前端必须直接采用该快照。
        // 若前端再次累计 5 次，会形成双重保活，让关闭的房间额外滞留数秒。
        state.rooms = Array.isArray(data.rooms) ? data.rooms : [];

        // 以服务端列表为准：排序缓存里已不存在的 id 直接丢掉，防止已删自定义服务器「阴魂不散」
        try {
          const liveIds = new Set(state.servers.map((s) => s && s.id).filter(Boolean));
          const orderRaw = localStorage.getItem("lan_play_server_order");
          if (orderRaw) {
            const orderArr = JSON.parse(orderRaw);
            if (Array.isArray(orderArr)) {
              const pruned = orderArr.filter((x) => liveIds.has(x));
              localStorage.setItem("lan_play_server_order", JSON.stringify(pruned));
            }
          }
        } catch (e) { /* ignore */ }

        if (ignoreSaved) {
          state._defaultOrder = state.servers.map((s) => ({ id: s.id }));
          saveCurrentOrder();
        } else {
          const loaded = loadSavedOrder();
          if (!loaded && state._defaultOrder === null) {
            state._defaultOrder = state.servers.map((s) => ({ id: s.id }));
          }
        }

        localStorage.setItem(
          "lan_play_cache_servers",
          JSON.stringify(state.servers),
        );
        localStorage.setItem(
          "lan_play_cache_rooms",
          JSON.stringify(state.rooms),
        );

        await new Promise((res) => requestAnimationFrame(res));
        render();

        if (state.goEasyReady && Array.isArray(state.servers)) {
          state.servers.forEach((s) => {
            if (s && s.id && !state.chatSubscribed[s.id]) {
              subscribeChannel(s.id);
            }
          });
        }

      } catch (e) {
        state.servers.forEach((s) => {
          s.status = "offline";
          s.latency_ms = null;
          s.error = "网络连接失败";
        });
        render();
        if (netDot) {
          netDot.classList.remove("online", "checking");
          netDot.classList.add("offline");
          netDot.title = "网络连接失败";
        }
      } finally {
        state.loading = false;
      }
    }

    // ===== 轮询 =====
    function startPolling() {
      if (state.pollInterval) clearInterval(state.pollInterval);
      load(false);
      state.pollInterval = setInterval(() => {
        if (!document.hidden) {
          load(false);
        }
      }, 1000);
    }

    // ===== 可见性变化 =====
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (state.pollInterval) {
          clearInterval(state.pollInterval);
          state.pollInterval = null;
        }
      } else {
        startPolling();
        setTimeout(() => {
          reconnectChat();
        }, 500);
      }
    });

    // ===== 下拉刷新 =====
    let touchStartY = 0;
    document.addEventListener(
      "touchstart",
      (e) => {
        touchStartY = e.changedTouches[0].screenY;
      },
      { passive: true },
    );
    document.addEventListener(
      "touchend",
      (e) => {
        const dy = touchStartY - e.changedTouches[0].screenY;
        if (dy < -80 && window.scrollY <= 0) {
          load(true);
        }
      },
      { passive: true },
    );

    // ===== 窗口resize =====
    window.addEventListener("resize", () => {
      // 不再需要 checkOverflow
    });

    // ===== 启动 =====
    state.firstLoad = true;
    state.firstExpand = true;

    state.userId = getStoredUserId();
    // 优先用该 userId 下保存的资料（换 ID 再换回时头像/用户名一致）
    try {
      const bound = restoreProfileForUserId(state.userId);
      if (bound.username || bound.avatar) {
        applyRestoredProfile(bound);
      } else {
        state.username = getStoredUsername();
        state.avatar = getStoredAvatar();
      }
    } catch (e) {
      state.username = getStoredUsername();
      state.avatar = getStoredAvatar();
    }
    if (!state.username) state.username = getStoredUsername();
    if (!state.avatar) state.avatar = getStoredAvatar();
    rememberKnownUserId(state.userId);
    try {
      snapshotProfileForUserId(state.userId);
    } catch (e) {}
    if (state.userId) {
      // 即使本地已有 URL 也查询一次，确保异地设备修改头像后能更新到最新版本。
      setTimeout(function () {
        syncAvatarFromStorageBucket(state.userId);
      }, 0);
    }
    loadMemberProfiles();
    // 自己的最新资料写入缓存；旧 base64 不再进入成员同步缓存。
    if (state.userId) {
      const cachedAvatarUrl = /^https?:\/\//i.test(String(state.avatar || ""))
        ? state.avatar
        : "";
      rememberMemberProfile(state.userId, state.username, cachedAvatarUrl);
    }
    loadChatMessages();
    loadPublicMessages();
    loadUnreadStatus();
    updateAllMessagesIsMine();
    restorePublicUnread();

    const addHost = document.getElementById("addHost");
    const addPort = document.getElementById("addPort");
    setupHostPortAutoFill(addHost, addPort);

    // ===== 环境变量配置：公开 runtime 仅供 GoEasy；完整密钥走受保护的 /api/env =====
    async function loadEnvConfig() {
      try {
        // 聊天初始化只用最小公开配置，避免未授权访问 /api/env 泄露密钥
        const d = await getJSON("/api/env/runtime?_=" + Date.now());
        if (d && d.ok === true && d.config && typeof d.config === "object") {
          state.goEasyConfig =
            d.config.goeasy && typeof d.config.goeasy === "object"
              ? d.config.goeasy
              : {};
          // 后端在 cloudflare_r2 字段中返回「当前生效提供方」（R2 或腾讯云 COS）
          // 的 max_upload_mb / max_storage_mb，前端上传限制逻辑无需感知提供方。
          state.r2Config =
            d.config.cloudflare_r2 && typeof d.config.cloudflare_r2 === "object"
              ? d.config.cloudflare_r2
              : {};
          state.storageConfig =
            d.config.storage && typeof d.config.storage === "object"
              ? d.config.storage
              : {};
        }
      } catch (e) {
        console.warn("[env配置] 读取运行时配置失败", e);
      }
    }

    // ===== 环境变量安全：公网强制密码 / 局域网始终跳过 =====
    // 安全密码为单一明文（env.json security.password 或 OS SECURITY_PASSWORD）。
    // 局域网/本机：无论是否已设密码，一律跳过门禁；
    // 公网未设：强制设置；公网已设：输入密码后才能查看/修改。
    let _envVerifiedPassword = ""; // 本次会话已通过验证的密码（用于鉴权保存/读取）
    let _envPasswordSource = ""; // "env" | "file" | "" — 当前生效来源

    function _showEnvSecurityModal(title, bodyHtml, submitText, onSubmit) {
      const old = document.getElementById("envSecurityModal");
      if (old) old.remove();
      const modal = document.createElement("div");
      modal.id = "envSecurityModal";
      modal.className = "custom-modal";
      modal.innerHTML =
        '<div class="custom-modal-box" style="width:min(380px,calc(100% - 32px));">' +
        '<div class="custom-modal-header"><span>' +
        esc(title) +
        "</span>" +
        '<button type="button" class="custom-modal-close" aria-label="关闭">✕</button></div>' +
        '<div class="custom-modal-body">' +
        '<div class="form-grid">' +
        bodyHtml +
        '<div id="envSecurityError" style="color:var(--red);font-size:12.5px;line-height:1.5;display:none;text-align:center;"></div>' +
        "</div>" +
        '<button type="button" id="envSecurityOkBtn" class="submit-btn" style="margin-top:14px;">' +
        '<span class="spinner"></span><span class="btn-text">' +
        esc(submitText) +
        "</span></button>" +
        "</div>" +
        "</div>";
      document.body.appendChild(modal);
      requestAnimationFrame(function () {
        modal.classList.add("open");
      });

      function close() {
        if (modal.parentElement) modal.parentElement.removeChild(modal);
        document.removeEventListener("keydown", onKey);
      }
      function setLoading(on) {
        const okBtn = modal.querySelector("#envSecurityOkBtn");
        if (okBtn) {
          okBtn.disabled = on;
          okBtn.classList.toggle("loading", !!on);
        }
      }
      function showErr(msg) {
        const e = modal.querySelector("#envSecurityError");
        if (e) {
          e.textContent = msg || "";
          e.style.display = msg ? "block" : "none";
        }
      }
      function onKey(e) {
        if (e.key === "Escape") close();
      }
      modal
        .querySelector(".custom-modal-close")
        .addEventListener("click", close);
      modal
        .querySelector("#envSecurityOkBtn")
        .addEventListener("click", async function () {
          setLoading(true);
          showErr("");
          try {
            await onSubmit(modal, setLoading, showErr, close);
          } catch (err) {
            showErr(err && err.message ? err.message : String(err));
          } finally {
            setLoading(false);
          }
        });
      document.addEventListener("keydown", onKey);
      setTimeout(function () {
        const first = modal.querySelector("input[type=password]");
        if (first) first.focus();
      }, 80);
      return modal;
    }

    // 强制设置安全密码（公网且未设置）→ 二次确认
    function forceSetPassword(onDone) {
      _showEnvSecurityModal(
        "🔒 设置安全密码",
        '<div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:4px;">当前为公网访问，为防止他人篡改环境变量配置，请先设置一个安全密码（至少 4 位，明文保存；也可事先配置 OS 环境变量 SECURITY_PASSWORD）。</div>' +
          '<div class="form-row"><input type="password" id="envSecPwd" class="env-field" placeholder="设置安全密码" autocomplete="new-password"></div>' +
          '<div class="form-row"><input type="password" id="envSecPwd2" class="env-field" placeholder="再次输入以确认（二次确认）" autocomplete="new-password"></div>',
        "🔐 设置并进入",
        async function (modal, setLoading, showErr, close) {
          const p1 = modal.querySelector("#envSecPwd").value;
          const p2 = modal.querySelector("#envSecPwd2").value;
          if (!p1 || p1.length < 4) {
            showErr("安全密码至少需要 4 位");
            return;
          }
          if (p1 !== p2) {
            showErr("两次输入的密码不一致，请重新确认");
            return;
          }
          const r = await fetch("/api/env/set-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: p1 }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error((d && d.error) || "设置失败");
          _envVerifiedPassword = p1;
          _envPasswordSource = (d && d.password_source) || "file";
          if (_envSecurityCache) {
            _envSecurityCache.password_set = true;
            _envSecurityCache.password_source = _envPasswordSource;
            _envSecurityCache.at = Date.now();
          }
          state.envPasswordSet = true;
          close();
          showToast("✅ 安全密码已设置（明文写入 env.json）", 1800, true);
          onDone && onDone();
        },
      );
    }

    // 输入密码验证后才能修改（已配置密码）
    function requirePasswordToOpen(onDone) {
      _showEnvSecurityModal(
        "🔒 输入安全密码",
        '<div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:4px;">该环境变量配置已受安全密码保护（env.json 明文或 OS 环境变量 SECURITY_PASSWORD），请输入密码后才能修改。</div>' +
          '<div class="form-row"><input type="password" id="envSecPwd" class="env-field" placeholder="安全密码" autocomplete="current-password"></div>',
        "🔓 验证并进入",
        async function (modal, setLoading, showErr, close) {
          const p = modal.querySelector("#envSecPwd").value;
          const r = await fetch("/api/env/verify-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: p }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((d && d.error) || "验证失败");
          if (!d.verified) {
            showErr("密码错误，请重试");
            return;
          }
          _envVerifiedPassword = p;
          close();
          onDone && onDone();
        },
      );
    }

    // 点击 ⚙️ 入口：先做安全检测
    // ★ 修复：安全检测结果在页面加载时预取并缓存 + 后台刷新，
    //   点击图标时直接命中缓存立即打开，不再等待 /api/env/security-status 网络往返。
    let _envSecurityCache = null; // { is_public, password_set, at }
    let _envSecurityFetching = false;
    const ENV_SECURITY_CACHE_TTL = 10000; // 缓存有效期（毫秒），期间点击零延迟
    const ENV_SECURITY_REFRESH_MS = 30000; // 后台定时刷新间隔，保持状态最新

    function _refreshEnvSecurityCache(force) {
      if (_envSecurityFetching) return Promise.resolve(_envSecurityCache);
      if (
        !force &&
        _envSecurityCache &&
        Date.now() - _envSecurityCache.at < ENV_SECURITY_CACHE_TTL
      ) {
        return Promise.resolve(_envSecurityCache);
      }
      _envSecurityFetching = true;
      return getJSON("/api/env/security-status?_=" + Date.now())
        .then(function (st) {
          if (st && st.ok) {
            _envSecurityCache = {
              is_public: !!st.is_public,
              password_set: !!st.password_set,
              password_required: !!st.password_required,
              need_set_password: !!st.need_set_password,
              password_source: st.password_source || "",
              at: Date.now(),
            };
            state.envIsPublic = _envSecurityCache.is_public;
            state.envPasswordSet = _envSecurityCache.password_set;
            _envPasswordSource = _envSecurityCache.password_source || "";
          }
          return _envSecurityCache;
        })
        .catch(function (e) {
          console.warn("[env安全] 安全检测失败，按未设密码处理", e);
          return _envSecurityCache;
        })
        .finally(function () {
          _envSecurityFetching = false;
        });
    }

    function _decideEnvSecurityGate(st, onOpen) {
      st = st || {};
      // 局域网 / localhost：始终跳过安全密码（不论是否已设置）
      if (!st.is_public) {
        onOpen();
        return;
      }
      if (st.password_set || st.password_required) {
        // 公网且已配置密码 → 输入密码才能修改
        requirePasswordToOpen(onOpen);
      } else {
        // 公网且未设密码 → 强制设置安全密码（二次确认）
        forceSetPassword(onOpen);
      }
    }

    function openEnvSettingsWithSecurity(onOpen) {
      const cached = _envSecurityCache;
      if (cached) {
        // 命中缓存：立即打开（零延迟）
        _decideEnvSecurityGate(cached, onOpen);
        // 后台静默刷新，确保下次仍是最新状态
        _refreshEnvSecurityCache(true);
        return;
      }
      // 极少数冷启动点击（页面刚加载、预取尚未返回）：等待一次快速检测后打开
      _refreshEnvSecurityCache(false).then(function (st) {
        _decideEnvSecurityGate(st || {}, onOpen);
      });
    }

    // ===== 环境变量设置模态框 =====
    // 根据所选存储提供方显示/隐藏对应配置区块（R2 / 腾讯云 COS）
    function updateStorageProviderSections() {
      const sel = document.getElementById("envStorageProvider");
      const r2Sec = document.getElementById("envSectionR2");
      const cosSec = document.getElementById("envSectionCos");
      const isCos = !!sel && sel.value === "cos";
      if (r2Sec) r2Sec.style.display = isCos ? "none" : "";
      if (cosSec) cosSec.style.display = isCos ? "" : "none";
    }

    function bindEnvSettingsEvents() {
      const modal = document.getElementById("envSettingsModal");
      const openBtn = document.getElementById("envSettingsBtn");
      const closeBtn = document.getElementById("closeEnvSettingsBtn");
      const saveBtn = document.getElementById("envSettingsSaveBtn");
      if (!modal || !openBtn) return;

      const providerSel = document.getElementById("envStorageProvider");
      if (providerSel)
        providerSel.addEventListener("change", updateStorageProviderSections);
      updateStorageProviderSections();

      // ★ 修复：页面加载时立即预取安全检测结果，并后台定时刷新，
      //   保证用户点击 ⚙️ 时缓存已就绪 → 弹窗即刻显示。
      _refreshEnvSecurityCache(false);
      if (window._envSecurityRefreshTimer)
        clearInterval(window._envSecurityRefreshTimer);
      window._envSecurityRefreshTimer = setInterval(function () {
        if (!document.hidden) _refreshEnvSecurityCache(false);
      }, ENV_SECURITY_REFRESH_MS);

      function open() {
        modal.classList.add("open");
        const pathEl = document.getElementById("envFilePath");
        if (pathEl)
          pathEl.textContent =
            "配置文件：" + (state.envConfigFile || "… 加载中");
        loadEnvIntoForm();
      }
      function close() {
        modal.classList.remove("open");
        _envVerifiedPassword = ""; // 关闭后清空本次密码，下次再要求验证
      }

      openBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openEnvSettingsWithSecurity(open);
      });
      if (closeBtn) closeBtn.addEventListener("click", close);

      async function loadEnvIntoForm() {
        const setVal = (id, val) => {
          const el = document.getElementById(id);
          if (el) el.value = val == null ? "" : String(val);
        };
        try {
          // 完整密钥必须经安全密码；公网未授权返回 403，不再下发任何密钥。
          const headers = { Accept: "application/json" };
          if (_envVerifiedPassword)
            headers["X-Env-Password"] = _envVerifiedPassword;
          const r = await fetch("/api/env?_=" + Date.now(), {
            headers: headers,
            cache: "no-store",
          });
          const d = await r.json().catch(() => ({}));
          if (r.status === 403 && d && d.need_set_password) {
            showToast("🔒 公网访问请先设置安全密码", 2500, false);
            _envVerifiedPassword = "";
            const modal = document.getElementById("envSettingsModal");
            if (modal) modal.classList.remove("open");
            forceSetPassword(function () {
              const m = document.getElementById("envSettingsModal");
              if (m) m.classList.add("open");
              loadEnvIntoForm();
            });
            return;
          }
          if (r.status === 403 || (d && d.need_password)) {
            showToast("🔒 请先输入安全密码后再查看配置", 2500, false);
            _envVerifiedPassword = "";
            const modal = document.getElementById("envSettingsModal");
            if (modal) modal.classList.remove("open");
            requirePasswordToOpen(function () {
              const m = document.getElementById("envSettingsModal");
              if (m) m.classList.add("open");
              loadEnvIntoForm();
            });
            return;
          }
          if (!r.ok || !d || d.ok !== true || !d.config) {
            throw new Error((d && d.error) || "请求失败 (" + r.status + ")");
          }
          if (d.file) {
            state.envConfigFile = d.file;
            const pathEl = document.getElementById("envFilePath");
            if (pathEl) pathEl.textContent = "配置文件：" + d.file;
          }
          const go =
            d.config.goeasy && typeof d.config.goeasy === "object"
              ? d.config.goeasy
              : {};
          setVal("envGoEasyAppkey", go.appkey);
          setVal("envGoEasyHost", go.host);
          const r2 =
            d.config.cloudflare_r2 && typeof d.config.cloudflare_r2 === "object"
              ? d.config.cloudflare_r2
              : {};
          setVal("envR2AccountId", r2.account_id);
          setVal("envR2AccessKey", r2.access_key_id);
          setVal("envR2Bucket", r2.bucket_name);
          setVal("envR2Secret", r2.secret_access_key);
          setVal("envR2PublicUrl", r2.public_url);
          setVal("envR2MaxUploadMb", r2.max_upload_mb);
          setVal("envR2MaxStorageMb", r2.max_storage_mb);
          setVal("envR2CfApiToken", r2.cf_api_token);
          const cos =
            d.config.tencent_cos && typeof d.config.tencent_cos === "object"
              ? d.config.tencent_cos
              : {};
          setVal("envCosSecretId", cos.secret_id);
          setVal("envCosSecretKey", cos.secret_key);
          setVal("envCosBucket", cos.bucket);
          setVal("envCosRegion", cos.region);
          setVal("envCosPublicUrl", cos.public_url);
          setVal("envCosMaxUploadMb", cos.max_upload_mb);
          setVal("envCosMaxStorageMb", cos.max_storage_mb);
          const storage =
            d.config.storage && typeof d.config.storage === "object"
              ? d.config.storage
              : {};
          setVal(
            "envStorageProvider",
            storage.provider === "cos" ? "cos" : "r2",
          );
          updateStorageProviderSections();
          // 安全密码：单一明文字段；source=env 时表示 OS SECURITY_PASSWORD 生效
          const sec =
            d.config.security && typeof d.config.security === "object"
              ? d.config.security
              : {};
          const pwSource =
            (d.password_source || sec.source || _envPasswordSource || "").toString();
          _envPasswordSource = pwSource;
          setVal("envSecurityPassword", sec.password || "");
          const secInput = document.getElementById("envSecurityPassword");
          const secTip = document.getElementById("envSecurityTip");
          const fromOs = pwSource === "env";
          if (secInput) {
            secInput.disabled = !!fromOs;
            secInput.placeholder = fromOs
              ? "当前由 OS 环境变量 SECURITY_PASSWORD 提供（只读）"
              : "至少 4 位；留空表示清除文件中的密码";
          }
          if (secTip) {
            secTip.innerHTML = fromOs
              ? '当前生效来源：<b>OS 环境变量 SECURITY_PASSWORD</b>（优先级最高，表单不可覆盖；修改请改部署环境变量后重启）。'
              : '用于保护环境变量配置页。写入 <code>env.json</code> 的 <code>security.password</code>（明文）。也可通过 OS 环境变量 <code>SECURITY_PASSWORD</code> 注入（优先级更高）。留空并保存可清除文件中的密码。';
          }
          if (d.config.goeasy) state.goEasyConfig = d.config.goeasy;
          if (d.config.cloudflare_r2) state.r2Config = d.config.cloudflare_r2;
          if (d.config.storage) state.storageConfig = d.config.storage;
          if (d.config.security) state.envSecurityConfig = d.config.security;
          state.envPasswordSet = !!(sec.password || d.password_set);
        } catch (e) {
          console.warn("[env配置] 加载失败", e);
          showToast(
            "❌ 加载环境变量失败：" + (e && e.message ? e.message : e),
            2800,
            false,
          );
        }
      }

      async function save() {
        if (!saveBtn || saveBtn.disabled) return;
        saveBtn.disabled = true;
        saveBtn.classList.add("loading");
        const val = (id) => {
          const el = document.getElementById(id);
          return el ? el.value : "";
        };
        const payload = {
          goeasy: {
            appkey: val("envGoEasyAppkey").trim(),
            host: val("envGoEasyHost").trim(),
          },
          storage: {
            provider: val("envStorageProvider") === "cos" ? "cos" : "r2",
          },
          cloudflare_r2: {
            account_id: val("envR2AccountId").trim(),
            access_key_id: val("envR2AccessKey").trim(),
            secret_access_key: val("envR2Secret").trim(),
            bucket_name: val("envR2Bucket").trim(),
            public_url: val("envR2PublicUrl").trim(),
            max_upload_mb: val("envR2MaxUploadMb").trim()
              ? parseInt(val("envR2MaxUploadMb"), 10)
              : "",
            max_storage_mb: val("envR2MaxStorageMb").trim()
              ? parseInt(val("envR2MaxStorageMb"), 10)
              : "",
            cf_api_token: val("envR2CfApiToken").trim(),
          },
          tencent_cos: {
            secret_id: val("envCosSecretId").trim(),
            secret_key: val("envCosSecretKey").trim(),
            bucket: val("envCosBucket").trim(),
            region: val("envCosRegion").trim(),
            public_url: val("envCosPublicUrl").trim(),
            max_upload_mb: val("envCosMaxUploadMb").trim()
              ? parseInt(val("envCosMaxUploadMb"), 10)
              : "",
            max_storage_mb: val("envCosMaxStorageMb").trim()
              ? parseInt(val("envCosMaxStorageMb"), 10)
              : "",
          },
          // 单一明文安全密码（后端会忽略 OS SECURITY_PASSWORD 生效时的写入）
          security: {
            password: val("envSecurityPassword"),
          },
        };
        // body.password 仅用于鉴权，不会写入 security
        if (_envVerifiedPassword) payload.password = _envVerifiedPassword;
        // 前端预检：非 OS 来源时，非空密码至少 4 位
        if (_envPasswordSource !== "env") {
          const sp = (payload.security.password || "").trim();
          if (sp && sp.length < 4) {
            showToast("❌ 安全密码至少需要 4 位（或留空清除）", 2500, false);
            saveBtn.disabled = false;
            saveBtn.classList.remove("loading");
            return;
          }
          payload.security.password = sp;
        }
        try {
          const r = await fetch("/api/env/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error((d && d.error) || "保存失败");
          // 若用户在表单里改了安全密码，会话鉴权密码同步为新值
          if (_envPasswordSource !== "env") {
            const sp = (payload.security && payload.security.password) || "";
            if (sp) {
              _envVerifiedPassword = sp;
              state.envPasswordSet = true;
            } else {
              // 清除文件密码后，若后端也确认未设密码，则会话不再需要鉴权
              _envVerifiedPassword = "";
              state.envPasswordSet = false;
            }
            _envPasswordSource = (d && d.password_source) || (sp ? "file" : "");
            if (_envSecurityCache) {
              _envSecurityCache.password_set = !!state.envPasswordSet;
              _envSecurityCache.password_source = _envPasswordSource;
              _envSecurityCache.at = Date.now();
            }
          }
          if (d.file) state.envConfigFile = d.file;
          const pathEl = document.getElementById("envFilePath");
          if (pathEl) pathEl.textContent = "配置文件：" + d.file;
          // 刷新本地 GoEasy 配置，下次重连/刷新页面生效
          if (
            d.config &&
            d.config.goeasy &&
            typeof d.config.goeasy === "object"
          ) {
            state.goEasyConfig = d.config.goeasy;
          }
          if (
            d.config &&
            d.config.cloudflare_r2 &&
            typeof d.config.cloudflare_r2 === "object"
          ) {
            state.r2Config = d.config.cloudflare_r2;
          }
          if (
            d.config &&
            d.config.storage &&
            typeof d.config.storage === "object"
          ) {
            state.storageConfig = d.config.storage;
          }
          // 保存后按最新 runtime 配置刷新上传限制（含 COS/R2 切换后的 max_upload_mb）
          try {
            loadEnvConfig();
          } catch (e) {}
          showToast("✅ 环境变量配置已保存并应用", 2200, true);
          // 保存成功后自动关闭环境变量配置弹窗；失败时保留弹窗以便修正。
          close();
          // 若因聊天/用户名门禁而打开本页，GoEasy 配好后自动继续设置用户名与连接
          try {
            if (
              typeof isGoEasyConfigured === "function" &&
              isGoEasyConfigured() &&
              typeof _pendingChatAfterEnv === "function"
            ) {
              const pending = _pendingChatAfterEnv;
              _pendingChatAfterEnv = null;
              setTimeout(function () {
                try {
                  pending();
                } catch (e) {
                  console.warn("[env] 继续聊天门禁失败", e);
                }
              }, 200);
            }
          } catch (e) {}
        } catch (e) {
          showToast(
            "❌ 保存失败：" + (e && e.message ? e.message : e),
            3000,
            false,
          );
        } finally {
          saveBtn.disabled = false;
          saveBtn.classList.remove("loading");
        }
      }
      if (saveBtn) saveBtn.addEventListener("click", save);
    }

    loadEnvConfig().finally(async () => {
      // 老版本若仍留有 base64 头像，先迁移到 R2，再连接 GoEasy，避免继续广播大体积头像。
      try {
        await migrateLegacyAvatarToStorageBucket();
      } catch (e) {}
      ensureGoEasySdk(() => {
        if (state.username || getStoredUsername()) initGoEasy();
        else updateChatUI();
      });
    });
    bindEnvSettingsEvents();
    bindPublicChatEvents();
    bindOnlineMembersEvents();
    updateOnlineMembersUI();
    startPolling();

    // ===== 自动展开按钮控制 =====
    const toggleAutoBtn = document.getElementById("toggleAutoExpandBtn");
    if (toggleAutoBtn) {
      toggleAutoBtn.textContent = state.autoExpand ? "📂" : "📁";
      toggleAutoBtn.addEventListener("click", function () {
        const wasOn = state.autoExpand;
        state.autoExpand = !state.autoExpand;
        localStorage.setItem(AUTO_EXPAND_KEY, String(state.autoExpand));
        this.textContent = state.autoExpand ? "📂" : "📁";
        // 关闭自动展开时：清空 expanded 集合并立即收起所有已展开的卡片
        // 避免出现"已关掉自动展开但卡片还都展开着"的残留状态
        if (wasOn && !state.autoExpand) {
          state.expanded.clear();
          state.frozenCardId = null;
        }
        render();
        showToast(
          state.autoExpand
            ? "✅ 自动展开已开启"
            : "⛔ 自动展开已关闭，所有展开的卡片已收起",
          1500,
          true,
        );
      });
    }

    // ===== 手动远程更新前后端（哈希对比+toast） =====
    const updateModal = document.getElementById("updateModal");
    const updateStatus = document.getElementById("updateStatus");
    const manualUpdateBtn = document.getElementById("manualUpdateBtn");
    const updateFrontendBtn = document.getElementById("updateFrontendBtn");
    const updateBackendBtn = document.getElementById("updateBackendBtn");
    const updateAllBtn = document.getElementById("updateAllBtn");
    const closeUpdateModalBtn = document.getElementById("closeUpdateModalBtn");
    function openUpdateModal() {
      if (updateModal) updateModal.classList.add("open");
      checkRemoteUpdate();
    }
    function closeUpdateModal() {
      if (updateModal) updateModal.classList.remove("open");
    }
    if (manualUpdateBtn)
      manualUpdateBtn.addEventListener("click", onManualUpdateIconClick);
    // 长按 ⬆️ 图标 → 打开手动更新模态框（细看哈希 + 选择更新策略）
    // 仅在原地按压（位移 < 10px）且按压时间达到 500ms 时触发，避免与导航栏拖拽手势冲突
    if (manualUpdateBtn) {
      let _upLongPressTimer = null;
      let _upLongPressed = false;
      let _upStartX = 0,
        _upStartY = 0;
      const cancelUpLongPress = () => {
        if (_upLongPressTimer) {
          clearTimeout(_upLongPressTimer);
          _upLongPressTimer = null;
        }
      };
      manualUpdateBtn.addEventListener("pointerdown", (e) => {
        if (e.button != null && e.button !== 0) return;
        _upLongPressed = false;
        _upStartX = e.clientX;
        _upStartY = e.clientY;
        cancelUpLongPress();
        _upLongPressTimer = setTimeout(() => {
          _upLongPressed = true;
          cancelUpLongPress();
          openUpdateModal();
        }, 500);
      });
      manualUpdateBtn.addEventListener(
        "pointermove",
        (e) => {
          if (!_upLongPressTimer) return;
          const dx = e.clientX - _upStartX;
          const dy = e.clientY - _upStartY;
          if (dx * dx + dy * dy > 100) cancelUpLongPress(); // 位移 > 10px 视为拖拽
        },
        { passive: true },
      );
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
        manualUpdateBtn.addEventListener(ev, cancelUpLongPress, {
          passive: true,
        }),
      );
      manualUpdateBtn.addEventListener(
        "click",
        (e) => {
          if (_upLongPressed) {
            e.preventDefault();
            e.stopImmediatePropagation();
            _upLongPressed = false;
          }
        },
        true,
      );
    }
    if (closeUpdateModalBtn)
      closeUpdateModalBtn.addEventListener("click", closeUpdateModal);
    // 导航栏 ⬆️ 图标点击：拉取远程哈希，若有更新则弹确认弹窗让用户选择
    //  - 前端和后端都需更新：一并更新前后端
    //  - 仅有其一需更新：弹窗提示是哪个，确认后直接更新
    //  - 都不需更新：toast 提示已是最新
    async function onManualUpdateIconClick() {
      if (!manualUpdateBtn || manualUpdateBtn.disabled) return;
      manualUpdateBtn.disabled = true;
      showToast("⏳ 正在检查前端和后端是否有更新…", 60000, true);
      try {
        const d = await getJSON("/api/update/check?_=" + Date.now());
        if (!d || d.ok === false) throw new Error((d && d.error) || "检查失败");
        const fe = d.frontend || {};
        const be = d.backend || {};
        const feNeed = !!fe.need_update;
        const beNeed = !!be.need_update;
        if (!feNeed && !beNeed) {
          // 无更新：toast 提示
          showToast("✅ 前后端已是最新", 1800, true);
          return;
        }
        // 有更新：弹"是否更新"的确认弹窗
        // 两端都需更新：一并更新前后端
        // 仅前端需更新：更新前端
        // 仅后端需更新：更新后端
        let target = "frontend";
        if (feNeed && beNeed) {
          target = "all";
        } else if (!feNeed && beNeed) {
          target = "backend";
        }
        const confirmMsg =
          feNeed && beNeed
            ? "前端和后端都有新版本，是否一并更新？\n更新完成后请重启应用"
            : feNeed
              ? "前端有新版本，是否立即更新？\n更新完成后请重启应用"
              : "后端有新版本，是否立即更新？\n更新完成后请重启应用";
        const ok = await _showUpdateConfirm(confirmMsg);
        if (!ok) {
          showToast("已取消更新", 1500, true);
          return;
        }
        const label =
          target === "all" ? "前后端" : target === "frontend" ? "前端" : "后端";
        showToast("⏳ 正在更新" + label + "…", 2000, true);
        await doUpdate(target);
      } catch (e) {
        showToast(
          "❌ 更新检查失败：" + (e && e.message ? e.message : e),
          3000,
          false,
        );
      } finally {
        if (manualUpdateBtn) manualUpdateBtn.disabled = false;
      }
    }

    // 通用确认弹窗：返回 Promise<boolean>，true = 确认，false = 取消
    // 复用 .msg-action-menu 的遮罩 + .custom-modal-box 风格
    function _showUpdateConfirm(message) {
      return new Promise(function (resolve) {
        // 移除旧弹窗
        const old = document.getElementById("updateConfirmModal");
        if (old) old.remove();

        const modal = document.createElement("div");
        modal.id = "updateConfirmModal";
        modal.className = "custom-modal";
        modal.innerHTML =
          '<div class="custom-modal-box" style="width:min(360px,calc(100% - 32px));">' +
          '<div class="custom-modal-header">' +
          "<span>⬆️ 发现新版本</span>" +
          '<button class="custom-modal-close" type="button" aria-label="关闭">✕</button>' +
          "</div>" +
          '<div class="custom-modal-body">' +
          '<p style="margin:0 0 16px;font-size:14px;color:var(--ink);line-height:1.6;white-space:pre-line;">' +
          esc(message) +
          "</p>" +
          '<div style="display:flex;gap:10px;">' +
          '<button id="updateConfirmCancelBtn" type="button" style="flex:1;border:0;border-radius:12px;padding:11px;background:rgba(125,175,210,.15);color:var(--ink);font-weight:700;cursor:pointer;font-size:14px;transition:var(--transition);">取消</button>' +
          '<button id="updateConfirmOkBtn" type="button" style="flex:1;border:0;border-radius:12px;padding:11px;background:var(--cyan);color:#fff;font-weight:800;cursor:pointer;font-size:14px;transition:var(--transition);display:inline-flex;align-items:center;justify-content:center;gap:6px;">立即更新</button>' +
          "</div>" +
          "</div>" +
          "</div>";
        document.body.appendChild(modal);
        requestAnimationFrame(function () {
          modal.classList.add("open");
        });

        function close(result) {
          if (modal.parentElement) modal.parentElement.removeChild(modal);
          document.removeEventListener("keydown", onKey);
          resolve(result);
        }
        function onKey(e) {
          if (e.key === "Escape") close(false);
          else if (e.key === "Enter") close(true);
        }
        modal
          .querySelector(".custom-modal-close")
          .addEventListener("click", function () {
            close(false);
          });
        modal
          .querySelector("#updateConfirmCancelBtn")
          .addEventListener("click", function () {
            close(false);
          });
        modal
          .querySelector("#updateConfirmOkBtn")
          .addEventListener("click", function () {
            close(true);
          });
        document.addEventListener("keydown", onKey);
      });
    }
    async function checkRemoteUpdate() {
      if (!updateStatus) return;
      updateStatus.textContent = "⏳ 正在对比本地与远程哈希…";
      try {
        const d = await getJSON("/api/update/check?_=" + Date.now());
        const fe = d.frontend || {},
          be = d.backend || {};
        const feNeed = !!fe.need_update,
          beNeed = !!be.need_update;
        const rowStyle =
          "display:flex;align-items:center;justify-content:space-between;gap:8px;background:rgba(125,175,210,.08);border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.4;word-break:break-all;";
        const badge = (need) =>
          need
            ? '<span style="flex-shrink:0;background:linear-gradient(135deg,#ff8a3d,#ff5a3d);color:#fff;font-weight:800;font-size:11px;padding:3px 8px;border-radius:999px;">需要更新</span>'
            : '<span style="flex-shrink:0;background:rgba(25,200,174,.15);color:#178a78;font-weight:800;font-size:11px;padding:3px 8px;border-radius:999px;">已是最新</span>';
        const hashLine = (local, remote) =>
          `<span style="font-family:monospace;opacity:.95;">${(local || "—").slice(0, 8)} → ${(remote || "—").slice(0, 8)}</span>`;
        updateStatus.innerHTML = `
        <div style="${rowStyle}"><span style="font-weight:800;">🖼️ 前端</span><span style="display:flex;align-items:center;gap:8px;">${hashLine(fe.local_exists === false ? null : fe.local_hash, fe.remote_hash)}${badge(feNeed)}</span></div>
        <div style="${rowStyle}"><span style="font-weight:800;">⚙️ 后端</span><span style="display:flex;align-items:center;gap:8px;">${hashLine(be.local_hash, be.remote_hash)}${badge(beNeed)}</span></div>
        ${!fe.remote_available || !be.remote_available ? '<div style="color:#d87a00;font-size:12px;text-align:center;">⚠️ 远程不可达，请检查网络</div>' : ""}
      `;
        // 点击更新图片时如果检测到有更新就出现对应 toast
        if (feNeed) showToast("🔔 检测到前端有更新", 2500, true);
        else if (beNeed) showToast("🔔 检测到后端有更新", 2500, true);
        if (!feNeed && !beNeed && fe.remote_available && be.remote_available)
          showToast("✅ 前后端已是最新", 1500, true);
      } catch (e) {
        updateStatus.textContent = "❌ 检查失败: " + e.message;
        showToast("❌ 更新检查失败: " + e.message, 2500, false);
      }
    }
    async function doUpdate(target) {
      const btn =
        target === "frontend"
          ? updateFrontendBtn
          : target === "backend"
            ? updateBackendBtn
            : updateAllBtn;
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.6";
      }
      try {
        if (target === "all") {
          showToast("⏳ 正在更新前后端…", 2000, true);
          const r = await fetch("/api/update/all", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || "更新失败");
          const fe = d.frontend || {},
            be = d.backend || {};
          if (fe.skipped) showToast("ℹ️ 前端已是最新，已跳过更新", 2000, true);
          else if (fe.ok) showToast("✅ 前端更新完成请重启应用", 3000, true);
          else showToast("❌ 前端更新失败: " + (fe.error || ""), 3000, false);
          // 稍延后显示后端 toast，避免被前端 toast 覆盖
          setTimeout(
            () => {
              if (be.skipped)
                showToast("ℹ️ 后端已是最新，已跳过更新", 2000, true);
              else if (be.ok)
                showToast("✅ 后端更新完成请重启应用", 3000, true);
              else
                showToast("❌ 后端更新失败: " + (be.error || ""), 3000, false);
            },
            fe.ok && !fe.skipped ? 1600 : 200,
          );
          await checkRemoteUpdate();
        } else {
          const label = target === "frontend" ? "前端" : "后端";
          showToast("⏳ 正在更新" + label + "…", 2000, true);
          const r = await fetch("/api/update/" + target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || "更新失败");
          if (d.skipped) {
            showToast("ℹ️ " + label + "已是最新，已跳过更新", 2000, true);
          } else {
            showToast("✅ " + label + "更新完成请重启应用", 3000, true);
          }
          await checkRemoteUpdate();
        }
      } catch (e) {
        showToast("❌ 更新失败: " + e.message, 3000, false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.style.opacity = "";
        }
      }
    }
    if (updateFrontendBtn)
      updateFrontendBtn.addEventListener("click", () => doUpdate("frontend"));
    if (updateBackendBtn)
      updateBackendBtn.addEventListener("click", () => doUpdate("backend"));
    if (updateAllBtn)
      updateAllBtn.addEventListener("click", () => doUpdate("all"));

    // ===== 每次启动自动检查一次前后端是否有更新（仅有更新时 toast） =====
    async function checkUpdateOnStartup() {
      try {
        if (!navigator.onLine) return;
        const d = await getJSON("/api/update/check?_=" + Date.now());
        if (!d || d.ok === false) return;
        const fe = d.frontend || {};
        const be = d.backend || {};
        const feNeed = !!fe.need_update;
        const beNeed = !!be.need_update;
        if (feNeed && beNeed) {
          showToast("🔔 检测到前端和后端有更新，点击 ⬆️ 可更新", 3500, true);
        } else if (feNeed) {
          showToast("🔔 检测到前端有更新，点击 ⬆️ 可更新", 3000, true);
        } else if (beNeed) {
          showToast("🔔 检测到后端有更新，点击 ⬆️ 可更新", 3000, true);
        }
      } catch (e) {
        console.warn("[更新] 启动检查失败", e);
      }
    }
    // 延后执行，避开首屏加载与网络检测
    setTimeout(checkUpdateOnStartup, 2500);

    // ===== 卡片点击委托 =====
    document
      .getElementById("serverList")
      .addEventListener("click", function (e) {
        const head = e.target.closest(".server-head");
        if (!head) return;
        const group = head.closest(".server-group");
        if (!group) return;
        const id = group.dataset.id;
        if (!id) return;

        if (group.classList.contains("swipe-open")) {
          if (group._resetSwipe) group._resetSwipe();
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        if (state.expanded.has(id)) {
          state.expanded.delete(id);
          group.classList.remove("open");
          if (state.frozenCardId === id) {
            state.frozenCardId = null;
            renderServers();
          }
          return;
        }

        if (state.unreadStatus[id]) {
          delete state.unreadStatus[id];
          saveUnreadStatus();
          updateUnreadIndicators();
        }

        const allGroups = document.querySelectorAll(".server-group");
        allGroups.forEach((g) => {
          const gid = g.dataset.id;
          if (gid && gid !== id && state.expanded.has(gid)) {
            state.expanded.delete(gid);
            g.classList.remove("open");
          }
        });

        if (state.frozenCardId) {
          state.frozenCardId = null;
        }

        state.expanded.add(id);
        group.classList.add("open");

        state.frozenCardId = null;
        renderServers();
        state.frozenCardId = id;
      });

    function createElementFromHTML(html) {
      const div = document.createElement("div");
      div.innerHTML = html.trim();
      return div.firstChild;
    }

    window.addEventListener("beforeunload", () => {
      if (state.pollInterval) clearInterval(state.pollInterval);
      if (netCheckTimer) clearInterval(netCheckTimer);
      logPollToken += 1;
      if (logAbortController) logAbortController.abort();
      if (logSelectionFlushTimer) clearTimeout(logSelectionFlushTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (goEasyInitTimer) clearTimeout(goEasyInitTimer);
      if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
      if (_hereNowRefreshTimer) clearTimeout(_hereNowRefreshTimer);
      if (window._envSecurityRefreshTimer) {
        clearInterval(window._envSecurityRefreshTimer);
        window._envSecurityRefreshTimer = null;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", __lanPlayInit);
  } else {
    __lanPlayInit();
  }
})();

// 动态创建的服务器聊天框也支持 QQ 式自动换行扩展
if (!window.__chatAutoGrowBound) {
  window.__chatAutoGrowBound = true;
  document.addEventListener("input", function (e) {
    if (!e.target.matches(".chat-input, #publicChatInput")) return;
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  });
}
