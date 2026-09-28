"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildImage, buildUserStroke, buildUserText, type UserTool } from "@/lib/board/compile";
import { hitTest, translateElement } from "@/lib/board/edit";
import { inkPath } from "@/lib/board/freehand";
import type { BoardElement } from "@/lib/board/types";
import { Animator } from "@/lib/client/animator";
import { loadFont, runtime } from "@/lib/client/runtime";
import { prepareUpload } from "@/lib/client/snapshot";
import { boardHeight, contentBottom, useDoodo } from "@/lib/client/store";
import { renderElement } from "@/lib/client/svgRender";
import { BOARD_WIDTH, TEXT_SIZES } from "@/lib/dml/ops";
import { inflate, type Point } from "@/lib/geom";
import type { StrokeFont } from "@/lib/hand/font";
import { ElementPart } from "./ElementView";

type Gesture =
  | { mode: "none" }
  | { mode: "draw"; tool: UserTool; pts: Point[]; pointerId: number }
  | { mode: "pan"; start: { x: number; y: number }; scroll: { x: number; y: number }; pointerId: number }
  | { mode: "move"; ids: string[]; start: Point; dx: number; dy: number; pointerId: number; checkpointed: boolean }
  | { mode: "erase"; pointerId: number; erased: Set<string> };

interface Editor {
  x: number;
  y: number;
  value: string;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export default function Board() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const underRef = useRef<SVGGElement>(null);
  const overRef = useRef<SVGGElement>(null);
  const liveUnderRef = useRef<SVGGElement>(null);
  const liveRef = useRef<SVGGElement>(null);
  const penRef = useRef<SVGGElement>(null);
  const previewPathRef = useRef<SVGPathElement>(null);
  const previewGroupRef = useRef<SVGGElement>(null);
  const selectionRef = useRef<SVGGElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const elements = useDoodo((s) => s.elements);
  const order = useDoodo((s) => s.order);
  const tool = useDoodo((s) => s.tool);
  const color = useDoodo((s) => s.color);
  const width = useDoodo((s) => s.width);
  const selection = useDoodo((s) => s.selection);
  const zoom = useDoodo((s) => s.zoom);
  const lessonActive = useDoodo((s) => s.lessonActive);

  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [font, setFont] = useState<StrokeFont | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [panning, setPanning] = useState(false);

  const scale = (size.w / BOARD_WIDTH) * zoom;
  const boardH = boardHeight(elements);

  // Camera lives in refs so following the pen never re-renders React.
  const cam = useRef({ x: 0, y: 0, targetY: null as number | null, targetX: null as number | null, raf: 0 });
  const metrics = useRef({ scale, vw: size.w, vh: size.h, boardH });
  metrics.current = { scale, vw: size.w, vh: size.h, boardH };
  const gesture = useRef<Gesture>({ mode: "none" });

  const applyCamera = useCallback(() => {
    const m = metrics.current;
    const c = cam.current;
    const viewW = m.vw / m.scale;
    const viewH = m.vh / m.scale;
    c.x = clamp(c.x, Math.min(0, BOARD_WIDTH - viewW), Math.max(0, BOARD_WIDTH - viewW));
    if (viewW >= BOARD_WIDTH) c.x = (BOARD_WIDTH - viewW) / 2;
    c.y = clamp(c.y, -40, Math.max(0, m.boardH - viewH));
    cameraRef.current?.setAttribute("transform", `scale(${m.scale}) translate(${-c.x} ${-c.y})`);
    if (editorRef.current && editorState.current) positionEditor(editorState.current);
  }, []);

  const animateCamera = useCallback(() => {
    const c = cam.current;
    if (c.raf) return;
    const step = () => {
      let moving = false;
      if (c.targetY !== null) {
        const d = c.targetY - c.y;
        if (Math.abs(d) < 0.5) {
          c.y = c.targetY;
          c.targetY = null;
        } else {
          c.y += d * 0.12;
          moving = true;
        }
      }
      if (c.targetX !== null) {
        const d = c.targetX - c.x;
        if (Math.abs(d) < 0.5) {
          c.x = c.targetX;
          c.targetX = null;
        } else {
          c.x += d * 0.12;
          moving = true;
        }
      }
      applyCamera();
      c.raf = moving ? requestAnimationFrame(step) : 0;
    };
    c.raf = requestAnimationFrame(step);
  }, [applyCamera]);

  useLayoutEffect(applyCamera, [scale, boardH, size, applyCamera]);

  // Resize observer.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    loadFont().then(setFont).catch(() => useDoodo.getState().set("error", "Could not load the handwriting font."));
  }, []);

  // Bind the runtime (animator + snapshot access).
  useEffect(() => {
    const live = liveRef.current, liveUnder = liveUnderRef.current, pen = penRef.current;
    const under = underRef.current, over = overRef.current;
    if (!live || !liveUnder || !pen || !under || !over) return;
    const animator = new Animator(liveUnder, live, pen, runtime.clock, {
      onPen(p) {
        // Keep the pen comfortably on screen (above the ask bar).
        const m = metrics.current;
        const c = cam.current;
        const viewH = m.vh / m.scale;
        const viewW = m.vw / m.scale;
        const topSafe = 70 / m.scale;
        const bottomSafe = 190 / m.scale;
        const cy = c.targetY ?? c.y;
        if (p.y > cy + viewH - bottomSafe || p.y < cy + topSafe) {
          c.targetY = clamp(p.y - viewH * 0.42, -40, Math.max(0, m.boardH + 400 - viewH));
          animateCamera();
        }
        if (viewW < BOARD_WIDTH) {
          const cx = c.targetX ?? c.x;
          if (p.x > cx + viewW - 80 / m.scale || p.x < cx + 80 / m.scale) {
            c.targetX = clamp(p.x - viewW / 2, 0, BOARD_WIDTH - viewW);
            animateCamera();
          }
        }
      },
    });
    animator.userSpeed = useDoodo.getState().settings.speed;
    runtime.bindBoard({
      animator,
      contentLayers: [under, over],
      viewport: () => {
        const m = metrics.current;
        return { x: cam.current.x, y: cam.current.y, w: m.vw / m.scale, h: m.vh / m.scale };
      },
      reveal: (y: number) => {
        cam.current.targetY = Math.max(-40, y - 40);
        animateCamera();
      },
    });
    return () => {
      animator.destroy();
      runtime.bindBoard(null);
    };
  }, [animateCamera]);

  // ---------------------------------------------------------------------------
  // Coordinates & helpers

  const toBoard = useCallback((clientX: number, clientY: number): Point => {
    const rect = containerRef.current!.getBoundingClientRect();
    const m = metrics.current;
    return { x: (clientX - rect.left) / m.scale + cam.current.x, y: (clientY - rect.top) / m.scale + cam.current.y };
  }, []);

  const nextSeq = () => {
    const s = useDoodo.getState();
    let m = 0;
    for (const id of s.order) m = Math.max(m, s.elements[id]?.seq ?? 0);
    return m + 1;
  };

  const topmostAt = (p: Point): BoardElement | null => {
    const s = useDoodo.getState();
    const tol = 6 / metrics.current.scale;
    for (let i = s.order.length - 1; i >= 0; i--) {
      const el = s.elements[s.order[i]];
      if (el && hitTest(el, p, tol)) return el;
    }
    return null;
  };

  const textSize = () => (width <= 2 ? TEXT_SIZES.s : width >= 5 ? TEXT_SIZES.l : TEXT_SIZES.m);

  // ---------------------------------------------------------------------------
  // Text editor

  const editorState = useRef<Editor | null>(null);
  editorState.current = editor;

  function positionEditor(ed: Editor) {
    const ta = editorRef.current;
    if (!ta) return;
    const m = metrics.current;
    ta.style.left = `${(ed.x - cam.current.x) * m.scale}px`;
    ta.style.top = `${(ed.y - cam.current.y) * m.scale - 6}px`;
    ta.style.fontSize = `${textSize() * 0.62 * m.scale}px`;
  }

  useLayoutEffect(() => {
    if (editor && editorRef.current) {
      positionEditor(editor);
      editorRef.current.focus();
    }
  });

  const commitEditor = useCallback(() => {
    const ed = editorState.current;
    editorState.current = null; // guard: blur + pointerdown can both commit
    setEditor(null);
    if (!ed || !font || !ed.value.trim()) return;
    const s = useDoodo.getState();
    const el = buildUserText(font, s.allocUserId(), nextSeq(), ed.value, { x: ed.x, y: ed.y }, textSize(), s.color);
    if (el) {
      s.checkpoint();
      s.addElement(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [font, width]);

  // ---------------------------------------------------------------------------
  // Pointer handling

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    if (editor) {
      commitEditor();
      return;
    }
    const p = toBoard(e.clientX, e.clientY);
    const s = useDoodo.getState();
    const pan = e.button === 1 || tool === "hand" || spaceDown.current;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (pan) {
      gesture.current = { mode: "pan", start: { x: e.clientX, y: e.clientY }, scroll: { x: cam.current.x, y: cam.current.y }, pointerId: e.pointerId };
      setPanning(true);
      return;
    }
    switch (tool) {
      case "pen":
      case "highlighter":
      case "rect":
      case "ellipse":
      case "arrow":
        gesture.current = { mode: "draw", tool, pts: [p], pointerId: e.pointerId };
        updatePreview();
        return;
      case "text":
        setEditor({ x: p.x, y: p.y - textSize() * 0.55, value: "" });
        return;
      case "eraser": {
        gesture.current = { mode: "erase", pointerId: e.pointerId, erased: new Set() };
        eraseAt(p);
        return;
      }
      case "select": {
        const hit = topmostAt(p);
        if (!hit) {
          s.set("selection", []);
          gesture.current = { mode: "pan", start: { x: e.clientX, y: e.clientY }, scroll: { x: cam.current.x, y: cam.current.y }, pointerId: e.pointerId };
          return;
        }
        const ids = s.selection.includes(hit.id) ? s.selection : [hit.id];
        s.set("selection", ids);
        gesture.current = { mode: "move", ids, start: p, dx: 0, dy: 0, pointerId: e.pointerId, checkpointed: false };
        return;
      }
    }
  };

  const eraseAt = (p: Point) => {
    const g = gesture.current;
    if (g.mode !== "erase") return;
    const hit = topmostAt(p);
    if (hit && !g.erased.has(hit.id)) {
      if (g.erased.size === 0) useDoodo.getState().checkpoint();
      g.erased.add(hit.id);
      useDoodo.getState().removeElements([hit.id]);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (g.mode === "none") return;
    if (g.mode === "pan") {
      const m = metrics.current;
      cam.current.targetX = cam.current.targetY = null;
      cam.current.x = g.scroll.x - (e.clientX - g.start.x) / m.scale;
      cam.current.y = g.scroll.y - (e.clientY - g.start.y) / m.scale;
      applyCamera();
      return;
    }
    const native = e.nativeEvent;
    const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [native];
    if (g.mode === "draw") {
      for (const ev of events.length ? events : [native]) g.pts.push(toBoard(ev.clientX, ev.clientY));
      updatePreview();
    } else if (g.mode === "erase") {
      for (const ev of events.length ? events : [native]) eraseAt(toBoard(ev.clientX, ev.clientY));
    } else if (g.mode === "move") {
      const p = toBoard(e.clientX, e.clientY);
      g.dx = p.x - g.start.x;
      g.dy = p.y - g.start.y;
      const t = `translate(${g.dx} ${g.dy})`;
      for (const id of g.ids) svgRef.current?.querySelectorAll(`g[data-id="${id}"]`).forEach((n) => n.setAttribute("transform", t));
      selectionRef.current?.setAttribute("transform", t);
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = { mode: "none" };
    setPanning(false);
    const s = useDoodo.getState();
    if (g.mode === "draw") {
      clearPreview();
      const el = buildUserStroke(g.tool, s.allocUserId(), nextSeq(), g.pts, g.tool === "highlighter" ? "#f2c200" : s.color, s.width);
      if (el) {
        s.checkpoint();
        s.addElement(el);
      }
    } else if (g.mode === "move") {
      for (const id of g.ids) svgRef.current?.querySelectorAll(`g[data-id="${id}"]`).forEach((n) => n.removeAttribute("transform"));
      selectionRef.current?.removeAttribute("transform");
      if (Math.abs(g.dx) > 0.5 || Math.abs(g.dy) > 0.5) {
        s.checkpoint();
        for (const id of g.ids) {
          const el = useDoodo.getState().elements[id];
          if (el) useDoodo.getState().replaceElement(translateElement(el, g.dx, g.dy));
        }
      }
    }
  };

  function updatePreview() {
    const g = gesture.current;
    if (g.mode !== "draw") return;
    const path = previewPathRef.current;
    const group = previewGroupRef.current;
    if (!path || !group) return;
    const s = useDoodo.getState();
    if (g.tool === "pen" || g.tool === "highlighter") {
      const hl = g.tool === "highlighter";
      path.setAttribute("d", inkPath(g.pts.map((p) => [p.x, p.y] as [number, number]), hl ? Math.max(14, s.width * 6) : s.width * 1.45 + 0.8, false, false));
      path.setAttribute("fill", hl ? "#f2c200" : s.color);
      path.setAttribute("opacity", hl ? "0.35" : "1");
      group.replaceChildren();
    } else {
      path.setAttribute("d", "");
      const el = buildUserStroke(g.tool, "preview", 0, [g.pts[0], g.pts[g.pts.length - 1]], s.color, s.width);
      group.replaceChildren(...(el ? [renderElement(el)] : []));
    }
  }

  function clearPreview() {
    previewPathRef.current?.setAttribute("d", "");
    previewGroupRef.current?.replaceChildren();
  }

  // Wheel: scroll / ctrl+wheel zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = metrics.current;
      const c = cam.current;
      c.targetX = c.targetY = null;
      if (e.ctrlKey || e.metaKey) {
        const s = useDoodo.getState();
        const before = toBoard(e.clientX, e.clientY);
        const z = clamp(s.zoom * Math.exp(-e.deltaY * 0.0022), 0.4, 3);
        s.set("zoom", z);
        // Keep the point under the cursor fixed.
        const newScale = (m.vw / BOARD_WIDTH) * z;
        const rect = el.getBoundingClientRect();
        c.x = before.x - (e.clientX - rect.left) / newScale;
        c.y = before.y - (e.clientY - rect.top) / newScale;
        metrics.current = { ...m, scale: newScale };
        applyCamera();
      } else {
        const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? m.vh : 1;
        c.y += (e.deltaY * unit) / m.scale;
        c.x += (e.shiftKey ? e.deltaY * unit : e.deltaX * unit) / m.scale;
        applyCamera();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyCamera, toBoard]);

  // ---------------------------------------------------------------------------
  // Images: upload / drop / paste

  const addImageFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    try {
      const { href, w, h } = await prepareUpload(file);
      const s = useDoodo.getState();
      const maxW = 1040, maxH = 780;
      const k = Math.min(maxW / w, maxH / h, 1.6);
      const bw = Math.round(w * k), bh = Math.round(h * k);
      const empty = s.order.length === 0;
      const y = empty ? 60 : contentBottom(s.elements) + 80;
      const el = buildImage(s.allocUserId(), nextSeq(), href, { x: 60, y, w: bw, h: bh }, file.name.slice(0, 80));
      s.checkpoint();
      s.clearAnchors();
      s.addElement(el);
      s.set("tool", "pen");
      cam.current.targetY = Math.max(-40, y - 40);
      animateCamera();
    } catch {
      useDoodo.getState().set("error", "That image could not be opened.");
    }
  }, [animateCamera]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.files;
      if (!items || items.length === 0) return;
      const img = Array.from(items).find((f) => f.type.startsWith("image/"));
      if (img) {
        e.preventDefault();
        void addImageFile(img);
      }
    };
    const onUpload = (e: Event) => {
      const file = (e as CustomEvent<File>).detail;
      if (file) void addImageFile(file);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("doodo:upload", onUpload);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("doodo:upload", onUpload);
    };
  }, [addImageFile]);

  // ---------------------------------------------------------------------------
  // Keyboard

  const spaceDown = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable;
      const s = useDoodo.getState();
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (s.selection.length) {
          s.checkpoint();
          s.removeElements(s.selection);
        }
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        if (s.lessonActive) {
          if (s.paused) runtime.resume();
          else runtime.pause();
        } else spaceDown.current = true;
        return;
      }
      if (e.key === "Escape") {
        s.set("selection", []);
        return;
      }
      const map: Record<string, typeof s.tool> = {
        v: "select", h: "hand", p: "pen", m: "highlighter", t: "text", r: "rect", o: "ellipse", a: "arrow", e: "eraser",
      };
      const t = Object.prototype.hasOwnProperty.call(map, e.key.toLowerCase()) ? map[e.key.toLowerCase()] : undefined;
      if (t) s.set("tool", t);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") spaceDown.current = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ---------------------------------------------------------------------------

  const selBoxes = selection.map((id) => elements[id]?.box).filter(Boolean);

  return (
    <div
      ref={containerRef}
      className="board"
      data-tool={tool}
      data-panning={panning ? "1" : "0"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"));
        if (f) void addImageFile(f);
      }}
      aria-label="Whiteboard"
      aria-busy={lessonActive}
    >
      <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="doodo-dots" width="32" height="32" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.3" fill="#e4ddcc" />
          </pattern>
          <filter id="doodo-board-shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="2" stdDeviation="6" floodColor="#000" floodOpacity="0.06" />
          </filter>
        </defs>
        <g ref={cameraRef}>
          <rect x={0} y={-40} width={BOARD_WIDTH} height={boardH + 440} fill="#fffdf7" filter="url(#doodo-board-shadow)" />
          <rect x={0} y={-40} width={BOARD_WIDTH} height={boardH + 440} fill="url(#doodo-dots)" />
          <g ref={underRef} data-layer="under">
            {order.map((id) => {
              const el = elements[id];
              return el ? <ElementPart key={id} el={el} part="under" /> : null;
            })}
          </g>
          <g ref={liveUnderRef} />
          <g ref={overRef} data-layer="over">
            {order.map((id) => {
              const el = elements[id];
              return el ? <ElementPart key={id} el={el} part="over" /> : null;
            })}
          </g>
          <g ref={liveRef} />
          <g ref={previewGroupRef} opacity={0.85} />
          <path ref={previewPathRef} />
          <g ref={selectionRef} pointerEvents="none">
            {selBoxes.map((b, i) => {
              const r = inflate(b!, 8);
              return (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#1e5bd8" strokeWidth={1.5 / scale} strokeDasharray={`${6 / scale} ${4 / scale}`} rx={6} />
              );
            })}
          </g>
          <g ref={penRef} />
        </g>
      </svg>
      {editor && (
        <textarea
          ref={editorRef}
          className="text-editor"
          value={editor.value}
          rows={Math.max(1, editor.value.split("\n").length)}
          style={{ color, width: Math.max(180, (editor.value.split("\n").reduce((m, l) => Math.max(m, l.length), 0) + 2) * textSize() * 0.36 * scale) }}
          placeholder="Type…"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setEditor({ ...editor, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitEditor();
            } else if (e.key === "Escape") setEditor(null);
          }}
          onBlur={commitEditor}
          aria-label="Text on the board"
        />
      )}
      {dragOver && <div className="drop-hint">Drop the image on the board</div>}
    </div>
  );
}
