export {
  OfficeContextSwitchBlockedError,
  OfficeHostCompatibilityError,
  OfficePreviewRuntimeManager,
  officePreviewRuntimeManager,
  resolveOfficeActivationBudget,
  type MountOfficePreviewOptions,
  type OfficeEditorMountAdapter,
  type OfficePreviewLease,
  type OfficePreviewRuntimeManagerOptions,
} from "./office-preview-runtime-manager.js";

// Kept during the migration window for integrations that imported the old singleton name.
export { officePreviewRuntimeManager as officeHostAdapter } from "./office-preview-runtime-manager.js";
