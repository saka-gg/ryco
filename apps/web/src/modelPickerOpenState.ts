import { create } from "zustand";

const useModelPickerOpenStore = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set((current) => (current.open === open ? current : { open })),
}));

export function useModelPickerOpen(): boolean {
  return useModelPickerOpenStore((store) => store.open);
}

/** Non-reactive read for event handlers that must not re-render on open/close. */
export function getModelPickerOpen(): boolean {
  return useModelPickerOpenStore.getState().open;
}

export function setModelPickerOpen(open: boolean): void {
  useModelPickerOpenStore.getState().setOpen(open);
}
