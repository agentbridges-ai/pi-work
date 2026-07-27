const KEYBOARD_NAVIGATION_DATASET_KEY = "piworkKeyboardNavigation";

export function installKeyboardNavigationMode(doc: Document = document): () => void {
  const root = doc.documentElement;
  const activate = (event: KeyboardEvent) => {
    if (event.key === "Tab") root.dataset[KEYBOARD_NAVIGATION_DATASET_KEY] = "true";
    if (event.key === "Escape") delete root.dataset[KEYBOARD_NAVIGATION_DATASET_KEY];
  };
  const deactivate = () => {
    delete root.dataset[KEYBOARD_NAVIGATION_DATASET_KEY];
  };

  doc.addEventListener("keydown", activate, true);
  doc.addEventListener("pointerdown", deactivate, true);

  return () => {
    doc.removeEventListener("keydown", activate, true);
    doc.removeEventListener("pointerdown", deactivate, true);
    deactivate();
  };
}
