/**
 * Canonical desktop workbench geometry. CSS consumes the matching
 * `--piwork-*` variables consume this shared geometry.
 */
export interface WorkbenchGeometry {
  composerWidthPx: number;
  composerBottomInsetPx: number;
  composerGapPx: number;
  titlebarHeightPx: number;
  treePanelMinWidthPx: number;
  previewPanelMinWidthPx: number;
  conversationPanelMinWidthPx: number;
  fullWorkbenchBreakpointPx: number;
  compactWorkbenchBreakpointPx: number;
}

export const WORKBENCH_GEOMETRY: Readonly<WorkbenchGeometry> = Object.freeze({
  composerWidthPx: 736,
  composerBottomInsetPx: 144,
  composerGapPx: 24,
  titlebarHeightPx: 40,
  treePanelMinWidthPx: 240,
  previewPanelMinWidthPx: 420,
  conversationPanelMinWidthPx: 400,
  fullWorkbenchBreakpointPx: 1280,
  compactWorkbenchBreakpointPx: 1024,
});
