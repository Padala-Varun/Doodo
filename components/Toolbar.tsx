"use client";

import { useRef } from "react";
import { useDoodo, type Tool } from "@/lib/client/store";
import { PALETTE } from "@/lib/dml/values";
import {
  IconArrow, IconEllipse, IconEraser, IconHand, IconHighlighter, IconImage, IconPen, IconRect, IconRedo, IconSelect,
  IconText, IconTrash, IconUndo,
} from "./icons";

const TOOLS: { id: Tool; label: string; key: string; Icon: typeof IconPen }[] = [
  { id: "select", label: "Select & move", key: "V", Icon: IconSelect },
  { id: "hand", label: "Pan", key: "H", Icon: IconHand },
  { id: "pen", label: "Pen", key: "P", Icon: IconPen },
  { id: "highlighter", label: "Highlighter", key: "M", Icon: IconHighlighter },
  { id: "text", label: "Text", key: "T", Icon: IconText },
  { id: "rect", label: "Rectangle", key: "R", Icon: IconRect },
  { id: "ellipse", label: "Ellipse", key: "O", Icon: IconEllipse },
  { id: "arrow", label: "Arrow", key: "A", Icon: IconArrow },
  { id: "eraser", label: "Eraser", key: "E", Icon: IconEraser },
];

const COLORS = [PALETTE.black, PALETTE.blue, PALETTE.red, PALETTE.green, PALETTE.orange, PALETTE.purple];
const WIDTHS = [2, 3, 6];

export default function Toolbar() {
  const tool = useDoodo((s) => s.tool);
  const color = useDoodo((s) => s.color);
  const width = useDoodo((s) => s.width);
  const canUndo = useDoodo((s) => s.undoStack.length > 0 && !s.lessonActive);
  const canRedo = useDoodo((s) => s.redoStack.length > 0 && !s.lessonActive);
  const lessonActive = useDoodo((s) => s.lessonActive);
  const hasContent = useDoodo((s) => s.order.length > 0);
  const set = useDoodo((s) => s.set);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <nav className="toolbar" aria-label="Drawing tools" onPointerDown={(e) => e.stopPropagation()}>
      {TOOLS.map(({ id, label, key, Icon }) => (
        <button
          key={id}
          className="tool-btn"
          aria-pressed={tool === id}
          title={`${label} (${key})`}
          aria-label={label}
          onClick={() => set("tool", id)}
        >
          <Icon />
        </button>
      ))}
      <button className="tool-btn" title="Add an image (or paste / drop one)" aria-label="Add image" onClick={() => fileRef.current?.click()}>
        <IconImage />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) window.dispatchEvent(new CustomEvent("doodo:upload", { detail: f }));
          e.target.value = "";
        }}
      />
      <div className="tool-sep" />
      <div className="swatches" role="group" aria-label="Colour">
        {COLORS.map((c) => (
          <button key={c} className="swatch" style={{ background: c }} aria-pressed={color === c} aria-label={`Colour ${c}`} onClick={() => set("color", c)} />
        ))}
      </div>
      <div className="swatches" role="group" aria-label="Thickness">
        {WIDTHS.map((w) => (
          <button
            key={w}
            className="tool-btn"
            style={{ width: 18, height: 22 }}
            aria-pressed={width === w}
            aria-label={`Thickness ${w}`}
            onClick={() => set("width", w)}
          >
            <span style={{ display: "block", width: 12, height: w + 1, borderRadius: 4, background: "currentColor" }} />
          </button>
        ))}
      </div>
      <div className="tool-sep" />
      <button className="tool-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={() => useDoodo.getState().undo()}>
        <IconUndo />
      </button>
      <button className="tool-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo} onClick={() => useDoodo.getState().redo()}>
        <IconRedo />
      </button>
      <button
        className="tool-btn"
        title="Clear the board"
        aria-label="Clear the board"
        disabled={lessonActive || !hasContent}
        onClick={() => {
          if (window.confirm("Clear the whole board? (You can undo this.)")) useDoodo.getState().clearBoard();
        }}
      >
        <IconTrash />
      </button>
    </nav>
  );
}
