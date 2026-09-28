import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = (p: P) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

export const IconSelect = (p: P) => (
  <svg {...base(p)}><path d="M5 3l14 8-6 2-2 6z" /></svg>
);
export const IconHand = (p: P) => (
  <svg {...base(p)}><path d="M8 13V5.5a1.5 1.5 0 013 0V12m0-6.5v-1a1.5 1.5 0 013 0V12m0-5.5a1.5 1.5 0 013 0V13c0 4-2.5 7-6.5 7S5 17.5 4 15l-1.3-2.6a1.5 1.5 0 012.6-1.4L8 14" /></svg>
);
export const IconPen = (p: P) => (
  <svg {...base(p)}><path d="M16.5 3.5l4 4L8 20H4v-4z" /><path d="M14 6l4 4" /></svg>
);
export const IconHighlighter = (p: P) => (
  <svg {...base(p)}><path d="M9 11l-5 5v4h4l5-5" /><path d="M15 5l4 4-6 6-4-4z" /><path d="M13 21h8" /></svg>
);
export const IconText = (p: P) => (
  <svg {...base(p)}><path d="M5 6V4h14v2M12 4v16M9 20h6" /></svg>
);
export const IconRect = (p: P) => (
  <svg {...base(p)}><rect x="4" y="6" width="16" height="12" rx="2" /></svg>
);
export const IconEllipse = (p: P) => (
  <svg {...base(p)}><ellipse cx="12" cy="12" rx="9" ry="7" /></svg>
);
export const IconArrow = (p: P) => (
  <svg {...base(p)}><path d="M5 19L19 5M10 5h9v9" /></svg>
);
export const IconEraser = (p: P) => (
  <svg {...base(p)}><path d="M16 3l5 5-11 11H5l-3-3z" /><path d="M9 20h12" /></svg>
);
export const IconImage = (p: P) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></svg>
);
export const IconUndo = (p: P) => (
  <svg {...base(p)}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></svg>
);
export const IconRedo = (p: P) => (
  <svg {...base(p)}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const IconMic = (p: P) => (
  <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>
);
export const IconSend = (p: P) => (
  <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)}><path d="M9 5v14M15 5v14" /></svg>
);
export const IconPlay = (p: P) => (
  <svg {...base(p)}><path d="M7 4l13 8-13 8z" /></svg>
);
export const IconStop = (p: P) => (
  <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
);
export const IconVolume = (p: P) => (
  <svg {...base(p)}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" /></svg>
);
export const IconMute = (p: P) => (
  <svg {...base(p)}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M17 9l5 6M22 9l-5 6" /></svg>
);
export const IconSpark = (p: P) => (
  <svg {...base(p)}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" /></svg>
);
