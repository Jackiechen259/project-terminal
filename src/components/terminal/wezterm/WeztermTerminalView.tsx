import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { useTranslation } from "@/i18n";
import { listenForAppCommands } from "@/lib/appCommands";
import {
  minimumContrastFor,
  resolveColorScheme,
} from "@/lib/terminalColorSchemes";
import { buildTerminalFontStack } from "@/lib/terminalFonts";
import {
  isTerminalRenderMessage,
  type TerminalRenderFrame,
  type TerminalRenderRow,
  type TerminalSearchMatch,
} from "@/lib/terminalFrames";
import {
  terminalService,
  type TerminalKeyEvent,
  type TerminalMouseEvent,
} from "@/services";
import { useColorSchemeStore } from "@/stores/colorSchemeStore";
import {
  clampTerminalFontSize,
  useSettingsStore,
} from "@/stores/settingsStore";
import { resolveTerminalTabTitle } from "../terminalTitle";
import { CanvasRenderer } from "./renderer/CanvasRenderer";
import type {
  TerminalRendererTheme,
  TerminalSelection,
} from "./renderer/TerminalRenderer";

const PASTE_CONFIRMATION_CHARS = 10_000;
const PASTE_CONFIRMATION_LINES = 20;

interface SelectionPoint {
  stableRow: number;
  column: number;
}

type SearchResult = TerminalSearchMatch;

function newClientId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `renderer-${Date.now()}-${Math.random()}`
  );
}

function isModifierKey(key: string) {
  return [
    "Alt",
    "AltGraph",
    "Control",
    "Meta",
    "Shift",
    "CapsLock",
    "NumLock",
  ].includes(key);
}

function selectionFor(
  frame: TerminalRenderFrame,
  renderer: CanvasRenderer,
  event: MouseEvent<HTMLCanvasElement>,
): SelectionPoint | null {
  const point = renderer.rowAtPoint(event.clientX, event.clientY);
  if (!point) return null;
  return {
    stableRow: frame.viewportTop + point.row,
    column: Math.max(0, Math.min(frame.cols, point.column)),
  };
}

function buttonFor(
  event: MouseEvent<HTMLCanvasElement>,
): TerminalMouseEvent["button"] {
  switch (event.button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

/**
 * Canvas renderer attachment for the Rust-owned wezterm-term model.
 *
 * This component owns only the renderer and its input surface. The PTY and
 * terminal model belong to TerminalSession in Rust, so changing visibility or
 * unmounting this component cannot kill a running shell.
 */
export const WeztermTerminalView = memo(function WeztermTerminalView({
  sessionId,
  active,
  focused = active,
  defaultTitle,
  onExit,
  onTitleChange,
  onCwdChange,
  onCommandFinished,
  colorSchemeId,
  onFocus,
}: {
  sessionId: string;
  active: boolean;
  focused?: boolean;
  defaultTitle: string;
  onExit?: (code: number | null, status?: "exited" | "error") => void;
  onTitleChange?: (title: string) => void;
  onCwdChange?: (cwd: string) => void;
  onCommandFinished?: (exitCode: number | null) => void;
  colorSchemeId?: string;
  onFocus?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const frameRef = useRef<TerminalRenderFrame | null>(null);
  const rowsRef = useRef(new Map<number, TerminalRenderRow>());
  const selectionRef = useRef<TerminalSelection | null>(null);
  const draggingRef = useRef(false);
  const compositionRef = useRef(false);
  const searchOpenRef = useRef(false);
  const reportedExitRef = useRef(false);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const onCwdChangeRef = useRef(onCwdChange);
  const onCommandFinishedRef = useRef<
    ((exitCode: number | null) => void) | undefined
  >(undefined);
  const lastResizeRef = useRef<{
    rows: number;
    cols: number;
    width: number;
    height: number;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const searchRequestRef = useRef(0);
  const [, setSelection] = useState<TerminalSelection | null>(null);
  const { t } = useTranslation();

  onExitRef.current = onExit;
  onTitleChangeRef.current = onTitleChange;
  onCwdChangeRef.current = onCwdChange;
  onCommandFinishedRef.current = onCommandFinished;

  const typography = useSettingsStore(
    useShallow((state) => ({
      fontWeight: state.terminalFontWeight,
      fontWeightBold: state.terminalFontWeightBold,
      lineHeight: state.terminalLineHeight,
      letterSpacing: state.terminalLetterSpacing,
      cursorStyle: state.terminalCursorStyle,
      cursorInactiveStyle: state.terminalCursorInactiveStyle,
      cursorBlink: state.cursorBlink,
      padding: state.terminalPadding,
      minimumContrast: state.terminalMinimumContrast,
    })),
  );
  const terminalFontFamily = useSettingsStore(
    (state) => state.terminalFontFamily,
  );
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const terminalColorScheme = useSettingsStore(
    (state) => state.terminalColorScheme,
  );
  const theme = useSettingsStore((state) => state.theme);
  const importedSchemes = useColorSchemeStore((state) => state.schemes);
  const loadColorSchemes = useColorSchemeStore((state) => state.load);

  useEffect(() => {
    void loadColorSchemes();
  }, [loadColorSchemes]);

  const palette = useMemo(
    () =>
      resolveColorScheme(
        colorSchemeId || terminalColorScheme,
        theme,
        importedSchemes,
      ).theme,
    [colorSchemeId, importedSchemes, terminalColorScheme, theme],
  );
  const resolvedContrast =
    typography.minimumContrast || minimumContrastFor(palette);
  const rendererTheme = useMemo<TerminalRendererTheme>(
    () => ({
      ...palette,
      background: palette.background ?? "#000000",
      foreground: palette.foreground ?? "#ffffff",
      minimumContrast: resolvedContrast,
    }),
    [palette, resolvedContrast],
  );
  const font = useMemo(
    () => ({
      family: buildTerminalFontStack(terminalFontFamily),
      size: terminalFontSize,
      weight: typography.fontWeight,
      weightBold: typography.fontWeightBold,
      lineHeight: typography.lineHeight,
      letterSpacing: typography.letterSpacing,
    }),
    [terminalFontFamily, terminalFontSize, typography],
  );
  const updateSelection = useCallback((next: TerminalSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
    rendererRef.current?.setSelection(next);
  }, []);

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
    onFocus?.();
  }, [onFocus]);

  const sendText = useCallback(
    (text: string) => {
      if (!text) return;
      if (inputRef.current) inputRef.current.value = "";
      void terminalService.textInput(sessionId, text).catch(() => {
        // The status channel owns lifecycle errors; input races during close
        // are expected and should not create an unhandled rejection.
      });
    },
    [sessionId],
  );

  const copySelection = useCallback(async () => {
    const current = selectionRef.current;
    const renderer = rendererRef.current;
    if (!current || !renderer) return;
    const text = renderer.selectionText(current.anchor, current.focus);
    if (text) await navigator.clipboard.writeText(text);
    updateSelection(null);
    focusInput();
  }, [focusInput, updateSelection]);

  const pasteText = useCallback(
    async (text: string) => {
      if (!text) return;
      const lineCount = text.split(/\r\n|\r|\n/u).length;
      let bracketed = false;
      try {
        bracketed = await terminalService.bracketedPasteEnabled(sessionId);
      } catch {
        // If the session is closing, the paste will fail harmlessly below.
      }
      const requiresConfirmation =
        text.length >= PASTE_CONFIRMATION_CHARS ||
        (!bracketed && lineCount > PASTE_CONFIRMATION_LINES);
      if (
        requiresConfirmation &&
        !window.confirm(
          t(
            "Paste {characters} characters across {lines} lines into the terminal?",
            {
              characters: text.length,
              lines: lineCount,
            },
          ),
        )
      ) {
        return;
      }
      await terminalService.paste(sessionId, text);
      focusInput();
    },
    [focusInput, sessionId, t],
  );

  const pasteClipboard = useCallback(async () => {
    const text = await terminalService.readClipboardText();
    if (!text) return;
    await pasteText(text);
  }, [pasteText]);

  const refreshSearch = useCallback(
    (query: string) => {
      const request = ++searchRequestRef.current;
      if (!query) {
        setSearchResults([]);
        setSearchIndex(0);
        return;
      }
      void terminalService
        .search(sessionId, {
          query,
          caseSensitive: false,
          direction: "forward",
        })
        .then((results) => {
          if (request !== searchRequestRef.current) return;
          setSearchResults(results);
          setSearchIndex((index) =>
            results.length ? Math.min(index, results.length - 1) : 0,
          );
        })
        .catch(() => {
          if (request !== searchRequestRef.current) return;
          setSearchResults([]);
          setSearchIndex(0);
        });
    },
    [sessionId],
  );

  const moveViewport = useCallback(
    (delta: number) => {
      const frame = frameRef.current;
      if (!frame || frame.alternateScreen) return;
      const minimum = frame.viewportBottom - frame.scrollbackLength;
      const target = Math.max(
        minimum,
        Math.min(frame.viewportBottom, frame.viewportTop + delta),
      );
      if (target !== frame.viewportTop) {
        void terminalService.setViewport(sessionId, target).catch(() => {});
      }
    },
    [sessionId],
  );

  const sendMouse = useCallback(
    (event: TerminalMouseEvent) => {
      void terminalService.mouseEvent(sessionId, event).catch(() => {});
    },
    [sessionId],
  );

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      focusInput();
      const frame = frameRef.current;
      const renderer = rendererRef.current;
      if (!frame || !renderer) return;
      if (event.button === 2 && !frame.mouseReporting) return;
      event.preventDefault();

      const link = renderer.linkAtPoint(event.clientX, event.clientY);
      if (event.ctrlKey && link) {
        void terminalService.openExternalUrl(link).catch(() => {});
        return;
      }

      const point = selectionFor(frame, renderer, event);
      if (!point) return;
      if (frame.mouseReporting) {
        sendMouse({
          kind: "press",
          button: buttonFor(event),
          x: point.column,
          y: point.stableRow - frame.viewportTop,
          shift: event.shiftKey,
          alt: event.altKey,
          ctrl: event.ctrlKey,
        });
        return;
      }

      draggingRef.current = true;
      updateSelection({ anchor: point, focus: point });
    },
    [focusInput, sendMouse, updateSelection],
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      const frame = frameRef.current;
      const renderer = rendererRef.current;
      if (!frame || !renderer) return;
      const point = selectionFor(frame, renderer, event);
      if (!point) return;
      if (frame.mouseReporting) {
        if (event.buttons) {
          sendMouse({
            kind: "move",
            button: "none",
            x: point.column,
            y: point.stableRow - frame.viewportTop,
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey,
          });
        }
        return;
      }
      if (draggingRef.current) {
        updateSelection({
          anchor: selectionRef.current?.anchor ?? point,
          focus: point,
        });
      }
    },
    [sendMouse, updateSelection],
  );

  const handleMouseUp = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      const frame = frameRef.current;
      const renderer = rendererRef.current;
      if (frame && renderer && frame.mouseReporting) {
        const point = selectionFor(frame, renderer, event);
        if (point) {
          sendMouse({
            kind: "release",
            button: buttonFor(event),
            x: point.column,
            y: point.stableRow - frame.viewportTop,
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey,
          });
        }
      }
      draggingRef.current = false;
    },
    [sendMouse],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const { terminalFontSize, updateGeneralSettings } =
          useSettingsStore.getState();
        const next = clampTerminalFontSize(
          terminalFontSize + (event.deltaY < 0 ? 1 : -1),
        );
        if (next !== terminalFontSize)
          updateGeneralSettings({ terminalFontSize: next });
        return;
      }
      const frame = frameRef.current;
      const renderer = rendererRef.current;
      if (!frame || !renderer) return;
      const point = renderer.rowAtPoint(event.clientX, event.clientY);
      if (frame.mouseReporting && point) {
        event.preventDefault();
        sendMouse({
          kind: "press",
          button: event.deltaY < 0 ? "wheel-up" : "wheel-down",
          x: point.column,
          y: point.row,
          shift: event.shiftKey,
          alt: event.altKey,
          ctrl: event.ctrlKey,
        });
        return;
      }
      if (!frame.alternateScreen && frame.scrollbackLength > 0) {
        event.preventDefault();
        const rows = Math.max(1, Math.round(Math.abs(event.deltaY) / 16));
        moveViewport(event.deltaY < 0 ? -rows : rows);
      }
    },
    [moveViewport, sendMouse],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || compositionRef.current) return;
      const { terminalPasteShortcut } = useSettingsStore.getState();
      const pasteChord =
        terminalPasteShortcut === "ctrl-shift-v"
          ? event.ctrlKey && event.shiftKey
          : event.ctrlKey && !event.shiftKey;
      if (pasteChord && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard();
        return;
      }

      const frame = frameRef.current;
      if (
        frame &&
        !frame.alternateScreen &&
        !frame.mouseReporting &&
        (event.key === "PageUp" || event.key === "PageDown")
      ) {
        event.preventDefault();
        moveViewport(event.key === "PageUp" ? -frame.rows : frame.rows);
        return;
      }

      // Printable text is delivered through beforeinput/composition events so
      // AltGr and Windows IME are not reduced to a keydown escape sequence.
      const altGr = event.ctrlKey && event.altKey && event.key.length === 1;
      const numpad =
        event.location === 3 || event.code.toLowerCase().startsWith("numpad");
      const printable =
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !numpad;
      if (
        printable ||
        altGr ||
        isModifierKey(event.key) ||
        event.key === "Process"
      ) {
        return;
      }
      if (event.key === "Unidentified") return;

      event.preventDefault();
      const input: TerminalKeyEvent = {
        key: event.key,
        code: event.code,
        location: event.location,
        numLock: event.getModifierState("NumLock"),
        shift: event.shiftKey,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
      };
      void terminalService.keyDown(sessionId, input).catch(() => {});
    },
    [moveViewport, pasteClipboard, sessionId],
  );

  const handleBeforeInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent as InputEvent;
      if (
        compositionRef.current ||
        native.inputType.startsWith("insertComposition") ||
        native.inputType === "insertFromComposition"
      ) {
        event.preventDefault();
        return;
      }
      if (native.inputType !== "insertText" || !native.data) return;
      event.preventDefault();
      sendText(native.data);
    },
    [sendText],
  );

  const handleInput = useCallback(() => {
    if (compositionRef.current) return;
    const value = inputRef.current?.value ?? "";
    if (value) sendText(value);
  }, [sendText]);

  const handleCompositionStart = useCallback(() => {
    compositionRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      compositionRef.current = false;
      if (event.data) sendText(event.data);
      if (inputRef.current) inputRef.current.value = "";
    },
    [sendText],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData("text");
      if (text) void pasteText(text).catch(() => {});
    },
    [pasteText],
  );

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (frameRef.current?.mouseReporting) return;
      if (selectionRef.current) {
        void copySelection();
      } else {
        void pasteClipboard().catch(() => {});
      }
    },
    [copySelection, pasteClipboard],
  );

  // Renderer resources follow visibility. A hidden terminal keeps its PTY and
  // Rust model alive, but does not retain a Canvas/WebGL context or receive
  // render frames.
  useEffect(() => {
    if (!active) {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new CanvasRenderer();
    renderer.mount(canvas);
    renderer.setTheme(rendererTheme);
    renderer.setFont(font);
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
    // The current theme/font are applied by the effects below without
    // recreating the canvas renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setTheme(rendererTheme);
    renderer.setFont(font);
    renderer.setCursorStyle(
      typography.cursorStyle,
      typography.cursorInactiveStyle,
    );
    renderer.setCursorBlink(typography.cursorBlink);
  }, [
    font,
    rendererTheme,
    typography.cursorBlink,
    typography.cursorInactiveStyle,
    typography.cursorStyle,
  ]);

  useEffect(() => {
    rendererRef.current?.setFocused(focused);
  }, [focused]);

  const resizeSurface = useCallback(() => {
    const surface = surfaceRef.current;
    const renderer = rendererRef.current;
    if (!surface || !renderer || !surface.clientWidth || !surface.clientHeight)
      return;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    const grid = renderer.measureGrid(width, height);
    renderer.resize(width, height, grid.rows, grid.cols);
    const frame = frameRef.current;
    if (frame) renderer.render(frame);
    const previousResize = lastResizeRef.current;
    if (
      previousResize?.rows === grid.rows &&
      previousResize.cols === grid.cols &&
      previousResize.width === width &&
      previousResize.height === height
    ) {
      return;
    }
    lastResizeRef.current = {
      rows: grid.rows,
      cols: grid.cols,
      width,
      height,
    };
    void terminalService
      .resize(sessionId, grid.rows, grid.cols, width, height)
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(resizeSurface);
    observer.observe(surface);
    resizeSurface();
    return () => observer.disconnect();
  }, [active, resizeSurface]);

  useEffect(() => {
    if (!active) return;
    const clientId = newClientId();
    let cancelled = false;

    reportedExitRef.current = false;
    const attachedRows = rowsRef.current;
    attachedRows.clear();
    frameRef.current = null;
    updateSelection(null);
    setSearchResults([]);

    const reportExit = (status: "exited" | "error", code: number | null) => {
      if (reportedExitRef.current) return;
      reportedExitRef.current = true;
      onExitRef.current?.(code, status);
    };

    const onMessage = (message: unknown) => {
      if (cancelled || !isTerminalRenderMessage(message)) return;
      if (message.type === "frame") {
        const frame = message.frame;
        if (frame.fullSnapshot) attachedRows.clear();
        for (const row of frame.dirtyRows) attachedRows.set(row.stableRow, row);
        frameRef.current = frame;
        rendererRef.current?.render(frame);
        return;
      }
      if (message.type === "control") {
        if (message.event.type === "titleChanged") {
          const title = resolveTerminalTabTitle(
            message.event.title,
            defaultTitle,
          );
          if (title) onTitleChangeRef.current?.(title);
        } else if (message.event.type === "cwdChanged" && message.event.cwd) {
          onCwdChangeRef.current?.(message.event.cwd);
        } else if (message.event.type === "commandFinished") {
          onCommandFinishedRef.current?.(message.event.exitCode ?? null);
        }
        return;
      }
      if (
        message.type === "status" &&
        (message.status === "exited" || message.status === "error")
      ) {
        reportExit(message.status, message.exitCode ?? null);
      }
      // A lagged render channel is recovered by the backend by requesting a
      // full snapshot. It is safe to discard the local row cache here because
      // the next frame is explicitly marked fullSnapshot.
      if (message.type === "lagged") {
        attachedRows.clear();
        rendererRef.current?.setSearchMatch(null);
      }
    };

    void terminalService
      .attachRender(sessionId, clientId, onMessage)
      .then((attachment) => {
        if (cancelled) {
          void terminalService.detach(sessionId, clientId);
          return;
        }
        if (
          attachment.session.status === "exited" ||
          attachment.session.status === "error"
        ) {
          reportExit(
            attachment.session.status,
            attachment.session.exitCode ?? null,
          );
        }
        requestAnimationFrame(resizeSurface);
      })
      .catch(() => reportExit("error", null));

    return () => {
      cancelled = true;
      void terminalService.detach(sessionId, clientId);
      attachedRows.clear();
      frameRef.current = null;
      updateSelection(null);
      rendererRef.current?.setSearchMatch(null);
    };
  }, [
    active,
    defaultTitle,
    refreshSearch,
    resizeSurface,
    sessionId,
    updateSelection,
  ]);

  useEffect(() => {
    const stopListening = listenForAppCommands((command) => {
      if (focused && command.type === "copy-terminal") void copySelection();
    });
    return stopListening;
  }, [copySelection, focused]);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
  }, [searchOpen]);

  useEffect(() => {
    setSearchIndex(0);
    refreshSearch(searchQuery);
    if (!searchQuery) rendererRef.current?.setSearchMatch(null);
  }, [refreshSearch, searchQuery]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!focused) return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        focusInput();
      } else if (event.key === "Escape" && searchOpenRef.current) {
        event.preventDefault();
        setSearchOpen(false);
        setSearchQuery("");
        rendererRef.current?.setSearchMatch(null);
        focusInput();
      }
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [focusInput, focused]);

  const currentSearch = searchResults[searchIndex] ?? null;
  useEffect(() => {
    rendererRef.current?.setSearchMatch(currentSearch);
    if (!currentSearch) return;
    const frame = frameRef.current;
    if (
      frame &&
      (currentSearch.stableRow < frame.viewportTop ||
        currentSearch.stableRow >= frame.viewportTop + frame.rows)
    ) {
      const target = Math.max(
        frame.viewportBottom - frame.scrollbackLength,
        Math.min(
          frame.viewportBottom,
          currentSearch.stableRow - Math.floor(frame.rows / 2),
        ),
      );
      void terminalService.setViewport(sessionId, target).catch(() => {});
    }
  }, [currentSearch, sessionId]);

  const moveSearch = useCallback(
    (direction: 1 | -1) => {
      if (!searchResults.length) return;
      setSearchIndex(
        (index) =>
          (index + direction + searchResults.length) % searchResults.length,
      );
    },
    [searchResults.length],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    rendererRef.current?.setSearchMatch(null);
    focusInput();
  }, [focusInput]);

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full"
      style={{
        padding: `${typography.padding}px`,
        background: rendererTheme.background,
        // Read the setting so the renderer and the xterm path keep the same
        // contrast contract while the Canvas implementation is independent.
        color: resolvedContrast > 1 ? rendererTheme.foreground : undefined,
      }}
      onContextMenu={handleContextMenu}
      onFocusCapture={onFocus}
    >
      <div ref={surfaceRef} className="relative h-full w-full overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full"
          aria-label={t("Terminal")}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          onDoubleClick={() => {
            const current = selectionRef.current;
            if (current) void copySelection();
          }}
        />
        <textarea
          ref={inputRef}
          aria-label={t("Terminal input")}
          tabIndex={0}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none border-0 bg-transparent p-0 opacity-0 outline-none"
          onKeyDown={handleKeyDown}
          onBeforeInput={handleBeforeInput}
          onInput={handleInput}
          onPaste={handlePaste}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
      </div>
      {searchOpen && active ? (
        <form
          className="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-md border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
          onSubmit={(event) => {
            event.preventDefault();
            moveSearch(1);
          }}
        >
          <Search className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            aria-label={t("Search terminal")}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
            }}
            className="h-7 w-56 bg-transparent px-1 text-xs outline-none"
            placeholder={t("Search terminal")}
          />
          <span className="min-w-10 px-1 text-center text-[10px] text-muted-foreground">
            {searchResults.length
              ? `${searchIndex + 1}/${searchResults.length}`
              : "0/0"}
          </span>
          <button
            type="button"
            aria-label={t("Previous match")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => moveSearch(-1)}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="submit"
            aria-label={t("Next match")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("Close search")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={closeSearch}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      ) : null}
    </div>
  );
});
